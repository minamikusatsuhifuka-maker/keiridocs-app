import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import type { Database } from "@/types/database"

// RLSバイパス用サービスクライアント
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createClient<Database>(url, serviceKey)
}

// 残高・取引一覧取得
export async function GET(request: NextRequest) {
  const supabase = await createAuthClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const year = searchParams.get("year")
    const month = searchParams.get("month")

    // 残高取得
    const { data: settingsRaw, error: settingsError } = await supabase
      .from("petty_cash_settings")
      .select("*")
      .limit(1)
      .single()

    if (settingsError) throw settingsError
    const settings = settingsRaw as unknown as { id: string; balance: number } | null

    // 取引一覧取得
    let query = supabase
      .from("petty_cash_transactions")
      .select("*")
      .order("created_at", { ascending: false })

    if (year && month) {
      const startDate = `${year}-${month.padStart(2, "0")}-01T00:00:00`
      const endMonth = parseInt(month)
      const endYear = endMonth === 12 ? parseInt(year) + 1 : parseInt(year)
      const nextMonth = endMonth === 12 ? 1 : endMonth + 1
      const endDate = `${endYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00`
      query = query.gte("created_at", startDate).lt("created_at", endDate)
    } else if (year) {
      query = query.gte("created_at", `${year}-01-01T00:00:00`).lt("created_at", `${parseInt(year) + 1}-01-01T00:00:00`)
    }

    const { data: transactions, error: txError } = await query
    if (txError) throw txError

    return NextResponse.json({
      balance: settings?.balance ?? 0,
      transactions: transactions || [],
    })
  } catch (error) {
    console.error("小口現金取得エラー:", error)
    return NextResponse.json({ error: "小口現金データの取得に失敗しました" }, { status: 500 })
  }
}

// 取引追加（入金/出金/返金）
export async function POST(request: NextRequest) {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as {
      type: string
      amount: number
      description?: string
      staff_member_id?: string
      staff_receipt_id?: string
      document_id?: string
      receipt_image_url?: string
      dropbox_path?: string
    }

    const { type, amount, description, staff_member_id, staff_receipt_id, document_id, receipt_image_url, dropbox_path } = body

    if (!type || !["入金", "出金", "返金"].includes(type)) {
      return NextResponse.json({ error: "typeは入金/出金/返金のいずれかを指定してください" }, { status: 400 })
    }
    if (!amount || amount <= 0) {
      return NextResponse.json({ error: "amountは正の数で指定してください" }, { status: 400 })
    }

    const serviceClient = createServiceClient()

    // 登録者名取得
    const { data: roleData } = await authSupabase
      .from("user_roles")
      .select("display_name")
      .eq("user_id", user.id)
      .maybeSingle()
    const registeredBy = (roleData?.display_name as string) || (user.user_metadata?.full_name as string) || user.email || "不明"

    // 現在の残高取得
    const { data: settingsRaw, error: settingsError } = await serviceClient
      .from("petty_cash_settings")
      .select("*")
      .limit(1)
      .single()

    if (settingsError) throw settingsError

    const settings = settingsRaw as unknown as { id: string; balance: number }
    const currentBalance = settings.balance ?? 0
    let newBalance: number

    if (type === "入金") {
      newBalance = currentBalance + amount
    } else if (type === "出金") {
      newBalance = currentBalance - amount
    } else {
      // 返金 = 残高を戻す
      newBalance = currentBalance + amount
    }

    // 取引登録
    const { data: transaction, error: insertError } = await serviceClient
      .from("petty_cash_transactions")
      .insert({
        type,
        amount,
        description: description || null,
        staff_member_id: staff_member_id || null,
        staff_receipt_id: staff_receipt_id || null,
        document_id: document_id || null,
        receipt_image_url: receipt_image_url || null,
        dropbox_path: dropbox_path || null,
        registered_by: registeredBy,
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

    return NextResponse.json({
      transaction,
      balance: newBalance,
    })
  } catch (error) {
    console.error("小口現金取引登録エラー:", error)
    return NextResponse.json({ error: "取引の登録に失敗しました" }, { status: 500 })
  }
}

// 残高更新（手動調整）
export async function PATCH(request: NextRequest) {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as { balance: number }
    const { balance } = body

    if (typeof balance !== "number") {
      return NextResponse.json({ error: "balanceは数値で指定してください" }, { status: 400 })
    }

    const serviceClient = createServiceClient()

    const { data: settingsRaw, error: getError } = await serviceClient
      .from("petty_cash_settings")
      .select("id")
      .limit(1)
      .single()

    if (getError) throw getError
    const settings = settingsRaw as unknown as { id: string }

    const { error: updateError } = await serviceClient
      .from("petty_cash_settings")
      .update({ balance, updated_at: new Date().toISOString() })
      .eq("id", settings.id)

    if (updateError) throw updateError

    return NextResponse.json({ balance })
  } catch (error) {
    console.error("残高更新エラー:", error)
    return NextResponse.json({ error: "残高の更新に失敗しました" }, { status: 500 })
  }
}
