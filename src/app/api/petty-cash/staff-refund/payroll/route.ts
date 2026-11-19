import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { calcStoredSubsidy } from "@/lib/subsidy-rules"
import { parseAiRawObject } from "@/lib/staff-receipt-split"
import type { Database } from "@/types/database"

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createClient<Database>(url, serviceKey)
}

interface PayrollTx {
  id: string
  amount: number
  note: string | null
  description: string | null
  transaction_date: string | null
  created_at: string
  staff_member_id: string | null
  staff_receipt_id: string | null
  receipt_urls: string[] | null
  payroll_refund_status: string | null
  payroll_refunded_at: string | null
  subsidy_category: string | null
  expense_item: string | null
  expense_detail: string | null
  excess_amount: number | null
  approved_excess: number | null
  hold_reason: string | null
  /** 実際に給与で支払う額（規程どおりの支給額。半額・上限超過を反映） */
  subsidy: number
}

interface StaffGroup {
  staff_member_id: string | null
  staff_name: string
  /** 給与で支払う合計（支給額の合計） */
  total: number
  /** 立替の合計（領収書の金額の合計。参考表示用） */
  totalAmount: number
  count: number
  items: PayrollTx[]
}

/** 担当の確認待ちで、まだ支給額が確定していない明細 */
interface HeldTx extends PayrollTx {
  staff_name: string
}

/** テスト実行中に作られた申請（ai_raw.test_run_id が付いた領収書）のID */
async function fetchTestRunReceiptIds(
  client: ReturnType<typeof createServiceClient>,
  receiptIds: string[]
): Promise<Set<string>> {
  const found = new Set<string>()
  const ids = [...new Set(receiptIds)]
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await client
      .from("staff_receipts")
      .select("id, ai_raw")
      .in("id", ids.slice(i, i + 200))
    for (const r of (data ?? []) as { id: string; ai_raw: unknown }[]) {
      if (parseAiRawObject(r.ai_raw)?.test_run_id) found.add(r.id)
    }
  }
  return found
}

/**
 * GET /api/petty-cash/staff-refund/payroll
 * 給与返金（settlement_method='payroll'）をスタッフ別に集計して返す
 *  - pending: 返金待ち（payroll_refund_status='pending' or NULL）をスタッフ別グループ化
 *  - done: 返金済み履歴（payroll_refund_status='done'）
 */
