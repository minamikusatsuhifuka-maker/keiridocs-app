import { NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { assessSubsidy } from "@/lib/subsidy-assess"
import { calcStoredSubsidy } from "@/lib/subsidy-rules"
import { STAFF_EXPENSE_DETAILS } from "@/lib/subsidy"
import type { ExpenseItem, CourseKind, CourseRule } from "@/lib/subsidy-rules"
import type { Database } from "@/types/database"

/**
 * 「講座の確認」で止まっている明細を、登録済みの講座に割り当てて確定させる。
 *
 * ■ なぜ必要か
 * スタッフは講座名を自由に入力するため、「アチーブメントテクノロジーコース初回」
 * のように講座マスタと一致しない名前で申請される。一致しないと講座が決まらず、
 * 支給率と上限（交通費＋宿泊費 合計30,000円／講座）を判定できないため保留になる。
 *
 * これまで割り当てる手段が無く、同じ講座を名前違いで作り直すしかなかった。
 * それをすると上限の累計が講座ごとに分かれ、30,000円の枠が二重になってしまう。
 *
 * ■ この操作ですること
 * 既存の講座に紐づけ直し、その講座の方式で支給額を計算し直す。
 * 受講回数（初受講か再受講か）も申請時と同じ基準で判定するため、
 * 初受講なら全額、再受講なら規程どおりの支給率になる。
 *
 * 金額（立替額）は変更しない。
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
    /** 割り当てる courses.id */
    courseId?: string
    /** 内訳を直す場合（交通費・宿泊費・受講料など） */
    expenseItem?: string
    /** 費用区分の表示を直す場合 */
    detailKey?: string
    /** true なら保存せず、変更前後の支給額だけを返す */
    dryRun?: boolean
  }
  if (!body.id) {
    return NextResponse.json({ error: "対象を指定してください" }, { status: 400 })
  }
  if (!body.courseId && !body.expenseItem) {
    return NextResponse.json({ error: "講座または内訳を指定してください" }, { status: 400 })
  }

  try {
    const service = createServiceClient()

    const { data: txRow, error: txError } = await service
      .from("petty_cash_transactions")
      .select(
        "id, staff_member_id, staff_receipt_id, amount, expense_item, expense_detail, subsidy_category, excess_amount, approved_excess, hold_reason, course_id, course_pending_name, created_at"
      )
      .eq("id", body.id)
      .eq("category", "staff_refund")
      .single()
    if (txError || !txRow) {
      return NextResponse.json({ error: "対象の明細が見つかりません" }, { status: 404 })
    }
    const tx = txRow as {
      id: string
      staff_member_id: string | null
      staff_receipt_id: string | null
      amount: number
      expense_item: string | null
      expense_detail: string | null
      subsidy_category: string | null
      excess_amount: number | null
      approved_excess: number | null
      hold_reason: string | null
      course_id: string | null
      course_pending_name: string | null
      created_at: string
    }

    // 確認待ちの明細だけを対象にする（確定済みを黙って書き換えないため）
    if (!tx.hold_reason) {
      return NextResponse.json(
        { error: "この明細はすでに確定しています。明細の「編集」から直してください。" },
        { status: 409 }
      )
    }
    if (!tx.staff_member_id) {
      return NextResponse.json({ error: "スタッフが特定できません" }, { status: 409 })
    }

    const targetCourseId = body.courseId ?? tx.course_id
    let course: { id: string; name: string; kind: string; rule: string } | null = null
    if (targetCourseId) {
      const { data: courseRow } = await service
        .from("courses")
        .select("id, name, kind, rule")
        .eq("id", targetCourseId)
        .single()
      if (!courseRow) {
        return NextResponse.json({ error: "指定された講座が見つかりません" }, { status: 400 })
      }
      course = courseRow as { id: string; name: string; kind: string; rule: string }
    }

    // 内訳（交通費・宿泊費など）。指定が無ければ今のまま
    const item = (body.expenseItem ?? tx.expense_item ?? "other") as ExpenseItem

    // 申請時と同じ条件で判定し直す（領収書の日付・申請日時を使う）
    let judgeDate: string | null = null
    let submittedAt = new Date(tx.created_at)
    let manualSubmissionMonthRaw: unknown = null
    if (tx.staff_receipt_id) {
      const { data: receipt } = await service
        .from("staff_receipts")
        .select("date, created_at, ai_raw")
        .eq("id", tx.staff_receipt_id)
        .maybeSingle()
      const r = receipt as { date: string | null; created_at: string; ai_raw: unknown } | null
      if (r) {
        judgeDate = r.date
        submittedAt = new Date(r.created_at)
        manualSubmissionMonthRaw = r.ai_raw
      }
    }

    const assessed = await assessSubsidy({
      supabase: service,
      staffMemberId: tx.staff_member_id,
      // 自分自身を過去の実績に数えない（初受講が再受講になり、上限も自分で埋まる）
      excludeTransactionId: tx.id,
      amount: tx.amount,
      item,
      courseId: course?.id ?? null,
      courseKind: (course?.kind ?? null) as CourseKind | null,
      courseRule: (course?.rule ?? null) as CourseRule | null,
      pendingCourseName: null,
      judgeDate,
      submittedAt,
      manualSubmissionMonthRaw,
    })

    const nextCategory = assessed.rate < 1 ? "achievement_repeat" : "other"
    const nextExcess = assessed.excess > 0 ? assessed.excess : null

    const before = calcStoredSubsidy({
      amount: tx.amount,
      subsidy_category: tx.subsidy_category,
      expense_item: tx.expense_item,
      excess_amount: tx.excess_amount,
      approved_excess: tx.approved_excess,
    })
    const after = calcStoredSubsidy({
      amount: tx.amount,
      subsidy_category: nextCategory,
      expense_item: item,
      excess_amount: nextExcess,
      approved_excess: tx.approved_excess,
    })

    // 確認だけ（保存しない）
    if (body.dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        courseName: course?.name ?? null,
        item,
        before,
        after,
        rate: assessed.rate,
        excess: assessed.excess,
        holdReason: assessed.holdReason,
        previousName: tx.course_pending_name,
      })
    }

    const detail = body.detailKey
      ? STAFF_EXPENSE_DETAILS.find((d) => d.key === body.detailKey) ?? null
      : null

    const { error: updateError } = await service
      .from("petty_cash_transactions")
      .update({
        course_id: course?.id ?? null,
        // 申請時の名前は残さない（割り当て済みであることを明確にする）
        course_pending_name: null,
        expense_item: item,
        ...(detail ? { expense_detail: detail.fullLabel } : {}),
        excess_amount: nextExcess,
        // 上限超過や受講回数未登録なら、引き続き担当の確認待ちにする
        hold_reason: assessed.holdReason,
        subsidy_category: nextCategory,
      })
      .eq("id", tx.id)
    if (updateError) throw updateError

    return NextResponse.json({
      ok: true,
      courseName: course?.name ?? null,
      item,
      before,
      after,
      rate: assessed.rate,
      excess: assessed.excess,
      holdReason: assessed.holdReason,
      previousName: tx.course_pending_name,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "割り当てできませんでした" },
      { status: 500 }
    )
  }
}
