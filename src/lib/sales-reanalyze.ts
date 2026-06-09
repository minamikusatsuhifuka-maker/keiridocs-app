// 売上書類の再解析ロジック（個別・一括APIで共用）
import { createClient } from "@/lib/supabase/server"
import { downloadFile, DropboxFileNotFoundError } from "@/lib/dropbox"
import {
  analyzeDocument,
  DEFAULT_GEMINI_MODEL,
  SALES_ANALYSIS_DOCUMENT_TYPES,
  SALES_ANALYSIS_EXTRA_HINT,
} from "@/lib/gemini"
import type { Database, Json } from "@/types/database"

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>
type DocumentRow = Database["public"]["Tables"]["documents"]["Row"]

/** 再解析に必要な最小限のドキュメント情報 */
export type ReanalyzeTargetDoc = Pick<DocumentRow, "id" | "dropbox_path" | "type">

/** 再解析の失敗理由（ファイル欠損を他の失敗と区別する） */
export type ReanalyzeFailReason = "file_not_found" | "empty" | "unsupported" | "error"

/** 再解析の結果（一括APIのresults配列にも使う） */
export interface ReanalyzeResult {
  id: string
  success: boolean
  amount: number | null
  vendor_name: string | null
  error?: string
  /** 失敗時の理由区分（成功時は undefined） */
  reason?: ReanalyzeFailReason
}

/** ファイルパスの拡張子からMIMEタイプを推定する（Dropboxのcontent-typeが不正確な場合の保険） */
function guessMimeTypeFromPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase()
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "png":
      return "image/png"
    case "heic":
      return "image/heic"
    case "webp":
      return "image/webp"
    case "pdf":
      return "application/pdf"
    default:
      return null
  }
}

/** Geminiが解析可能なMIMEタイプか */
const ANALYZABLE_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/webp",
  "application/pdf",
]

/**
 * 1件のドキュメントをDropboxから取得し、現行Geminiモデルで再解析してDBを更新する。
 * - 抽出できた値のみ上書きする（空・nullの結果で既存の良いデータを壊さない）
 * - ocr_raw は常に新しい結果で更新（model_used が現行モデルになる）
 *
 * @returns 成否・抽出した金額・取引先名
 */
export async function reanalyzeDocument(
  supabase: SupabaseServerClient,
  doc: ReanalyzeTargetDoc,
  modelId: string
): Promise<ReanalyzeResult> {
  try {
    if (!doc.dropbox_path) {
      return { id: doc.id, success: false, amount: null, vendor_name: null, error: "Dropboxパスがありません", reason: "error" }
    }

    // Dropboxからファイルを取得
    const { buffer, mimeType: dlMimeType } = await downloadFile(doc.dropbox_path)
    if (!buffer || buffer.length === 0) {
      return { id: doc.id, success: false, amount: null, vendor_name: null, error: "ファイルが空です", reason: "error" }
    }

    // MIMEタイプ確定（Dropboxのcontent-typeが解析不可ならパス拡張子から推定）
    let mimeType = dlMimeType
    if (!ANALYZABLE_MIME_TYPES.includes(mimeType)) {
      const guessed = guessMimeTypeFromPath(doc.dropbox_path)
      if (guessed) mimeType = guessed
    }
    if (!ANALYZABLE_MIME_TYPES.includes(mimeType)) {
      return { id: doc.id, success: false, amount: null, vendor_name: null, error: `非対応の形式です（${mimeType}）`, reason: "unsupported" }
    }

    const base64Data = buffer.toString("base64")

    // 売上向けの解析オプション（新規登録と同一のextraHint）
    const result = await analyzeDocument(base64Data, mimeType, {
      modelId,
      documentTypes: [...SALES_ANALYSIS_DOCUMENT_TYPES],
      extraHint: SALES_ANALYSIS_EXTRA_HINT,
    })

    // 解析が実質失敗（空）なら更新しない
    const isEmpty = result.confidence === 0 && !result.vendor_name && result.amount === null
    if (isEmpty) {
      return { id: doc.id, success: false, amount: null, vendor_name: null, error: "AI解析の結果が空でした", reason: "empty" }
    }

    // 抽出できた値のみ上書き（既存の良いデータを壊さない）。ocr_rawは常に更新
    const update: Database["public"]["Tables"]["documents"]["Update"] = {
      ocr_raw: result as unknown as Json,
    }
    if (result.amount !== null) update.amount = result.amount
    if (result.vendor_name) update.vendor_name = result.vendor_name
    if (result.issue_date) update.issue_date = result.issue_date
    if (result.description) update.description = result.description
    if (result.tax_category) update.tax_category = result.tax_category
    if (result.account_title) update.account_title = result.account_title
    // 支払方法・振込先は再解析で常に更新（不明→振込判定への更新を可能にする）
    update.payment_method = result.payment_method || "unknown"
    update.bank_info = (result.bank_info ?? null) as unknown as Json

    const { error: updateError } = await supabase
      .from("documents")
      .update(update)
      .eq("id", doc.id)

    if (updateError) {
      return { id: doc.id, success: false, amount: null, vendor_name: null, error: updateError.message }
    }

    return {
      id: doc.id,
      success: true,
      amount: result.amount,
      vendor_name: result.vendor_name || null,
    }
  } catch (error) {
    // ファイル欠損は専用reasonで区別し、ユーザー向けの分かりやすいメッセージを返す
    if (error instanceof DropboxFileNotFoundError) {
      return {
        id: doc.id,
        success: false,
        amount: null,
        vendor_name: null,
        error: "ファイルがDropboxに見つかりません。削除・移動された可能性があります。原本を再アップロードしてください。",
        reason: "file_not_found",
      }
    }
    return {
      id: doc.id,
      success: false,
      amount: null,
      vendor_name: null,
      error: error instanceof Error ? error.message : String(error),
      reason: "error",
    }
  }
}