export async function GET() {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const serviceClient = createServiceClient()

    const { data: txRaw, error: txError } = await serviceClient
      .from("petty_cash_transactions")
      .select(
        "id, amount, note, description, transaction_date, created_at, staff_member_id, staff_receipt_id, receipt_urls, payroll_refund_status, payroll_refunded_at, subsidy_category, expense_item, expense_detail, excess_amount, approved_excess, hold_reason"
      )
      .eq("settlement_method", "payroll")
      .order("transaction_date", { ascending: false })
    if (txError) throw txError

    const rawRows = (txRaw ?? []) as unknown as Omit<PayrollTx, "subsidy">[]

    /*
     * 給与で支払う額は「支給額」。領収書の金額ではない。
     *
     * 以前はここで領収書の金額（amount）を合計していた。
     * 半額支給（ATC再受講・他コース）と上限超過（交通費＋宿泊費 30,000円/講座）が
     * 反映されず、満額を給与に乗せてしまう状態だった。
     * 支給額は保存済みの明細から計算する（一覧・会計士提出と同じ calcStoredSubsidy）。
     */
    const txs: PayrollTx[] = rawRows.map((t) => ({ ...t, subsidy: calcStoredSubsidy(t) }))

    // スタッフ名・テスト判定
    const { data: staffRaw } = await serviceClient
      .from("staff_members")
      .select("id, name, is_test")
    const staffName = new Map<string, string>()
    const testStaff = new Set<string>()
    for (const s of (staffRaw ?? []) as unknown as {
      id: string
      name: string
      is_test: boolean | null
    }[]) {
      staffName.set(s.id, s.name)
      if (s.is_test) testStaff.add(s.id)
    }
    const nameOf = (id: string | null) =>
      (id && staffName.get(id)) || "不明なスタッフ"

    // テスト実行中に作られた申請を外す（給与に乗せてはいけない）
    const testRunReceiptIds = await fetchTestRunReceiptIds(
      serviceClient,
      txs.map((t) => t.staff_receipt_id).filter((v): v is string => !!v)
    )
    const isTestRow = (t: PayrollTx) =>
      (t.staff_member_id && testStaff.has(t.staff_member_id)) ||
      (t.staff_receipt_id && testRunReceiptIds.has(t.staff_receipt_id))

    const liveTxs = txs.filter((t) => !isTestRow(t))

    // pending と done に分ける（NULL は pending 扱い）
    // 担当の確認待ち（上限超過・講座待ちなど）は支給額が未確定なので給与に乗せない
    const notDone = liveTxs.filter((t) => t.payroll_refund_status !== "done")
    const pendingTxs = notDone.filter((t) => !t.hold_reason)
    const heldTxs = notDone.filter((t) => !!t.hold_reason)
    const doneTxs = liveTxs.filter((t) => t.payroll_refund_status === "done")

    // pending をスタッフ別にグループ化
    const groupMap = new Map<string, StaffGroup>()
    for (const t of pendingTxs) {
      const key = t.staff_member_id ?? "unknown"
      let g = groupMap.get(key)
      if (!g) {
        g = {
          staff_member_id: t.staff_member_id,
          staff_name: nameOf(t.staff_member_id),
          total: 0,
          totalAmount: 0,
          count: 0,
          items: [],
        }
        groupMap.set(key, g)
      }
      g.total += t.subsidy
      g.totalAmount += t.amount
      g.count += 1
      g.items.push(t)
    }
    const pending = Array.from(groupMap.values()).sort((a, b) => b.total - a.total)

    const done = doneTxs.map((t) => ({
      ...t,
      staff_name: nameOf(t.staff_member_id),
    }))

    // 確認待ちは別に返す。黙って消えると支給漏れになるため画面に出す
    const held: HeldTx[] = heldTxs.map((t) => ({
      ...t,
      staff_name: nameOf(t.staff_member_id),
    }))

    return NextResponse.json({
      pending,
      done,
      held,
      pendingTotal: pending.reduce((s, g) => s + g.total, 0),
      heldTotal: held.reduce((s, t) => s + t.amount, 0),
    })
  } catch (e: unknown) {
    console.error("[staff-refund/payroll GET]", e)
    const msg = e instanceof Error ? e.message : "unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/**
 * POST /api/petty-cash/staff-refund/payroll
 * 給与返金を「返金済み」にする
 * body: { ids?: string[], staff_member_id?: string }
 *  - ids 指定: その取引のみ done に更新
 *  - staff_member_id 指定: そのスタッフの pending な給与返金をすべて done に更新
 */
export async function POST(req: NextRequest) {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await req.json() as { ids?: string[]; staff_member_id?: string }
    const serviceClient = createServiceClient()
    const now = new Date().toISOString()

    let query = serviceClient
      .from("petty_cash_transactions")
      .update({ payroll_refund_status: "done", payroll_refunded_at: now })
      .eq("settlement_method", "payroll")
      .neq("payroll_refund_status", "done")

    if (Array.isArray(body.ids) && body.ids.length > 0) {
      query = query.in("id", body.ids)
    } else if (body.staff_member_id) {
      query = query.eq("staff_member_id", body.staff_member_id)
    } else {
      return NextResponse.json(
        { error: "ids または staff_member_id を指定してください" },
        { status: 400 }
      )
    }

    const { data, error } = await query.select("id")
    if (error) throw error

    return NextResponse.json({ success: true, updated: data?.length ?? 0 })
  } catch (e: unknown) {
    console.error("[staff-refund/payroll POST]", e)
    const msg = e instanceof Error ? e.message : "unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
