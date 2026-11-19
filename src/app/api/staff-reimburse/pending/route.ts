import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { fetchAllRows } from "@/lib/supabase/fetch-all"
import { parseAiRawObject } from "@/lib/staff-receipt-split"
import {
  EXPENSE_ITEM_LABELS,
  calcBreakdownLines,
  capForItem,
  type ExpenseItem,
  type HoldReason,
} from "@/lib/subsidy-rules"
import type { Database } from "@/types/database"

/**
 * 担当の「要対応」一覧。
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
  staff_receipt_id: string | null
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
  kind: HoldReason | "incomplete" | "help"
  /** 連絡（LINE）に使う staff_members.id */
  staffMemberId: string | null
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
  /**
   * 上限と支給率の計算内訳（上限がある内訳のみ。無ければ空）。
   * 何を承認するのかを担当が画面で確認できるようにするため。
   */
  calcNote: string[]
  /** 申請日時（ISO） */
  submittedAt: string
  /** 経過日数 */
  daysWaiting: number
  /**
   * テストの印（ai_raw.test_run_id）が付いたまま残っている申請か。
   *
   * テストスタッフを解除したあとに残っていると、本物の申請なのに
   * 給与集計・会計士提出から静かに外れる。担当が気づけるよう印を立てる。
   */
  testMarked?: boolean
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

    // テスト実行中に作られた申請を外す（スイッチをOFFに戻しても本番に混ざらないように）
    const testRunReceiptIds = await fetchTestRunReceiptIds(
      supabase,
      holds.map((t) => t.staff_receipt_id).filter((v): v is string => !!v)
    )

    const items: PendingItem[] = holds
      .filter((t) => !(t.staff_member_id && testStaff.has(t.staff_member_id)))
      /*
       * テスト実行中に作られた申請は外す。ただし、テストスタッフを解除した方の分は残す。
       *
       * テストを終えずにスイッチをOFFにすると、そのあとの本物の申請にも
       * テストの印が付いてしまう。外したままにすると、本人は申請できたのに
       * 支給されず、担当からも見えない。印付きとして見せ、担当が直せるようにする。
       */
      .filter(
        (t) =>
          !(
            t.staff_receipt_id &&
            testRunReceiptIds.has(t.staff_receipt_id) &&
            t.staff_member_id &&
            testStaff.has(t.staff_member_id)
          )
      )
      .map((t) => {
        const excess = t.excess_amount ?? 0
        const isRepeat = t.subsidy_category === "achievement_repeat"
        const item = (t.expense_item ?? "other") as ExpenseItem
        // 2回目以降は超過分も半額が規程どおり。弁当代は常に全額
        const rate = item === "bento" ? 1 : isRepeat ? 0.5 : 1
        return {
          id: t.id,
          kind: (t.hold_reason ?? "excess") as HoldReason,
          staffMemberId: t.staff_member_id,
          staffName: (t.staff_member_id && staffName.get(t.staff_member_id)) || "不明なスタッフ",
          courseName:
            (t.course_id && courses.get(t.course_id)) || t.course_pending_name || "",
          itemLabel: EXPENSE_ITEM_LABELS[item] ?? t.expense_detail ?? "その他",
          amount: t.amount ?? 0,
          excess,
          suggested: Math.floor(excess * rate),
          isRepeat,
          // 何を承認するのかが分かるよう、上限と支給率の計算内訳を添える。
          // 残枠は保存済みの値から逆算する（上限 − 今回の対象額）。
          calcNote: (() => {
            const cap = capForItem(item, !!(t.course_id || t.course_pending_name))
            if (cap === null) return []
            const covered = Math.max(0, (t.amount ?? 0) - excess)
            return calcBreakdownLines(
              {
                subsidy: Math.floor(covered * rate),
                excess,
                cap,
                rate,
                capUsed: excess > 0 ? Math.max(0, cap - covered) : 0,
                holdReason: (t.hold_reason ?? null) as HoldReason | null,
              },
              t.amount ?? 0,
              item,
              (t.course_id && courses.get(t.course_id)) || t.course_pending_name || null
            )
          })(),
          submittedAt: t.created_at,
          daysWaiting: daysSince(t.created_at),
          testMarked: !!(t.staff_receipt_id && testRunReceiptIds.has(t.staff_receipt_id)),
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
        detail: all.filter((i) => i.kind === "detail").length,
        help: all.filter((i) => i.kind === "help").length,
        dup: all.filter((i) => i.kind === "dup").length,
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
/**
 * テスト実行中に作られた申請のIDを集める。
 *
 * テストスタッフのスイッチ（is_test）は後から切り替えられるため、
 * それだけで判定すると、OFFに戻した時点で練習の申請が要対応に出てしまう。
 */
async function fetchTestRunReceiptIds(
  supabase: ReturnType<typeof createServiceClient>,
  receiptIds: string[]
): Promise<Set<string>> {
  const ids = Array.from(new Set(receiptIds))
  if (ids.length === 0) return new Set()
  try {
    const rows = await fetchAllRows<{ id: string }>((from, to) =>
      supabase
        .from("staff_receipts")
        .select("id")
        .in("id", ids)
        .not("ai_raw->>test_run_id", "is", null)
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
          data: { id: string }[] | null
          error: { message: string } | null
        }>
    )
    return new Set(rows.map((r) => r.id))
  } catch {
    // 判定できないときは除外しない（要対応が消えるより、出すほうが安全）
    return new Set()
  }
}

async function fetchHoldRows(supabase: ReturnType<typeof createServiceClient>): Promise<HoldTxRow[]> {
  try {
    return await fetchAllRows<HoldTxRow>((from, to) =>
      supabase
        .from("petty_cash_transactions")
        .select(
          "id, staff_member_id, staff_receipt_id, amount, transaction_date, created_at, expense_detail, expense_item, excess_amount, subsidy_category, hold_reason, course_id, course_pending_name"
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
      // 猶予（60分）内でも、本人が「担当に相談する」を押したものは拾う
      .or(`created_at.lt.${cutoff},ai_raw->>help_requested_at.not.is.null`)
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
    // 本人が取り消した申請は未完了ではない
    .filter((r) => !parseAiRawObject(r.ai_raw)?.cancelled_at)
    .map((r) => ({
      id: r.id,
      kind: (parseAiRawObject(r.ai_raw)?.help_requested_at ? "help" : "incomplete") as
        | "help"
        | "incomplete",
      staffMemberId: r.staff_member_id,
      staffName: (r.staff_member_id && staffName.get(r.staff_member_id)) || "不明なスタッフ",
      courseName: "",
      itemLabel: r.store_name?.trim() || "不明",
      amount: r.amount ?? 0,
      excess: 0,
      suggested: 0,
      isRepeat: false,
      // 未完了は区分が決まっていないため、上限の計算内訳は出せない
      calcNote: [],
      submittedAt: r.created_at,
      daysWaiting: daysSince(r.created_at),
      testMarked: !!parseAiRawObject(r.ai_raw)?.test_run_id,
    }))
}

function daysSince(iso: string): number {
  const d = new Date(iso).getTime()
  if (Number.isNaN(d)) return 0
  return Math.max(0, Math.floor((Date.now() - d) / 86400000))
}
