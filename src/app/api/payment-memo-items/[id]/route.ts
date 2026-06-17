import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { cleanupOrphanMemos } from "@/lib/payment-memo-cleanup"
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

// 支払項目を1件削除する。削除後、親メモの残り項目が0件なら親メモも削除。
// DELETE /api/payment-memo-items/[id]
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

    // 親メモ特定のため削除前に memo_id を取得
    const { data: target, error: getError } = await serviceClient
      .from("payment_memo_items")
      .select("memo_id")
      .eq("id", id)
      .maybeSingle()
    if (getError) throw getError

    const { error: delError } = await serviceClient
      .from("payment_memo_items")
      .delete()
      .eq("id", id)
    if (delError) throw delError

    // 親メモが孤児になったら削除
    if (target?.memo_id) {
      await cleanupOrphanMemos(serviceClient, [target.memo_id])
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("支払項目削除エラー:", error)
    return NextResponse.json({ error: "支払項目の削除に失敗しました" }, { status: 500 })
  }
}
