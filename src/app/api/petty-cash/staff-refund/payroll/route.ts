import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
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
  receipt_urls: string[] | null
  payroll_refund_status: string | null
  payroll_refunded_at: string | null
}

interface StaffGroup {
  staff_member_id: string | null
  staff_name: string
  total: number
  count: number
  items: PayrollTx[]
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
        "id, amount, note, description, transaction_date, created_at, staff_member_id, receipt_urls, payroll_refund_status, payroll_refunded_at"
      )
      .eq("settlement_method", "payroll")
      .order("transaction_date", { ascending: false })
    if (txError) throw txError

    const txs = (txRaw ?? []) as unknown as PayrollTx[]

    // スタッフ名マップ
    const { data: staffRaw } = await serviceClient
      .from("staff_members")
      .select("id, name")
    const staffName = new Map<string, string>()
    for (const s of (staffRaw ?? []) as unknown as { id: string; name: string }[]) {
      staffName.set(s.id, s.name)
    }
    const nameOf = (id: string | null) =>
      (id && staffName.get(id)) || "不明なスタッフ"

    // pending と done に分ける（NULL は pending 扱い）
    const pendingTxs = txs.filter((t) => t.payroll_refund_status !== "done")
    const doneTxs = txs.filter((t) => t.payroll_refund_status === "done")

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
          count: 0,
          items: [],
        }
        groupMap.set(key, g)
      }
      g.total += t.amount
      g.count += 1
      g.items.push(t)
    }
    const pending = Array.from(groupMap.values()).sort((a, b) => b.total - a.total)

    const done = doneTxs.map((t) => ({
      ...t,
      staff_name: nameOf(t.staff_member_id),
    }))

    return NextResponse.json({
      pending,
      done,
      pendingTotal: pending.reduce((s, g) => s + g.total, 0),
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
