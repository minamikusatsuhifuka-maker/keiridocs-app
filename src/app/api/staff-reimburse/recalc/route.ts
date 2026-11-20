import { NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { assessSubsidy } from "@/lib/subsidy-assess"
import { calcStoredSubsidy } from "@/lib/subsidy-rules"
import { parseAiRawObject } from "@/lib/staff-receipt-split"
import { fetchAllRows } from "@/lib/supabase/fetch-all"
import type { ExpenseItem, CourseKind, CourseRule } from "@/lib/subsidy-rules"
import type { Database } from "@/types/database"

/**
 * 保存済みの明細を、いまの規程で計算し直す。
 *
 * ■ なぜ必要か
 * 計算の不具合を直しても、すでに保存されている明細の支給額は変わらない。
 * これまでは「費用区分を別のものに変えて保存し、元に戻す」しか方法が無く、
 * 区分を間違えたまま保存してしまう危険があった。
 *
 * ■ 使い方
 *  - dryRun: true  … 変更せず、変更前後の支給額だけを返す（確認用）
 *  - dryRun: false … ids で指定した明細だけを保存する
 *
 * 立替額（領収書の金額）と費用区分は変更しない。支給率・上限・保留だけを directly
 * 計算し直す。確定済み（保留なし）のものも対象にするが、保存は担当が選んだ分だけ。
 */

export const maxDuration = 120

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Supabaseの接続情報が設定されていません")
  return createSupabaseClient<Database>(url, key)
}

interface TxRow {
  id: string
  staff_member_id: string | null
  staff_receipt_id: string | null
  amount: number
  transaction_date: string | null
  created_at: string
  expense_item: string | null
  expense_detail: string | null
  subsidy_category: string | null
  excess_amount: number | null
  approved_excess: number | null
  hold_reason: string | null
  course_id: string | null
  payroll_refund_status: string | null
}

export interface RecalcRow {
  id: string
  staffName: string
  label: string
  date: string | null
  amount: number
  /** いまの支給額 */
  before: number
  /** 計算し直した支給額 */
  after: number
  holdBefore: string | null
  holdAfter: string | null
  /** すでに給与で返金済みか（変えると支払いとずれるため注意を出す） */
  alreadyRefunded: boolean
  /** 支払年月日が確認できていない（年が読み取れなかった等） */
  dateUnconfirmed: boolean
}

