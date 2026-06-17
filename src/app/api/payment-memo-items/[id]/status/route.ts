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

const ALLOWED_STATUS = ["未払い", "支払済み"] as const

// 支払項目の状態を切り替える（未払い⇄支払済み）
// PATCH /api/payment-memo-items/[id]/status  body: { payment_status: "未払い" | "支払済み" }
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  let body: { payment_status?: unknown }
  try {
    body = (await request.json()) as { payment_status?: unknown }
  } catch {
    return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 })
  }

  const newStatus = body.payment_status
  if (
    typeof newStatus !== "string" ||
    !ALLOWED_STATUS.includes(newStatus as (typeof ALLOWED_STATUS)[number])
  ) {
    return NextResponse.json({ error: "不正な支払状態です" }, { status: 400 })
  }

  try {
    const serviceClient = createServiceClient()
    const { data, error } = await serviceClient
      .from("payment_memo_items")
      .update({ payment_status: newStatus })
      .eq("id", id)
      .select()
      .single()
    if (error) throw error

    return NextResponse.json({ data })
  } catch (error) {
    console.error("支払状態更新エラー:", error)
    return NextResponse.json({ error: "支払状態の更新に失敗しました" }, { status: 500 })
  }
}
