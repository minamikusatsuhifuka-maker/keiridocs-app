import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createHash } from "crypto"
import { uploadFile, getDocumentPath } from "@/lib/dropbox"
import { analyzeDocument, analyzeDocumentFromText, applyAutoClassifyRules, DEFAULT_GEMINI_MODEL } from "@/lib/gemini"
import type { OcrResult, AutoClassifyRule } from "@/lib/gemini"
import mammoth from "mammoth"
import * as XLSX from "xlsx"
import Papa from "papaparse"
import type { Database } from "@/types/database"

type DocumentRow = Database["public"]["Tables"]["documents"]["Row"]

/** 画像/PDFのMIMEタイプ */
const IMAGE_PDF_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/webp",
  "application/pdf",
]

/** テキスト抽出が必要なMIMEタイプ */
const DOCUMENT_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
]

const ALL_SUPPORTED_TYPES = [...IMAGE_PDF_TYPES, ...DOCUMENT_TYPES]

/** ファイル名からMIMEタイプを推定 */
function guessMimeTypeFromFileName(fileName: string): string | null {
  const ext = fileName.split(".").pop()?.toLowerCase()
  switch (ext) {
    case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    case "xls": return "application/vnd.ms-excel"
    case "csv": return "text/csv"
    case "jpg": case "jpeg": return "image/jpeg"
    case "png": return "image/png"
    case "heic": return "image/heic"
    case "webp": return "image/webp"
    case "pdf": return "application/pdf"
    default: return null
  }
}

