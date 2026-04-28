import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createHash } from "crypto"
import { uploadFile, ensureDropboxFolderExists } from "@/lib/dropbox"
import { analyzeDocument, DEFAULT_GEMINI_MODEL } from "@/lib/gemini"
import type { OcrResult } from "@/lib/gemini"
import type { Database } from "@/types/database"

type DocumentRow = Database["public"]["Tables"]["documents"]["Row"]

/** 売上登録で受け付けるMIMEタイプ（JPG/PNG/PDF） */
const SUPPORTED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/webp",
  "application/pdf",
] as const

/** ファイル名から拡張子を推定したMIMEタイプを返す */
function guessMimeTypeFromFileName(fileName: string): string | null {
  const ext = fileName.split(".").pop()?.toLowerCase()
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

/** ファイル名で安全に使える形に取引先名をサニタイズする */
function sanitizeVendorName(vendorName: string | null | undefined): string {
  let v = (vendorName || "不明").replace(/[/\\:*?"<>|]/g, "_").trim()
  if (v.length > 20) v = v.substring(0, 20)
  if (!v) v = "不明"
  return v
}

/**
 * 売上記録用のDropboxパスを生成する
 *   /経理書類/売上/{YYYY年MM月}/{取引先}_売上記録_{YYYYMMDD}_{6桁}.{ext}
 */
function buildSalesDropboxPath(
  vendorName: string | null | undefined,
  date: Date,
  originalFileName: string
): string {
  const vendor = sanitizeVendorName(vendorName)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  const yearMonthFolder = `${y}年${m}月`
  const dateStr = `${y}${m}${d}`
  const timestamp = Date.now().toString().slice(-6)
  const dotIndex = originalFileName.lastIndexOf(".")
  const ext = dotIndex >= 0 ? originalFileName.substring(dotIndex) : ".jpg"

  const fileName = `${vendor}_売上記録_${dateStr}_${timestamp}${ext}`
  return `/経理書類/売上/${yearMonthFolder}/${fileName}`
}

/**
 * 売上登録 API
 * - GET: ファイルを受け取りGemini AIで売上情報を解析（プレビュー用）
 * - POST: ファイルを受け取り、AI解析→Dropbox保存→DB登録（種別="売上記録"）まで一気通貫で行う
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as {
      file: unknown
      filename: unknown
      contentType: unknown
      // プレビュー時にユーザーが編集した値（指定があれば優先）
      vendor_name?: unknown
      amount?: unknown
      issue_date?: unknown
      description?: unknown
      // モード: "analyze"=AI解析のみ / "register"=登録（デフォルト）
      mode?: unknown
      registrant_id?: unknown
    }

    const { file, filename, contentType } = body
    const mode = body.mode === "analyze" ? "analyze" : "register"

    if (typeof file !== "string" || typeof filename !== "string" || typeof contentType !== "string") {
      return NextResponse.json(
        { error: "file, filename, contentTypeは必須です" },
        { status: 400 }
      )
    }

    // MIMEタイプの補正（JPG/PNG/PDFのみ受け付け）
    let mimeType = contentType
    if (!SUPPORTED_MIME_TYPES.includes(mimeType as typeof SUPPORTED_MIME_TYPES[number])) {
      const guessed = guessMimeTypeFromFileName(filename)
      if (guessed) mimeType = guessed
    }

    if (!SUPPORTED_MIME_TYPES.includes(mimeType as typeof SUPPORTED_MIME_TYPES[number])) {
      return NextResponse.json(
        { error: "JPG/PNG/PDFのみ対応しています" },
        { status: 400 }
      )
    }

    // Base64プレフィックス除去
    let base64Data = file
    const commaIndex = base64Data.indexOf(",")
    if (commaIndex >= 0 && commaIndex < 100) {
      base64Data = base64Data.substring(commaIndex + 1)
    }

    // サイズチェック（10MB上限）
    const sizeInBytes = (base64Data.length * 3) / 4
    if (sizeInBytes > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: "ファイルサイズが10MBを超えています" },
        { status: 400 }
      )
    }

    // --- AI解析 ---
    // settingsからGeminiモデル設定を取得
    const { data: modelSetting } = await supabase
      .from("settings")
      .select("value")
      .eq("user_id", user.id)
      .eq("key", "gemini_model")
      .maybeSingle()

    const modelId = (typeof modelSetting?.value === "string" ? modelSetting.value : null) || DEFAULT_GEMINI_MODEL

    // 売上記録向けに「売上記録/領収書/請求書」を候補として渡す
    const documentTypes = ["売上記録", "領収書", "請求書"]

    const ocrResult: OcrResult & { model_used?: string } = await analyzeDocument(
      base64Data,
      mimeType,
      { modelId, documentTypes }
    )

    // モードが解析のみなら結果を返して終了
    if (mode === "analyze") {
      return NextResponse.json({
        data: ocrResult,
        filename,
      })
    }

    // --- 登録モード: ユーザー編集値があればOCR結果に上書き ---
    const finalVendorName = typeof body.vendor_name === "string" && body.vendor_name.trim()
      ? body.vendor_name.trim()
      : (ocrResult.vendor_name || "")

    const finalAmount = typeof body.amount === "number"
      ? body.amount
      : (typeof body.amount === "string" && body.amount.trim() ? Number(body.amount) : ocrResult.amount)

    const finalIssueDate = typeof body.issue_date === "string" && body.issue_date.trim()
      ? body.issue_date.trim()
      : ocrResult.issue_date

    const finalDescription = typeof body.description === "string" && body.description.trim()
      ? body.description.trim()
      : (ocrResult.description || "")

    const registrantId = typeof body.registrant_id === "string" ? body.registrant_id : null

    // --- ファイルハッシュ ---
    const fileBuffer = Buffer.from(base64Data, "base64")
    if (fileBuffer.length === 0) {
      return NextResponse.json(
        { error: "ファイルデータが空です" },
        { status: 400 }
      )
    }
    const fileHash = createHash("sha256").update(fileBuffer).digest("hex")

    // --- Dropbox保存 ---
    const dateObj = finalIssueDate ? new Date(finalIssueDate) : new Date()
    // 不正な日付の場合は今日を使う
    const safeDate = isNaN(dateObj.getTime()) ? new Date() : dateObj

    const dropboxPath = buildSalesDropboxPath(finalVendorName, safeDate, filename)

    // /経理書類/売上/{YYYY年MM月}/ フォルダを事前作成
    const folderPath = dropboxPath.substring(0, dropboxPath.lastIndexOf("/"))
    await ensureDropboxFolderExists(folderPath)

    const resultPath = await uploadFile(dropboxPath, fileBuffer)

    // --- DB登録（種別="売上記録"固定） ---
    const { data: docData, error: docError } = await supabase
      .from("documents")
      .insert({
        type: "売上記録",
        vendor_name: finalVendorName || "不明",
        amount: typeof finalAmount === "number" && !isNaN(finalAmount) ? finalAmount : null,
        issue_date: finalIssueDate || null,
        due_date: null,
        description: finalDescription || null,
        input_method: "upload",
        status: "未処理",
        dropbox_path: resultPath,
        ocr_raw: ocrResult as unknown as import("@/types/database").Json,
        tax_category: ocrResult.tax_category || "未判定",
        account_title: ocrResult.account_title || "",
        file_hash: fileHash,
        registrant_id: registrantId,
        user_id: user.id,
      })
      .select()
      .single()

    if (docError) {
      console.error("売上登録 DB挿入エラー:", docError)
      return NextResponse.json(
        { error: "売上の登録に失敗しました" },
        { status: 500 }
      )
    }

    // --- 明細行を保存（OCR結果のitemsがあれば） ---
    const docId = (docData as DocumentRow | null)?.id
    if (Array.isArray(ocrResult.items) && ocrResult.items.length > 0 && docId) {
      const itemRows = ocrResult.items.map((item) => ({
        document_id: docId,
        user_id: user.id,
        item_name: item.item_name || "",
        quantity: item.quantity || 1,
        unit_price: item.unit_price || 0,
        amount: item.amount || 0,
        category: item.category || "",
        tax_rate: item.tax_rate || "",
        notes: "",
      }))

      const { error: itemError } = await supabase
        .from("document_items")
        .insert(itemRows)

      if (itemError) {
        console.error("売上登録 明細行保存エラー:", itemError)
        // 明細失敗は無視
      }
    }

    // 保存先フォルダ表示用の年月文字列
    const y = safeDate.getFullYear()
    const m = String(safeDate.getMonth() + 1).padStart(2, "0")
    const yearMonthLabel = `${y}年${m}月`

    return NextResponse.json({
      data: docData,
      dropbox_path: resultPath,
      year_month: yearMonthLabel,
      ocr_result: ocrResult,
    })
  } catch (error) {
    console.error("売上登録エラー:", error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "売上の登録に失敗しました",
      },
      { status: 500 }
    )
  }
}
