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

// スタッフ領収書から小口現金出金を登録
export async function POST(request: NextRequest) {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as { staff_receipt_id: string }
    const { staff_receipt_id } = body

    if (!staff_receipt_id) {
      return NextResponse.json({ error: "staff_receipt_id は必須です" }, { status: 400 })
    }

    const serviceClient = createServiceClient()

    // 既に小口登録済みか確認
    const { data: existing } = await serviceClient
      .from("petty_cash_transactions")
      .select("id")
      .eq("staff_receipt_id", staff_receipt_id)
      .limit(1)

    if (existing && existing.length > 0) {
      return NextResponse.json({ error: "この領収書は既に小口現金に登録済みです" }, { status: 409 })
    }

    // 領収書情報を取得（staff_membersとJOIN）
    const { data: receipt, error: receiptError } = await serviceClient
      .from("staff_receipts")
      .select("*, staff_members!inner(name)")
      .eq("id", staff_receipt_id)
      .single()

    if (receiptError || !receipt) {
      return NextResponse.json({ error: "領収書が見つかりません" }, { status: 404 })
    }

    const receiptData = receipt as Record<string, unknown> & { staff_members: { name: string } }
    const amount = receiptData.amount as number | null
    if (!amount || amount <= 0) {
      return NextResponse.json({ error: "この領収書には金額が設定されていません" }, { status: 400 })
    }

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

    const settings = settingsRaw as { id: string; balance: number }
    const currentBalance = settings.balance ?? 0
    const newBalance = currentBalance - amount

    const staffName = receiptData.staff_members.name
    const storeName = receiptData.store_name as string | null
    const description = `${staffName}/${storeName || "不明"}`

    // 取引登録
    const { data: transaction, error: insertError } = await serviceClient
      .from("petty_cash_transactions")
      .insert({
        type: "出金",
        amount,
        description,
        staff_member_id: receiptData.staff_member_id as string,
        staff_receipt_id,
        dropbox_path: receiptData.dropbox_path as string | null,
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
    console.error("小口現金（領収書連携）エラー:", error)
    return NextResponse.json({ error: "小口現金への出金登録に失敗しました" }, { status: 500 })
  }
}