/** 一意なファイル名を生成 */
function generateUniqueFileName(
  vendorName: string | undefined,
  docType: string,
  date: Date,
  originalFileName: string
): string {
  let vendor = (vendorName || "不明").replace(/[/\\:*?"<>|]/g, "_")
  if (vendor.length > 20) vendor = vendor.substring(0, 20)

  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  const dateStr = `${y}${m}${d}`
  const timestamp = Date.now().toString().slice(-6)
  const dotIndex = originalFileName.lastIndexOf(".")
  const ext = dotIndex >= 0 ? originalFileName.substring(dotIndex) : ".jpg"

  return `${vendor}_${docType}_${dateStr}_${timestamp}${ext}`
}

/** 要確認の理由を判定 */
function checkReviewReasons(ocrResult: OcrResult): string[] {
  const reasons: string[] = []

  // AI確信度が80%未満
  if (ocrResult.confidence < 0.8) {
    reasons.push(`AI確信度${Math.round(ocrResult.confidence * 100)}%`)
  }

  // 書類種別が判定できない
  if (!ocrResult.type) {
    reasons.push("種別不明")
  }

  // 金額が0または未検出
  if (ocrResult.amount === null || ocrResult.amount === 0) {
    reasons.push("金額未検出")
  }

  // 取引先名が未検出
  if (!ocrResult.vendor_name || ocrResult.vendor_name.trim() === "") {
    reasons.push("取引先名未検出")
  }

  return reasons
}

/**
 * 全自動登録 API
 * 1ファイルの全自動登録を処理（AI解析 → 重複チェック → Dropbox保存 → DB登録）
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
    }

    const { file, filename, contentType } = body

    if (typeof file !== "string" || typeof filename !== "string" || typeof contentType !== "string") {
      return NextResponse.json(
        { error: "file, filename, contentType は必須です" },
        { status: 400 }
      )
    }

    // MIMEタイプ補正
    let mimeType = contentType
    if (!ALL_SUPPORTED_TYPES.includes(mimeType)) {
      const guessed = guessMimeTypeFromFileName(filename)
      if (guessed) mimeType = guessed
    }

    if (!ALL_SUPPORTED_TYPES.includes(mimeType)) {
      return NextResponse.json(
        { status: "error", error: "サポートされていないファイル形式です" },
        { status: 400 }
      )
    }

    // Base64サイズチェック（10MB上限）
    const sizeInBytes = (file.length * 3) / 4
    if (sizeInBytes > 10 * 1024 * 1024) {
      return NextResponse.json(
        { status: "error", error: "ファイルサイズが10MBを超えています" },
        { status: 400 }
      )
    }

    // --- 1. AI解析 ---
    // settingsからGeminiモデル設定を取得
    const { data: modelSetting } = await supabase
      .from("settings")
      .select("value")
      .eq("user_id", user.id)
      .eq("key", "gemini_model")
      .maybeSingle()

    const modelId = (typeof modelSetting?.value === "string" ? modelSetting.value : null) || DEFAULT_GEMINI_MODEL

    // document_typesを取得
    const { data: docTypes } = await supabase
      .from("document_types")
      .select("name")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true })

    const documentTypes = docTypes?.map((t) => t.name)

    let ocrResult: OcrResult & { model_used?: string }

    // Base64のdata URLプレフィックスを除去
    let base64Data = file
    const commaIndex = base64Data.indexOf(",")
    if (commaIndex >= 0 && commaIndex < 100) {
      base64Data = base64Data.substring(commaIndex + 1)
    }

    if (DOCUMENT_TYPES.includes(mimeType)) {
      // Word/Excel/CSV: テキスト抽出後にAI解析
      const buffer = Buffer.from(base64Data, "base64")
      let extractedText: string

      if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        extractedText = (await mammoth.extractRawText({ buffer })).value
      } else if (
        mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        mimeType === "application/vnd.ms-excel"
      ) {
        const workbook = XLSX.read(buffer, { type: "buffer" })
        extractedText = workbook.SheetNames.map((name) => {
          const sheet = workbook.Sheets[name]
          return `--- シート: ${name} ---\n${XLSX.utils.sheet_to_csv(sheet)}`
        }).join("\n")
      } else {
        const result = Papa.parse(buffer.toString("utf-8"), { header: false })
        extractedText = (result.data as string[][]).map((row) => row.join(", ")).join("\n")
      }

      if (!extractedText.trim()) {
        return NextResponse.json({
          status: "error",
          error: "ファイルからテキストを抽出できませんでした",
        })
      }

      const text = extractedText.length > 30000 ? extractedText.slice(0, 30000) : extractedText
      ocrResult = await analyzeDocumentFromText(text, { modelId, documentTypes })
    } else {
      ocrResult = await analyzeDocument(base64Data, mimeType, { modelId, documentTypes })
    }

    // 自動仕分けルール適用
    const { data: classifyRules } = await supabase
      .from("auto_classify_rules")
      .select("keyword, document_type, priority, is_active")
      .eq("user_id", user.id)

    if (classifyRules && classifyRules.length > 0) {
      const applied = applyAutoClassifyRules(ocrResult, classifyRules as AutoClassifyRule[])
      ocrResult = { ...applied, model_used: ocrResult.model_used }
    }

    // --- 2. ファイルハッシュ計算 ---
    const fileBuffer = Buffer.from(base64Data, "base64")
    const fileHash = createHash("sha256").update(fileBuffer).digest("hex")

    // --- 3. 重複チェック ---
    let duplicateReasons: string[] = []

    // ファイルハッシュ完全一致
    if (fileHash) {
      const { data: hashDups } = await supabase
        .from("documents")
        .select("id, vendor_name, amount, type, issue_date, due_date, file_hash, created_at")
        .eq("user_id", user.id)
        .eq("file_hash", fileHash)

      if (hashDups && hashDups.length > 0) {
        duplicateReasons.push("同一ファイルが既に登録済み")
      }
    }

    // メタデータ重複チェック
    if (duplicateReasons.length === 0 && ocrResult.vendor_name && ocrResult.type) {
      let dupQuery = supabase
        .from("documents")
        .select("id, vendor_name, amount, type, issue_date, due_date, file_hash, created_at")
        .eq("user_id", user.id)
        .eq("vendor_name", ocrResult.vendor_name)
        .eq("type", ocrResult.type)

      if (typeof ocrResult.amount === "number") {
        dupQuery = dupQuery.eq("amount", ocrResult.amount)
      }

      const { data: dupCandidates } = await dupQuery

      if (dupCandidates && dupCandidates.length > 0) {
        const matched = dupCandidates.filter((d) => {
          if (ocrResult.issue_date && d.issue_date === ocrResult.issue_date) return true
          if (ocrResult.due_date && d.due_date === ocrResult.due_date) return true
          return false
        })
        if (matched.length > 0) {
          duplicateReasons.push("重複の可能性あり")
        }
      }
    }

    // --- 4. 確信度・データ品質チェック ---
    const reviewReasons = checkReviewReasons(ocrResult)

    // 重複理由も統合
    const allReasons = [...reviewReasons, ...duplicateReasons]

    // --- 5. 要確認の場合は登録せずアラート情報を返す ---
    if (allReasons.length > 0) {
      return NextResponse.json({
        status: "needs_review",
        review_reasons: allReasons,
        ocr_result: ocrResult,
        filename,
      })
    }

    // --- 6. 問題なければDropboxアップロード + DB登録 ---
    const docType = ocrResult.type || "その他"
    const dateObj = ocrResult.issue_date ? new Date(ocrResult.issue_date) : new Date()
    const uniqueFileName = generateUniqueFileName(ocrResult.vendor_name, docType, dateObj, filename)
    const dropboxPath = getDocumentPath(docType, uniqueFileName, dateObj, "未処理")

    const resultPath = await uploadFile(dropboxPath, fileBuffer)

    // DB登録
    const { data: docData, error: docError } = await supabase
      .from("documents")
      .insert({
        type: docType,
        vendor_name: ocrResult.vendor_name,
        amount: ocrResult.amount,
        issue_date: ocrResult.issue_date,
        due_date: ocrResult.due_date,
        description: ocrResult.description,
        input_method: "upload",
        status: "未処理",
        dropbox_path: resultPath,
        ocr_raw: ocrResult as unknown as import("@/types/database").Json,
        tax_category: ocrResult.tax_category || "未判定",
        account_title: ocrResult.account_title || "",
        file_hash: fileHash,
        user_id: user.id,
      })
      .select()
      .single()

    if (docError) {
      console.error("全自動登録 DB挿入エラー:", docError)
      return NextResponse.json({
        status: "error",
        error: "書類の登録に失敗しました",
      })
    }

    // 明細行を保存
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
        console.error("全自動登録 明細行保存エラー:", itemError)
      }
    }

    return NextResponse.json({
      status: "registered",
      document: docData,
    })
  } catch (error) {
    console.error("全自動登録エラー:", error)
    return NextResponse.json({
      status: "error",
      error: error instanceof Error ? error.message : "全自動登録に失敗しました",
    })
  }
}
