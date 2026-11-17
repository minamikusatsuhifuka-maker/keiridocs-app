import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { fetchAllRows } from "@/lib/supabase/fetch-all"
import { parseAiRawObject } from "@/lib/staff-receipt-split"
import { EXPENSE_ITEM_LABELS, type ExpenseItem, type HoldReason } from "@/lib/subsidy-rules"
import type { Database } from "@/types/database"

/**
 * 受付担当の「要対応」一覧。
 *
 * GET /api/staff-reimburse/pending
 *
 * 1か所見れば済む状態を作るため、対応が必要なものをすべてここに集める。
 *
 *   excess     上限超過の承認待ち（担当が追加支給額を承認する）
 *   course     講座の割り当て待ち（講座マスタに無い講座名で申請された）
 *   attach     添付待ち（資格試験の合格通知・修了通知）
 *   incomplete 未完了の申請（スタッフが費用区分を選ばずに離脱した）
 *
 * excess / course / attach は支給額が確定していないため税理士提出に含まれない。
 * incomplete は精算自体が作られていないため、本人は申請したつもりで支給されない。
 */

export const maxDuration = 60

/** 操作中の申請を未完了として拾わないための猶予（分） */
const INCOMPLETE_GRACE_MINUTES = 60

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Supabaseの接続情報が設定されていません")
  return createClient<Database>(url, key)
}

interface HoldTxRow {
  id: string
  staff_member_id: string | null
  amount: number | null
  transaction_date: string | null
  created_at: string
  expense_detail: string | null
  expense_item: string | null
  excess_amount: number | null
  subsidy_category: string | null
  hold_reason: string | null
  course_id: string | null
  course_pending_name: string | null
}

export interface PendingItem {
  /** petty_cash_transactions.id（excess/course/attach）または staff_receipts.id（incomplete） */
  id: string
  kind: HoldReason | "incomplete"
  staffName: string
  /** 講座名（無い場合は空） */
  courseName: string
  /** 内訳の表示名 */
  itemLabel: string
  /** 立替額 */
  amount: number
  /** 上限を超えた額（excess のみ） */
  excess: number
  /** 承認時に提示する追加支給額の既定値（excess のみ） */
  suggested: number
  /** 2回目以降（超過分も半額になる）か */
  isRepeat: boolean
  /** 申請日時（ISO） */
  submittedAt: string
  /** 経過日数 */
  daysWaiting: number
}

