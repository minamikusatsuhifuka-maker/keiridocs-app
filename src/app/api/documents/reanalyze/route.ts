import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { DEFAULT_GEMINI_MODEL } from "@/lib/gemini"
import { reanalyzeDocument, type ReanalyzeResult } from "@/lib/sales-reanalyze"
import type { Database } from "@/types/database"

type DocumentRow = Database["public"]["Tables"]["documents"]["Row"]

/** 一括再解析は逐次処理のため長めのタイムアウトを確保 */
export const maxDuration = 300

/** Geminiレート制限回避のための1件ごとのウェイト（ミリ秒） */
const PER_DOC_WAIT_MS = 700

/**
 * 一括再解析 API
 * POST /api/documents/reanalyze   body: { ids: ["uuid1", ...] }
 * - 逐次処理＋各回ウェイトでGeminiレート制限を回避
 * - 1件失敗しても他は続行
 * - { results, successCount, failCount } を返す
 */
export async function POST(request: NextRequest) {
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

  let body: { ids?: unknown }
  try {
    body = await request.json() as { ids?: unknown }
  } catch {
    return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 })
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === "string") : []
  if (ids.length === 0) {
    return NextResponse.json({ error: "対象の書類IDがありません" }, { status: 400 })
  }

  // 対象書類を取得（adminは全件、staffは自分の書類のみ）
  let listQuery = supabase
    .from("documents")
    .select("id, dropbox_path, type")
    .in("id", ids)
  if (auth.role !== "admin") {
    listQuery = listQuery.eq("user_id", user.id)
  }
  const { data: docs, error: listError } = await listQuery
  if (listError) {
    console.error("一括再解析: 対象取得エラー:", listError)
    return NextResponse.json({ error: "対象書類の取得に失敗しました" }, { status: 500 })
  }

  const targets = (docs ?? []) as Pick<DocumentRow, "id" | "dropbox_path" | "type">[]
  if (targets.length === 0) {
    return NextResponse.json({ results: [], successCount: 0, failCount: 0 })
  }

  // モデル設定（DB設定 → 中央定数）
  const { data: modelSetting } = await supabase
    .from("settings")
    .select("value")
    .eq("user_id", user.id)
    .eq("key", "gemini_model")
    .maybeSingle()
  const modelId = (typeof modelSetting?.value === "string" ? modelSetting.value : null) || DEFAULT_GEMINI_MODEL

  // 逐次処理（レート制限回避のため並列にしない）
  const results: ReanalyzeResult[] = []
  for (let i = 0; i < targets.length; i++) {
    const result = await reanalyzeDocument(supabase, targets[i], modelId)
    results.push(result)
    // 最後の1件以外はウェイトを挟む
    if (i < targets.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, PER_DOC_WAIT_MS))
    }
  }

  const successCount = results.filter((r) => r.success).length
  const failCount = results.length - successCount

  return NextResponse.json({ results, successCount, failCount })
}
