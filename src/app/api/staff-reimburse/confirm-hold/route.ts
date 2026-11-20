import { NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { parseLineProfile } from "@/lib/line-staff-profile"
import type { Database } from "@/types/database"

/**
 * 「既受講回数が未登録」で止まっている明細を、担当が確定させる。
 *
 * ■ なぜ必要か
 * 担当が受講回数を登録していないと、その申請は保留になる（hold_reason="history"）。
 * ところが回数を登録しても保留は自動では外れず、要対応に残り続けていた。
 * 要対応に残っている間は税理士提出リストにも給与集計にも載らないため、
 * 本人は申請しているのに支給されない。
 *
 * ■ この操作ですること
 *  1. 受講回数を登録する（初受講なら 0）
 *  2. その明細の保留を外して確定させる
 *
 * 金額の計算そのものは申請時に済んでいる。保留は「担当が確認したか」の印なので、
 * ここで外すだけでよい（上限超過の承認とは別）。
 */

export const maxDuration = 30

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Supabaseの接続情報が設定されていません")
  return createSupabaseClient<Database>(url, key)
}

export async function POST(request: Request) {
  const auth = await createAuthClient()
  const {
    data: { user },
  } = await auth.auth.getUser()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as {
    /** petty_cash_transactions.id */
    id?: string
    /** 既受講回数。初受講なら 0。省略すると回数は登録せず保留だけ外す */
    priorCount?: number
  }
  if (!body.id) {
    return NextResponse.json({ error: "対象が指定されていません" }, { status: 400 })
  }

  try {
    const service = createServiceClient()

    const { data: txRow, error: txError } = await service
      .from("petty_cash_transactions")
      .select("id, staff_member_id, course_id, hold_reason")
      .eq("id", body.id)
      .eq("category", "staff_refund")
      .single()
    if (txError || !txRow) {
      return NextResponse.json({ error: "対象の明細が見つかりません" }, { status: 404 })
    }
    const tx = txRow as {
      id: string
      staff_member_id: string | null
      course_id: string | null
      hold_reason: string | null
    }

    if (tx.hold_reason !== "history") {
      return NextResponse.json(
        {
          error:
            "この明細は既受講回数の確認待ちではありません（すでに確定しているか、別の理由で保留中です）",
        },
        { status: 409 }
      )
    }

    // 受講回数を登録しておく（次回から自動で判定されるようにする）
    if (typeof body.priorCount === "number" && tx.staff_member_id && tx.course_id) {
      const count = Math.max(0, Math.min(99, Math.floor(body.priorCount)))
      const { data: member } = await service
        .from("staff_members")
        .select("line_profile")
        .eq("id", tx.staff_member_id)
        .maybeSingle()
      const profile = parseLineProfile((member as { line_profile?: unknown } | null)?.line_profile)
      const others = (profile.prior_courses ?? []).filter((p) => p.course_id !== tx.course_id)
      await service
        .from("staff_members")
        .update({
          line_profile: JSON.parse(
            JSON.stringify({
              ...profile,
              prior_courses: [
                ...others,
                {
                  course_id: tx.course_id,
                  count,
                  updated_at: new Date().toISOString(),
                  updated_by: user.email ?? undefined,
                },
              ],
            })
          ),
        })
        .eq("id", tx.staff_member_id)
    }

    // 保留を外して確定させる（これ以降は税理士提出・給与集計に含まれる）
    const { error: updateError } = await service
      .from("petty_cash_transactions")
      .update({ hold_reason: null })
      .eq("id", tx.id)
    if (updateError) throw updateError

    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "確定できませんでした" },
      { status: 500 }
    )
  }
}
