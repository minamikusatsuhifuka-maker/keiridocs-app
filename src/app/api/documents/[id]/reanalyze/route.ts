import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { DEFAULT_GEMINI_MODEL } from "@/lib/gemini"
import { reanalyzeDocument } from "@/lib/sales-reanalyze"
import type { Database } from "@/types/database"

type DocumentRow = Database["public"]["Tables"]["documents"]["Row"]

/** Dropbox取得＋Gemini再解析でタイムアウトしないよう余裕を持たせる */
export const maxDuration = 120

/**
 * 個別再解析 API
 * POST /api/documents/[id]/reanalyze
 * - 指定IDのファイルをDropboxから取得し、現行Geminiモデルで再解析してDBを更新する
 * - 既存の新規登録フローは触らず、既存レコードのupdateとして動作する
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  // 権限チェック: admin or staff のみ（既存PATCHと同じ方式）
  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "編集権限がありません" }, { status: 403 })
  }

  // 対象書類を取得（adminは全件、staffは自分の書類のみ）
  let fetchQuery = supabase
    .from("documents")
    .select("id, dropbox_path, type")
    .eq("id", id)
  if (auth.role !== "admin") {
    fetchQuery = fetchQuery.eq("user_id", user.id)
  }
  const { data: doc, error: fetchError } = await fetchQuery.single()
  if (fetchError || !doc) {
    return NextResponse.json({ error: "書類が見つかりません" }, { status: 404 })
  }

  // モデル設定（DB設定 → 中央定数）
  const { data: modelSetting } = await supabase
    .from("settings")
    .select("value")
    .eq("user_id", user.id)
    .eq("key", "gemini_model")
    .maybeSingle()
  const modelId = (typeof modelSetting?.value === "string" ? modelSetting.value : null) || DEFAULT_GEMINI_MODEL

  const result = await reanalyzeDocument(
    supabase,
    doc as Pick<DocumentRow, "id" | "dropbox_path" | "type">,
    modelId
  )

  if (!result.success) {
    return NextResponse.json({ error: result.error || "再解析に失敗しました" }, { status: 500 })
  }

  // 更新後のレコードを返す
  const { data: updated } = await supabase
    .from("documents")
    .select("*")
    .eq("id", id)
    .single()

  return NextResponse.json({ data: updated, result })
}
