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

// 支払項目を複数まとめて削除する（1リクエスト）。削除後、項目0件になった親メモも削除。
// POST /api/payment-memo-items/bulk-delete  body: { ids: string[] }
export async function POST(request: NextRequest) {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  let body: { ids?: unknown }
  try {
    body = (await request.json()) as { ids?: unknown }
  } catch {
    return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 })
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === "string")
    : []
  if (ids.length === 0) {
    return NextResponse.json({ error: "削除する項目を指定してください" }, { status: 400 })
  }

  try {
    const serviceClient = createServiceClient()

    // 親メモ特定のため削除前に memo_id を取得
    const { data: targets, error: getError } = await serviceClient
      .from("payment_memo_items")
      .select("memo_id")
      .in("id", ids)
    if (getError) throw getError

    const { error: delError } = await serviceClient
      .from("payment_memo_items")
      .delete()
      .in("id", ids)
    if (delError) throw delError

    // 影響を受けた親メモ（重複除去）が孤児なら削除
    const memoIds = Array.from(
      new Set((targets || []).map((t) => t.memo_id).filter((v): v is string => !!v))
    )
    await cleanupOrphanMemos(serviceClient, memoIds)

    return NextResponse.json({ ok: true, deleted: ids.length })
  } catch (error) {
    console.error("支払項目一括削除エラー:", error)
    return NextResponse.json({ error: "支払項目の一括削除に失敗しました" }, { status: 500 })
  }
}
