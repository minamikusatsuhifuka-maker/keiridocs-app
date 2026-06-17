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

// メモ削除（紐づく支払項目は ON DELETE CASCADE で自動削除）
// DELETE /api/payment-memos/[id]
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const serviceClient = createServiceClient()
    const { error } = await serviceClient.from("payment_memos").delete().eq("id", id)
    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("支払いメモ削除エラー:", error)
    return NextResponse.json({ error: "支払いメモの削除に失敗しました" }, { status: 500 })
  }
}
