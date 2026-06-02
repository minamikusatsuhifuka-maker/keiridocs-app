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

/**
 * POST /api/petty-cash/staff-refund/manual
 * スタッフ返金（手入力）
 */
export async function POST(req: NextRequest) {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await req.json() as {
      staff_member_id: string
      amount: number
      note?: string
      transaction_date?: string
      settlement_method?: string
    }
    const { staff_member_id, amount, note, transaction_date } = body
    // 精算方法（未指定は後方互換で小口返金扱い）
    const settlementMethod =
      body.settlement_method === "payroll" || body.settlement_method === "storage_only"
        ? body.settlement_method
        : "petty_cash"

    if (!staff_member_id) {
      return NextResponse.json({ error: "スタッフを選択してください" }, { status: 400 })
    }
    if (!amount || amount <= 0) {
      return NextResponse.json({ error: "金額を正しく入力してください" }, { status: 400 })
    }

    const { data: roleData } = await authSupabase
      .from("user_roles")
      .select("display_name")
      .eq("user_id", user.id)
      .maybeSingle()
    const registeredBy =
      (roleData?.display_name as string) ||
      (user.user_metadata?.full_name as string) ||
      user.email ||
      "不明"

    const serviceClient = createServiceClient()

    const { data: settingsRaw, error: settingsError } = await serviceClient
      .from("petty_cash_settings")
      .select("*")
      .limit(1)
      .single()
    if (settingsError) throw settingsError
    const settings = settingsRaw as unknown as { id: string; balance: number }
    const currentBalance = settings.balance ?? 0
    // 小口返金のみ残高を減算。給与返金・保管のみは残高を動かさない
    const deductsBalance = settlementMethod === "petty_cash"
    const newBalance = deductsBalance ? currentBalance - amount : currentBalance

    const txDate = transaction_date || new Date().toISOString().slice(0, 10)
    const noteText = note?.trim() || "スタッフ返金"

    const { data: tx, error: insertError } = await serviceClient
      .from("petty_cash_transactions")
      .insert({
        type: "出金",
        amount,
        description: noteText,
        staff_member_id,
        registered_by: registeredBy,
        category: "staff_refund",
        note: noteText,
        created_by: registeredBy,
        transaction_date: txDate,
        balance_after: newBalance,
        settlement_method: settlementMethod,
        // 給与返金のみ返金待ちステータスを付与
        payroll_refund_status: settlementMethod === "payroll" ? "pending" : null,
      })
      .select()
      .single()
    if (insertError) throw insertError

    // 残高を動かすのは小口返金のときだけ
    if (deductsBalance) {
      const { error: updateError } = await serviceClient
        .from("petty_cash_settings")
        .update({ balance: newBalance, updated_at: new Date().toISOString() })
        .eq("id", settings.id)
      if (updateError) throw updateError
    }

    return NextResponse.json({ success: true, transaction: tx, balance: newBalance })
  } catch (e: unknown) {
    console.error("[staff-refund/manual]", e)
    const msg = e instanceof Error ? e.message : "unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