export async function GET() {
  const authSupabase = await createAuthClient()
  const {
    data: { user },
    error: authError,
  } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const supabase = createServiceClient()

    // スタッフ名とテスト判定
    const staffRaw = await fetchAllRows<{ id: string; name: string; is_test: boolean | null }>((from, to) =>
      supabase
        .from("staff_members")
        .select("id, name, is_test")
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
          data: { id: string; name: string; is_test: boolean | null }[] | null
          error: { message: string } | null
        }>
    )
    const staffName = new Map(staffRaw.map((s) => [s.id, s.name]))
    const testStaff = new Set(staffRaw.filter((s) => s.is_test).map((s) => s.id))

    // 講座名
    const courses = await fetchCourses(supabase)

    // 1. 保留中の明細（上限超過・講座待ち・添付待ち）
    const holds = await fetchHoldRows(supabase)

    const items: PendingItem[] = holds
      .filter((t) => !(t.staff_member_id && testStaff.has(t.staff_member_id)))
      .map((t) => {
        const excess = t.excess_amount ?? 0
        const isRepeat = t.subsidy_category === "achievement_repeat"
        const item = (t.expense_item ?? "other") as ExpenseItem
        // 2回目以降は超過分も半額が規程どおり。弁当代は常に全額
        const rate = item === "bento" ? 1 : isRepeat ? 0.5 : 1
        return {
          id: t.id,
          kind: (t.hold_reason ?? "excess") as HoldReason,
          staffName: (t.staff_member_id && staffName.get(t.staff_member_id)) || "不明なスタッフ",
          courseName:
            (t.course_id && courses.get(t.course_id)) || t.course_pending_name || "",
          itemLabel: EXPENSE_ITEM_LABELS[item] ?? t.expense_detail ?? "その他",
          amount: t.amount ?? 0,
          excess,
          suggested: Math.floor(excess * rate),
          isRepeat,
          submittedAt: t.created_at,
          daysWaiting: daysSince(t.created_at),
        }
      })

    // 2. 未完了の申請（精算が作られていない領収書）
    const incomplete = await fetchIncomplete(supabase, staffName, testStaff)

    const all = [...items, ...incomplete].sort((a, b) => b.daysWaiting - a.daysWaiting)

    return NextResponse.json({
      items: all,
      counts: {
        total: all.length,
        excess: all.filter((i) => i.kind === "excess").length,
        course: all.filter((i) => i.kind === "course").length,
        attach: all.filter((i) => i.kind === "attach").length,
        pass: all.filter((i) => i.kind === "pass").length,
        term: all.filter((i) => i.kind === "term").length,
        incomplete: all.filter((i) => i.kind === "incomplete").length,
      },
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "要対応の一覧を取得できませんでした"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** 講座マスタ（migration 044 未適用なら空） */
async function fetchCourses(supabase: ReturnType<typeof createServiceClient>) {
  try {
    const rows = await fetchAllRows<{ id: string; name: string }>((from, to) =>
      supabase
        .from("courses")
        .select("id, name")
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
          data: { id: string; name: string }[] | null
          error: { message: string } | null
        }>
    )
    return new Map(rows.map((c) => [c.id, c.name]))
  } catch {
    return new Map<string, string>()
  }
}

/** 保留中の明細（migration 044 未適用なら空を返す） */
async function fetchHoldRows(supabase: ReturnType<typeof createServiceClient>): Promise<HoldTxRow[]> {
  try {
    return await fetchAllRows<HoldTxRow>((from, to) =>
      supabase
        .from("petty_cash_transactions")
        .select(
          "id, staff_member_id, amount, transaction_date, created_at, expense_detail, expense_item, excess_amount, subsidy_category, hold_reason, course_id, course_pending_name"
        )
        .eq("category", "staff_refund")
        .not("hold_reason", "is", null)
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
          data: HoldTxRow[] | null
          error: { message: string } | null
        }>
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (/hold_reason|expense_item|column/i.test(message)) return []
    throw e
  }
}

/** 未完了の申請（staff_receipts はあるが精算が作られていない） */
async function fetchIncomplete(
  supabase: ReturnType<typeof createServiceClient>,
  staffName: Map<string, string>,
  testStaff: Set<string>
): Promise<PendingItem[]> {
  const cutoff = new Date(Date.now() - INCOMPLETE_GRACE_MINUTES * 60 * 1000).toISOString()

  const txRows = await fetchAllRows<{ staff_receipt_id: string | null }>((from, to) =>
    supabase
      .from("petty_cash_transactions")
      .select("staff_receipt_id")
      .eq("category", "staff_refund")
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: { staff_receipt_id: string | null }[] | null
        error: { message: string } | null
      }>
  )
  const settled = new Set(txRows.map((t) => t.staff_receipt_id).filter((v): v is string => !!v))

  const receipts = await fetchAllRows<{
    id: string
    staff_member_id: string | null
    store_name: string | null
    amount: number | null
    created_at: string
    ai_raw?: unknown
  }>((from, to) =>
    supabase
      .from("staff_receipts")
      .select("id, staff_member_id, store_name, amount, created_at, ai_raw")
      .lt("created_at", cutoff)
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: {
          id: string
          staff_member_id: string | null
          store_name: string | null
          amount: number | null
          created_at: string
          ai_raw?: unknown
        }[] | null
        error: { message: string } | null
      }>
  )

  return receipts
    .filter((r) => !settled.has(r.id))
    .filter((r) => !(r.staff_member_id && testStaff.has(r.staff_member_id)))
    // 担当が「対応済み」にしたものは要対応から外す（/api/staff-reimburse/dismiss）
    .filter((r) => !parseAiRawObject(r.ai_raw)?.pending_dismissed_at)
    .map((r) => ({
      id: r.id,
      kind: "incomplete" as const,
      staffName: (r.staff_member_id && staffName.get(r.staff_member_id)) || "不明なスタッフ",
      courseName: "",
      itemLabel: r.store_name?.trim() || "不明",
      amount: r.amount ?? 0,
      excess: 0,
      suggested: 0,
      isRepeat: false,
      submittedAt: r.created_at,
      daysWaiting: daysSince(r.created_at),
    }))
}

function daysSince(iso: string): number {
  const d = new Date(iso).getTime()
  if (Number.isNaN(d)) return 0
  return Math.max(0, Math.floor((Date.now() - d) / 86400000))
}
