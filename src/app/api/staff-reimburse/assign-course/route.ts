import { NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { assessSubsidy } from "@/lib/subsidy-assess"
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
  }
  if (!body.id || !body.courseId) {
    return NextResponse.json({ error: "対象と講座を指定してください" }, { status: 400 })
  }

  try {
    const service = createServiceClient()

    const { data: txRow, error: txError } = await service
      .from("petty_cash_transactions")
      .select(
        "id, staff_member_id, staff_receipt_id, amount, expense_item, hold_reason, course_id, course_pending_name, created_at"
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
      hold_reason: string | null
      course_id: string | null
      course_pending_name: string | null
      created_at: string
    }

    if (tx.hold_reason !== "course") {
      return NextResponse.json(
        { error: "この明細は講座の確認待ちではありません（すでに確定しているか、別の理由で保留中です）" },
        { status: 409 }
      )
    }
    if (!tx.staff_member_id) {
      return NextResponse.json({ error: "スタッフが特定できません" }, { status: 409 })
    }

    const { data: courseRow } = await service
      .from("courses")
      .select("id, name, kind, rule")
      .eq("id", body.courseId)
      .single()
    if (!courseRow) {
      return NextResponse.json({ error: "指定された講座が見つかりません" }, { status: 400 })
    }
    const course = courseRow as { id: string; name: string; kind: string; rule: string }

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
      amount: tx.amount,
      item: (tx.expense_item ?? "other") as ExpenseItem,
      courseId: course.id,
      courseKind: course.kind as CourseKind,
      courseRule: course.rule as CourseRule,
      pendingCourseName: null,
      judgeDate,
      submittedAt,
      manualSubmissionMonthRaw,
    })

    const { error: updateError } = await service
      .from("petty_cash_transactions")
      .update({
        course_id: course.id,
        // 申請時の名前は残さない（割り当て済みであることを明確にする）
        course_pending_name: null,
        excess_amount: assessed.excess > 0 ? assessed.excess : null,
        // 上限超過や受講回数未登録なら、引き続き担当の確認待ちにする
        hold_reason: assessed.holdReason,
        subsidy_category: assessed.rate < 1 ? "achievement_repeat" : "other",
      })
      .eq("id", tx.id)
    if (updateError) throw updateError

    return NextResponse.json({
      ok: true,
      courseName: course.name,
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
