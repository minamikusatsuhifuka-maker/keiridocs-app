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
 * POST /api/petty-cash/patient-response
 * 患者対応の支出登録（保険診療返金 / 自費診療返金 / その他）
 *
 * Body:
 *  - amount: number
 *  - subcategory: 'insurance_refund' | 'self_pay_refund' | 'other'
 *  - note?: string
 *  - transaction_date?: string (YYYY-MM-DD)
 */
export async function POST(req: NextRequest) {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await req.json() as {
      amount: number
      subcategory: string
      note?: string
      transaction_date?: string
    }
    const { amount, subcategory, note, transaction_date } = body

    if (!amount || amount <= 0) {
      return NextResponse.json({ error: "金額を正しく入力してください" }, { status: 400 })
    }
    if (!["insurance_refund", "self_pay_refund", "other"].includes(subcategory)) {
      return NextResponse.json({ error: "内容種別が不正です" }, { status: 400 })
    }
    if (subcategory === "other" && !note?.trim()) {
      return NextResponse.json({ error: "その他の場合は内容を入力してください" }, { status: 400 })
    }

    const displayNote =
      subcategory === "insurance_refund"
        ? "保険診療返金"
        : subcategory === "self_pay_refund"
        ? "自費診療返金"
        : (note || "")

    // 登録者名取得
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

    // 現在残高
    const { data: settingsRaw, error: settingsError } = await serviceClient
      .from("petty_cash_settings")
      .select("*")
      .limit(1)
      .single()
    if (settingsError) throw settingsError
    const settings = settingsRaw as unknown as { id: string; balance: number }
    const currentBalance = settings.balance ?? 0
    const newBalance = currentBalance - amount

    const txDate = transaction_date || new Date().toISOString().slice(0, 10)

    // 取引登録（type='出金', amount は正の値で保持。category/subcategoryで内訳）
    const { data: tx, error: insertError } = await serviceClient
      .from("petty_cash_transactions")
      .insert({
        type: "出金",
        amount,
        description: displayNote,
        registered_by: registeredBy,
        // 新規カラム
        category: "patient_response",
        subcategory,
        note: displayNote,
        created_by: registeredBy,
        transaction_date: txDate,
        balance_after: newBalance,
      })
      .select()
      .single()
    if (insertError) throw insertError

    // 残高更新
    const { error: updateError } = await serviceClient
      .from("petty_cash_settings")
      .update({ balance: newBalance, updated_at: new Date().toISOString() })
      .eq("id", settings.id)
    if (updateError) throw updateError

    return NextResponse.json({ success: true, transaction: tx, balance: newBalance })
  } catch (e: unknown) {
    console.error("[patient-response]", e)
    const msg = e instanceof Error ? e.message : "unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
