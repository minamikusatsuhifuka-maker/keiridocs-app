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

// 支払項目を請求書(documents)と紐づける／解除する
// PATCH /api/payment-memo-items/[id]/link  body: { documentId: string | null }
//   documentId 指定 → linked_document_id をセット
//   documentId = null → 紐づけ解除
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

  let body: { documentId?: unknown }
  try {
    body = (await request.json()) as { documentId?: unknown }
  } catch {
    return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 })
  }

  const documentId = body.documentId
  if (documentId !== null && typeof documentId !== "string") {
    return NextResponse.json({ error: "documentId は文字列または null を指定してください" }, { status: 400 })
  }

  try {
    const serviceClient = createServiceClient()

    // 紐づけ指定時は対象documentsの存在を確認
    if (documentId) {
      const { data: doc, error: docError } = await serviceClient
        .from("documents")
        .select("id")
        .eq("id", documentId)
        .maybeSingle()
      if (docError) throw docError
      if (!doc) {
        return NextResponse.json({ error: "指定された請求書が見つかりません" }, { status: 404 })
      }
    }

    const { data, error } = await serviceClient
      .from("payment_memo_items")
      .update({ linked_document_id: documentId })
      .eq("id", id)
      .select()
      .single()
    if (error) throw error

    return NextResponse.json({ data })
  } catch (error) {
    console.error("支払いメモ紐づけ更新エラー:", error)
    return NextResponse.json({ error: "請求書の紐づけに失敗しました" }, { status: 500 })
  }
}
