import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { pushLineText } from "@/lib/line-push"
import { EXPENSE_ITEM_LABELS, calcStoredSubsidy, type ExpenseItem } from "@/lib/subsidy-rules"
import type { Database } from "@/types/database"

/**
 * 上限超過の承認／却下。
 *
 * POST /api/staff-reimburse/approve-excess
 *   { id: string, approve: boolean, amount?: number }
 *
 * - approve=true  … amount（追加支給額）を承認。amount 未指定なら規程どおりの既定値
 * - approve=false … 承認しない（上限額のまま確定）。approved_excess=0 を記録
 *
 * どちらの場合も hold_reason を解除して確定させ、スタッフへLINEで自動通知する。
 * 確定するまでは税理士提出に含まれないため、放置すると支給が遅れる。
 */

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Supabaseの接続情報が設定されていません")
  return createClient<Database>(url, key)
}

export async function POST(request: NextRequest) {
  const authSupabase = await createAuthClient()
  const {
    data: { user },
    error: authError,
  } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }
  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "承認権限がありません" }, { status: 403 })
  }

  let body: { id?: unknown; approve?: unknown; amount?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 })
  }

  const id = typeof body.id === "string" ? body.id : ""
  if (!id) return NextResponse.json({ error: "対象が指定されていません" }, { status: 400 })
  if (typeof body.approve !== "boolean") {
    return NextResponse.json({ error: "承認／却下の指定が不正です" }, { status: 400 })
  }
  const approve = body.approve

  const approverName =
    (typeof user.user_metadata?.full_name === "string" && user.user_metadata.full_name) ||
    user.email ||
    "担当"

  try {
    const supabase = createServiceClient()

    // 対象の明細を取得（上限超過の保留だけが対象）
    const { data: tx, error: txError } = await supabase
      .from("petty_cash_transactions")
      .select(
        "id, staff_member_id, amount, expense_item, excess_amount, subsidy_category, hold_reason, approved_excess"
      )
      .eq("id", id)
      .eq("category", "staff_refund")
      .single()

    if (txError || !tx) {
      if (txError && /hold_reason|expense_item|column/i.test(txError.message)) {
        return NextResponse.json(
          { error: "承認機能のDB更新（044_phase2_courses_and_caps.sql）がまだ実行されていません。" },
          { status: 409 }
        )
      }
      return NextResponse.json({ error: "対象の明細が見つかりません" }, { status: 404 })
    }

    if (tx.hold_reason !== "excess") {
      return NextResponse.json(
        { error: "この明細は上限超過の承認待ちではありません（すでに確定しているか、別の理由で保留中です）" },
        { status: 409 }
      )
    }

    const excess = tx.excess_amount ?? 0
    const item = (tx.expense_item ?? "other") as ExpenseItem
    // 2回目以降は超過分も半額が規程どおり。弁当代は常に全額
    const rate = item === "bento" ? 1 : tx.subsidy_category === "achievement_repeat" ? 0.5 : 1
    const suggested = Math.floor(excess * rate)

    // 承認額：指定があればそれを使う。上限は超過分の全額まで（それ以上は入力ミスとして弾く）
    let approvedExcess = 0
    if (approve) {
      const requested = typeof body.amount === "number" ? Math.floor(body.amount) : suggested
      if (requested < 0 || requested > excess) {
        return NextResponse.json(
          { error: `追加支給額は 0 〜 ${excess.toLocaleString("ja-JP")} 円の範囲で指定してください` },
          { status: 400 }
        )
      }
      approvedExcess = requested
    }

    const { error: updateError } = await supabase
      .from("petty_cash_transactions")
      .update({
        approved_excess: approvedExcess,
        approved_excess_at: new Date().toISOString(),
        approved_excess_by: approverName,
        // 確定させる（これ以降は税理士提出・支給集計に含まれる）
        hold_reason: null,
      })
      .eq("id", id)

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    // 確定後の支給額
    const finalSubsidy = calcStoredSubsidy({
      amount: tx.amount,
      subsidy_category: tx.subsidy_category,
      expense_item: tx.expense_item,
      excess_amount: tx.excess_amount,
      approved_excess: approvedExcess,
    })

    // スタッフへLINEで通知（担当が個別に連絡しなくてよい状態にする）
    const notified = await notifyStaff(supabase, tx.staff_member_id, {
      itemLabel: EXPENSE_ITEM_LABELS[item] ?? "立替",
      approvedExcess,
      finalSubsidy,
      approve,
    })

    return NextResponse.json({
      ok: true,
      approvedExcess,
      finalSubsidy,
      notified,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "承認処理に失敗しました"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** 結果をスタッフのLINEへ通知する（送れなくても承認自体は成立させる） */
async function notifyStaff(
  supabase: ReturnType<typeof createServiceClient>,
  staffMemberId: string | null,
  p: { itemLabel: string; approvedExcess: number; finalSubsidy: number; approve: boolean }
): Promise<boolean> {
  if (!staffMemberId) return false
  const { data: member } = await supabase
    .from("staff_members")
    .select("line_user_id")
    .eq("id", staffMemberId)
    .single()
  if (!member?.line_user_id) return false

  const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`
  const text =
    p.approve && p.approvedExcess > 0
      ? `${p.itemLabel}の超過分 ${yen(p.approvedExcess)} が承認されました。\n支給額は ${yen(p.finalSubsidy)} になります。`
      : `${p.itemLabel}の支給は上限の ${yen(p.finalSubsidy)} となります。`

  return pushLineText(member.line_user_id, text)
}
