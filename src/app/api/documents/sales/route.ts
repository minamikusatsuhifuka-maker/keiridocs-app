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

/** Vercel Functionタイムアウト: 売上登録は最大300秒（リトライバックオフを許容するため） */
export const maxDuration = 300

/** ファイルごとのAI解析タイムアウト（ミリ秒）。30秒で打ち切ってフォールバック値を使う */
const AI_ANALYSIS_TIMEOUT_MS = 30000

/** ファイルサイズ上限: 20MB */
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024

/**
 * Promiseを指定ミリ秒でタイムアウトさせるヘルパー
 * タイムアウト時は fallback を返す（reject しない）
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[売上登録] ${label} タイムアウト (${ms}ms)`)
      resolve(fallback)
    }, ms)
  })
  try {
    const result = await Promise.race([promise, timeoutPromise])
    return result
  } finally {
    if (timer) clearTimeout(timer)
  }
}

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

/** ファイル名で安全に使える形に取引先名をサニタイズする（最大30文字、「不明」は使わない） */
function sanitizeVendorName(vendorName: string | null | undefined): string {
  if (!vendorName) return ""
  let v = vendorName.replace(/[/\\:*?"<>|]/g, "_").trim()
  if (v.length > 30) v = v.substring(0, 30)
  return v
}

/** ファイル名から拡張子を除いた部分を取り出す */
function fileNameWithoutExt(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".")
  const base = dotIndex > 0 ? fileName.substring(0, dotIndex) : fileName
  return base.trim()
}

/**
 * 元ファイル名から取引先名を推測抽出する
 *   - アンダースコア・ハイフン・スペース・括弧などで分割
 *   - 数字のみのパートはスキップし、最初の意味ある部分（2文字以上、文字を含む）を採用
 *   - 抽出できない場合はファイル名（拡張子除外）を最大30文字で返す
 *   - 「不明」のような汎用フォールバックは使わない
 *
 * 例:
 *   "MP20260316-992-MC000649642-01.pdf" → "MP20260316"
 *   "TEP(143000336)_南草津皮フ科_御中_精算情報_20260228.pdf" → "TEP"
 *   "payment_notification-156427442_2026-03-16_0100.pdf" → "payment"
 */
function extractVendorFromFileName(fileName: string): string {
  const base = fileNameWithoutExt(fileName)
  if (!base) return ""

  // 区切り文字: アンダースコア・ハイフン・スペース・各種括弧で分割
  const parts = base
    .split(/[_\-\s()（）\[\]【】]+/u)
    .map((p) => p.trim())
    .filter(Boolean)

  // 「意味ある」パート: 2文字以上で、純粋な数字でない（英字や日本語などを含む）
  const meaningful = parts.find((p) => p.length >= 2 && !/^\d+$/.test(p))
  if (meaningful) {
    return sanitizeVendorName(meaningful)
  }

  // 全パートが数字のみだった場合は、最初のパート or ファイル名全体を最大30文字で返す
  if (parts.length > 0) {
    return sanitizeVendorName(parts[0])
  }
  return sanitizeVendorName(base)
}

/**
 * 売上記録用のDropboxパスを生成する
 *   /経理書類/売上/{YYYY年MM月}/{取引先}_売上記録_{YYYYMMDD}_{6桁}.{ext}
 *
 * 取引先名のフォールバック順:
 *   1. 引数 vendorName
 *   2. 元ファイル名から推測抽出（アンダースコア・ハイフン区切りの最初の意味ある部分）
 *   3. ファイル名全体（拡張子除外、最大30文字）
 *   ※「不明」は使わない
 */
function buildSalesDropboxPath(
  vendorName: string | null | undefined,
  date: Date,
  originalFileName: string
): string {
  // 取引先名のフォールバック解決
  let vendor = sanitizeVendorName(vendorName)
  if (!vendor) vendor = extractVendorFromFileName(originalFileName)
  if (!vendor) vendor = sanitizeVendorName(fileNameWithoutExt(originalFileName))
  // それでも空ならファイル名のbasename由来のラベル（拡張子なしでも空の極端なケース）
  if (!vendor) vendor = "売上書類"

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

/** AI解析失敗時のフォールバック結果 */
const EMPTY_OCR_RESULT: OcrResult = {
  vendor_name: "",
  amount: null,
  issue_date: null,
  due_date: null,
  description: null,
  type: "売上記録",
  confidence: 0,
  tax_category: null,
  account_title: null,
  items: [],
}

/** 渡された任意のオブジェクトを安全にOcrResult形に整形する */
function coerceOcrResult(input: unknown): OcrResult {
  if (!input || typeof input !== "object") return EMPTY_OCR_RESULT
  const o = input as Record<string, unknown>
  const items = Array.isArray(o.items)
    ? o.items.map((item) => {
        const it = (item ?? {}) as Record<string, unknown>
        return {
          item_name: typeof it.item_name === "string" ? it.item_name : "",
          quantity: typeof it.quantity === "number" ? it.quantity : 1,
          unit_price: typeof it.unit_price === "number" ? it.unit_price : 0,
          amount: typeof it.amount === "number" ? it.amount : 0,
          category: typeof it.category === "string" ? it.category : "",
          tax_rate: typeof it.tax_rate === "string" ? it.tax_rate : "",
        }
      })
    : []
  return {
    vendor_name: typeof o.vendor_name === "string" ? o.vendor_name : "",
    amount: typeof o.amount === "number" ? o.amount : null,
    issue_date: typeof o.issue_date === "string" ? o.issue_date : null,
    due_date: typeof o.due_date === "string" ? o.due_date : null,
    description: typeof o.description === "string" ? o.description : null,
    type: typeof o.type === "string" ? o.type : "売上記録",
    confidence: typeof o.confidence === "number" ? o.confidence : 0,
    tax_category: typeof o.tax_category === "string" ? o.tax_category : null,
    account_title: typeof o.account_title === "string" ? o.account_title : null,
    items,
  }
}

/**
 * 売上登録 API
 * - mode="analyze": Gemini AIで売上情報を解析（プレビュー用）
 * - mode="register": Dropbox保存→DB登録（種別="売上記録"）
 *   - フロントから ocr_result が渡されればそれを使い、AI再解析はスキップ（Gemini RPM節約）
 *   - 渡されない場合のみAI解析を実行。AI解析が失敗してもDropbox/DB登録は続行する
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
      vendor_name?: unknown
      amount?: unknown
      issue_date?: unknown
      description?: unknown
      mode?: unknown
      ocr_result?: unknown
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

    // サイズチェック（20MB超は処理スキップ。エラーではなくskipped扱いで返す）
    const sizeInBytes = (base64Data.length * 3) / 4
    if (sizeInBytes > MAX_FILE_SIZE_BYTES) {
      const sizeMB = (sizeInBytes / 1024 / 1024).toFixed(1)
      console.warn(`[売上登録] サイズ超過のためスキップ: ${filename} = ${sizeMB}MB`)
      return NextResponse.json({
        skipped: true,
        filename,
        reason: `ファイルサイズが20MBを超えています（${sizeMB}MB）。PDFは圧縮またはページ分割してください`,
      })
    }

    console.log(`[売上登録] mode=${mode} filename=${filename} mimeType=${mimeType} size=${(sizeInBytes / 1024).toFixed(1)}KB`)

    // --- AI解析（必要な場合のみ実行） ---
    let ocrResult: OcrResult = EMPTY_OCR_RESULT
    let aiAnalysisFailed = false
    let aiErrorMessage: string | null = null

    // フロントから事前解析済みのOCR結果が渡されていればそれを使う（registerモード時の再解析を回避）
    const providedOcr = mode === "register" ? coerceOcrResult(body.ocr_result) : null
    const hasProvidedOcr = providedOcr !== null && (
      providedOcr.vendor_name ||
      providedOcr.amount !== null ||
      providedOcr.issue_date ||
      providedOcr.description ||
      providedOcr.items.length > 0
    )

    if (hasProvidedOcr && providedOcr) {
      ocrResult = providedOcr
      console.log(`[売上登録] フロント提供のOCR結果を使用: ${filename}`)
    } else {
      // settingsからGeminiモデル設定を取得
      const { data: modelSetting } = await supabase
        .from("settings")
        .select("value")
        .eq("user_id", user.id)
        .eq("key", "gemini_model")
        .maybeSingle()

      const modelId = (typeof modelSetting?.value === "string" ? modelSetting.value : null) || DEFAULT_GEMINI_MODEL
      const documentTypes = ["売上記録", "領収書", "請求書"]

      // 売上登録専用の解析オプション（振込元・振込日・振込金額を必ず抽出）
      const salesAnalysisOpts = {
        modelId,
        documentTypes,
        extraHint: `
この書類は売上・振込に関する書類です。以下の情報を最優先で正確に抽出してください：
- vendor_name: 振込元の会社名・法人名（個人名でなく法人名を優先）
- amount: 振込金額のトータル合計（税込み総額）。明細の個別金額ではなく合計額
- issue_date: 振込日または売上日（YYYY-MM-DD形式）
- transfer_from: 振込元会社名（vendor_nameと同じ値でよい）
- transfer_date: 振込日（YYYY-MM-DD形式、issue_dateと同じ値でよい）
- transfer_total: 振込金額トータル（amountと同じ値でよい）
- description: 取引内容・サービス名の説明
金額が複数ある場合は最も大きい合計金額を採用してください。
`,
      }

      try {
        // ファイルごとのAI解析タイムアウト30秒（リトライ含む）
        const result = await withTimeout(
          analyzeDocument(base64Data, mimeType, salesAnalysisOpts),
          AI_ANALYSIS_TIMEOUT_MS,
          { ...EMPTY_OCR_RESULT, model_used: modelId } as OcrResult & { model_used?: string },
          `AI解析(${filename})`
        )
        ocrResult = result
        if (result.confidence === 0 && !result.vendor_name && result.amount === null) {
          // FALLBACK_RESULT が返された場合は実質失敗
          aiAnalysisFailed = true
          aiErrorMessage = "AI解析の結果が空でした（タイムアウトまたはレート制限）"
          console.warn(`[売上登録] AI解析結果が空: ${filename}`)
        }
      } catch (aiError) {
        // analyzeDocumentは内部でtry-catchしているので通常ここには来ないが、保険として
        aiAnalysisFailed = true
        aiErrorMessage = aiError instanceof Error ? aiError.message : String(aiError)
        ocrResult = EMPTY_OCR_RESULT
        console.error(`[売上登録] AI解析で例外: ${filename}`, aiError)
      }
    }

    // モードが解析のみなら結果を返して終了
    if (mode === "analyze") {
      return NextResponse.json({
        data: ocrResult,
        filename,
        ai_failed: aiAnalysisFailed,
        ai_error: aiErrorMessage,
      })
    }

    // --- 登録モード: ユーザー編集値があればOCR結果に上書き ---
    const finalVendorName = typeof body.vendor_name === "string" && body.vendor_name.trim()
      ? body.vendor_name.trim()
      : (ocrResult.vendor_name || "")

    // 金額: ユーザー編集値 → OCR結果 → AI失敗時は0で登録継続
    let finalAmount: number | null
    if (typeof body.amount === "number" && !isNaN(body.amount)) {
      finalAmount = body.amount
    } else if (typeof body.amount === "string" && body.amount.trim()) {
      const parsed = Number(body.amount)
      finalAmount = isNaN(parsed) ? 0 : parsed
    } else if (typeof ocrResult.amount === "number") {
      finalAmount = ocrResult.amount
    } else {
      // AI解析失敗時のフォールバック: 0を入れて登録継続
      finalAmount = 0
    }

    const finalIssueDate = typeof body.issue_date === "string" && body.issue_date.trim()
      ? body.issue_date.trim()
      : ocrResult.issue_date

    const finalDescription = typeof body.description === "string" && body.description.trim()
      ? body.description.trim()
      : (ocrResult.description || "")

    // 取引先名のフォールバック順:
    //   1. ユーザー編集 or AI解析結果
    //   2. ファイル名から意味あるパートを抽出
    //   3. ファイル名全体（拡張子除外、最大30文字）
    //   ※「不明」は使わない
    let vendorForRecord = sanitizeVendorName(finalVendorName)
    if (!vendorForRecord) vendorForRecord = extractVendorFromFileName(filename)
    if (!vendorForRecord) vendorForRecord = sanitizeVendorName(fileNameWithoutExt(filename))
    if (!vendorForRecord) vendorForRecord = "売上書類"

    // --- ファイルハッシュ ---
    const fileBuffer = Buffer.from(base64Data, "base64")
    if (fileBuffer.length === 0) {
      return NextResponse.json(
        { error: "ファイルデータが空です" },
        { status: 400 }
      )
    }
    const fileHash = createHash("sha256").update(fileBuffer).digest("hex")

    // --- 重複チェック（同一ファイルハッシュがDBに存在する場合はスキップ） ---
    const { data: existingDoc } = await supabase
      .from("documents")
      .select("id, dropbox_path, vendor_name, issue_date")
      .eq("file_hash", fileHash)
      .eq("type", "売上記録")
      .maybeSingle()

    if (existingDoc) {
      console.log(`[売上登録] 重複検知のためスキップ: ${filename} → 既存id=${existingDoc.id}`)
      return NextResponse.json({
        skipped: true,
        filename,
        reason: `同じファイルがすでに登録済みです（取引先: ${existingDoc.vendor_name}、日付: ${existingDoc.issue_date ?? "不明"}）`,
        existing_id: existingDoc.id,
        dropbox_path: existingDoc.dropbox_path,
      })
    }

    // --- Dropbox保存 ---
    const dateObj = finalIssueDate ? new Date(finalIssueDate) : new Date()
    const safeDate = isNaN(dateObj.getTime()) ? new Date() : dateObj

    const dropboxPath = buildSalesDropboxPath(vendorForRecord, safeDate, filename)

    let resultPath: string
    try {
      const folderPath = dropboxPath.substring(0, dropboxPath.lastIndexOf("/"))
      await ensureDropboxFolderExists(folderPath)
      resultPath = await uploadFile(dropboxPath, fileBuffer)
      console.log(`[売上登録] Dropbox保存成功: ${resultPath}`)
    } catch (dropboxError) {
      console.error(`[売上登録] Dropbox保存失敗: ${filename}`, dropboxError)
      return NextResponse.json(
        {
          error: `Dropbox保存に失敗しました: ${dropboxError instanceof Error ? dropboxError.message : String(dropboxError)}`,
        },
        { status: 500 }
      )
    }

    // --- DB登録（種別="売上記録"固定） ---
    // AI解析が失敗していてもDropbox保存は完了している。fallback値で必ずDB登録する
    // document_staff_id / registrant_id は送信しない（NULL扱い）
    const safeAmount = typeof finalAmount === "number" && !isNaN(finalAmount) ? finalAmount : 0
    const insertPayload = {
      type: "売上記録",
      vendor_name: vendorForRecord,
      amount: safeAmount,
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
      user_id: user.id,
    }

    const { data: docData, error: docError } = await supabase
      .from("documents")
      .insert(insertPayload)
      .select()
      .single()

    if (docError) {
      console.error(`[売上登録] DB挿入エラー: ${filename}`, {
        message: docError.message,
        code: docError.code,
        details: docError.details,
        hint: docError.hint,
        payload_keys: Object.keys(insertPayload),
      })
      return NextResponse.json(
        {
          error: `DB登録に失敗しました: ${docError.message || "不明なエラー"}`,
          details: docError.details,
          dropbox_path: resultPath,
        },
        { status: 500 }
      )
    }

    console.log(`[売上登録] DB登録成功: ${filename} → id=${(docData as DocumentRow | null)?.id}`)

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
        console.warn(`[売上登録] 明細行保存エラー: ${filename}`, itemError)
        // 明細失敗は無視（書類本体は登録済み）
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
      ai_failed: aiAnalysisFailed,
      ai_error: aiErrorMessage,
    })
  } catch (error) {
    console.error("[売上登録] 想定外エラー:", error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "売上の登録に失敗しました",
      },
      { status: 500 }
    )
  }
}