export async function POST(request: Request) {
  const auth = await createAuthClient()
  const {
    data: { user },
  } = await auth.auth.getUser()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as {
    dryRun?: boolean
    ids?: string[]
    /** 何日前までを対象にするか（既定90日） */
    days?: number
  }
  const dryRun = body.dryRun !== false
  const days = Math.min(365, Math.max(1, body.days ?? 90))
  const since = new Date(Date.now() - days * 86400000).toISOString()

  try {
    const service = createServiceClient()

    const txs = await fetchAllRows<TxRow>((from, to) =>
      service
        .from("petty_cash_transactions")
        .select(
          "id, staff_member_id, staff_receipt_id, amount, transaction_date, created_at, expense_item, expense_detail, subsidy_category, excess_amount, approved_excess, hold_reason, course_id, payroll_refund_status"
        )
        .eq("category", "staff_refund")
        .gte("created_at", since)
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
          data: TxRow[] | null
          error: { message: string } | null
        }>
    )

    const targets = body.ids && body.ids.length > 0 ? txs.filter((t) => body.ids!.includes(t.id)) : txs

    // スタッフ名
    const { data: staffRaw } = await service.from("staff_members").select("id, name, is_test")
    const staffName = new Map<string, string>()
    const testStaff = new Set<string>()
    for (const s of (staffRaw ?? []) as { id: string; name: string; is_test: boolean | null }[]) {
      staffName.set(s.id, s.name)
      if (s.is_test) testStaff.add(s.id)
    }

    // 講座
    const { data: courseRaw } = await service.from("courses").select("id, kind, rule")
    const courses = new Map<string, { kind: string; rule: string }>()
    for (const c of (courseRaw ?? []) as { id: string; kind: string; rule: string }[]) {
      courses.set(c.id, { kind: c.kind, rule: c.rule })
    }

    const rows: RecalcRow[] = []

    for (const t of targets) {
      // 計算に必要な情報が無いものは対象外（旧い手入力など）
      if (!t.staff_member_id || !t.expense_item) continue
      if (testStaff.has(t.staff_member_id)) continue

      // 申請時と同じ条件で判定する
      let judgeDate: string | null = t.transaction_date
      let submittedAt = new Date(t.created_at)
      let manualSubmissionMonthRaw: unknown = null
      let dateUnconfirmed = false
      if (t.staff_receipt_id) {
        const { data: receipt } = await service
          .from("staff_receipts")
          .select("date, created_at, ai_raw")
          .eq("id", t.staff_receipt_id)
          .maybeSingle()
        const r = receipt as { date: string | null; created_at: string; ai_raw: unknown } | null
        if (r) {
          judgeDate = r.date
          submittedAt = new Date(r.created_at)
          manualSubmissionMonthRaw = r.ai_raw
          const raw = parseAiRawObject(r.ai_raw) ?? {}
          dateUnconfirmed =
            !!raw.date_unconfirmed || !/^\d{4}-\d{2}-\d{2}$/.test((r.date ?? "").slice(0, 10))
        }
      }

      const course = t.course_id ? courses.get(t.course_id) : null

      const assessed = await assessSubsidy({
        supabase: service,
        staffMemberId: t.staff_member_id,
        // 自分自身を過去の実績に数えない（初受講が再受講になり、上限も自分で埋まる）
        excludeTransactionId: t.id,
        amount: t.amount,
        item: t.expense_item as ExpenseItem,
        courseId: t.course_id,
        courseKind: (course?.kind ?? null) as CourseKind | null,
        courseRule: (course?.rule ?? null) as CourseRule | null,
        pendingCourseName: null,
        judgeDate,
        submittedAt,
        manualSubmissionMonthRaw,
      })

      const before = calcStoredSubsidy({
        amount: t.amount,
        subsidy_category: t.subsidy_category,
        expense_item: t.expense_item,
        excess_amount: t.excess_amount,
        approved_excess: t.approved_excess,
      })
      const nextCategory = assessed.rate < 1 ? "achievement_repeat" : "other"
      const nextExcess = assessed.excess > 0 ? assessed.excess : null
      const after = calcStoredSubsidy({
        amount: t.amount,
        subsidy_category: nextCategory,
        expense_item: t.expense_item,
        excess_amount: nextExcess,
        // 承認済みの追加支給はそのまま引き継ぐ（担当の判断を消さない）
        approved_excess: t.approved_excess,
      })

      const changed =
        before !== after ||
        (t.hold_reason ?? null) !== (assessed.holdReason ?? null) ||
        (t.subsidy_category ?? null) !== nextCategory

      if (!changed && dryRun) continue

      rows.push({
        id: t.id,
        staffName: staffName.get(t.staff_member_id) ?? "不明なスタッフ",
        label: t.expense_detail || (t.expense_item as string),
        date: t.transaction_date,
        amount: t.amount,
        before,
        after,
        holdBefore: t.hold_reason,
        holdAfter: assessed.holdReason ?? null,
        alreadyRefunded: t.payroll_refund_status === "done",
        dateUnconfirmed,
      })

      // 保存は、担当が選んだ明細だけ
      if (!dryRun && body.ids && body.ids.includes(t.id)) {
        const { error } = await service
          .from("petty_cash_transactions")
          .update({
            subsidy_category: nextCategory,
            excess_amount: nextExcess,
            hold_reason: assessed.holdReason,
          })
          .eq("id", t.id)
        if (error) throw error
      }
    }

    rows.sort((a, b) => a.staffName.localeCompare(b.staffName, "ja") || a.id.localeCompare(b.id))

    return NextResponse.json({
      rows,
      dryRun,
      saved: dryRun ? 0 : rows.length,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "再計算できませんでした" },
      { status: 500 }
    )
  }
}
