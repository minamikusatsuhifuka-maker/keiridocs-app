import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { analyzeDocument, analyzeDocumentFromText, applyAutoClassifyRules, DEFAULT_GEMINI_MODEL } from "@/lib/gemini"
import type { AutoClassifyRule } from "@/lib/gemini"
import mammoth from "mammoth"
import * as XLSX from "xlsx"
import Papa from "papaparse"

// 画像/PDFのMIMEタイプ（Base64でGeminiに直接送信）
const IMAGE_PDF_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/webp",
  "application/pdf",
]

// テキスト抽出が必要なMIMEタイプ
const DOCUMENT_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
  "text/csv", // .csv
]

const ALL_SUPPORTED_TYPES = [...IMAGE_PDF_TYPES, ...DOCUMENT_TYPES]

/**
 * ファイル名の拡張子からMIMEタイプを推定する（Content-Typeが不正確な場合のフォールバック）
 */
function guessMimeTypeFromFileName(fileName: string | undefined): string | null {
  if (!fileName) return null
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

/**
 * Word(.docx)からテキストを抽出
 */
async function extractTextFromDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer })
  return result.value
}

/**
 * Excel(.xlsx/.xls)からテキストを抽出
 */
function extractTextFromExcel(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: "buffer" })
  const texts: string[] = []

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    texts.push(`--- シート: ${sheetName} ---`)
    const csv = XLSX.utils.sheet_to_csv(sheet)
    texts.push(csv)
  }

  return texts.join("\n")
}

/**
 * CSVからテキストを抽出
 */
function extractTextFromCsv(text: string): string {
  const result = Papa.parse(text, { header: false })
  const rows = result.data as string[][]
  return rows.map((row) => row.join(", ")).join("\n")
}

// Gemini AI解析 API
export async function POST(request: NextRequest) {
  // 認証チェック
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as { base64: unknown; mimeType: unknown; fileName?: unknown }

    const { base64, fileName } = body
    let { mimeType } = body

    if (typeof base64 !== "string" || typeof mimeType !== "string") {
      return NextResponse.json(
        { error: "base64とmimeTypeは必須です" },
        { status: 400 }
      )
    }

    // ファイル名からMIMEタイプを補正（application/octet-streamなどの場合）
    if (!ALL_SUPPORTED_TYPES.includes(mimeType as string)) {
      const guessed = guessMimeTypeFromFileName(typeof fileName === "string" ? fileName : undefined)
      if (guessed) {
        mimeType = guessed
      }
    }

    // サポートされるMIMEタイプの検証
    if (!ALL_SUPPORTED_TYPES.includes(mimeType as string)) {
      return NextResponse.json(
        { error: "サポートされていないファイル形式です" },
        { status: 400 }
      )
    }

    // Base64サイズチェック（約10MB上限）
    const sizeInBytes = (base64.length * 3) / 4
    const maxSize = 10 * 1024 * 1024
    if (sizeInBytes > maxSize) {
      return NextResponse.json(
        { error: "ファイルサイズが10MBを超えています" },
        { status: 400 }
      )
    }

    // settingsからGeminiモデル設定を取得
    const { data: modelSetting } = await supabase
      .from("settings")
      .select("value")
      .eq("user_id", user.id)
      .eq("key", "gemini_model")
      .maybeSingle()

    const modelId = (typeof modelSetting?.value === "string" ? modelSetting.value : null) || DEFAULT_GEMINI_MODEL

    // settingsからdocument_typesを取得（種別判定に使う）
    const { data: docTypes } = await supabase
      .from("document_types")
      .select("name")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true })

    const documentTypes = docTypes?.map((t) => t.name)

    let result

    if (DOCUMENT_TYPES.includes(mimeType as string)) {
      // Word/Excel/CSV: テキストを抽出してからGeminiに送信
      const buffer = Buffer.from(base64, "base64")
      let extractedText: string

      if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        extractedText = await extractTextFromDocx(buffer)
      } else if (
        mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        mimeType === "application/vnd.ms-excel"
      ) {
        extractedText = extractTextFromExcel(buffer)
      } else {
        // CSV
        extractedText = extractTextFromCsv(buffer.toString("utf-8"))
      }

      if (!extractedText.trim()) {
        return NextResponse.json(
          { error: "ファイルからテキストを抽出できませんでした" },
          { status: 400 }
        )
      }

      // テキストが長すぎる場合は切り詰め（Geminiの入力制限を考慮）
      const maxTextLength = 30000
      const text = extractedText.length > maxTextLength
        ? extractedText.slice(0, maxTextLength)
        : extractedText

      result = await analyzeDocumentFromText(text, { modelId, documentTypes })
    } else {
      // 画像/PDF: 既存のBase64処理
      result = await analyzeDocument(base64, mimeType as string, { modelId, documentTypes })
    }

    // 自動仕分けルールを取得して適用（AIの判定より優先）
    const { data: classifyRules } = await supabase
      .from("auto_classify_rules")
      .select("keyword, document_type, priority, is_active")
      .eq("user_id", user.id)

    let finalResult = result
    if (classifyRules && classifyRules.length > 0) {
      const applied = applyAutoClassifyRules(result, classifyRules as AutoClassifyRule[])
      finalResult = { ...applied, model_used: result.model_used }
    }

    return NextResponse.json({
      data: finalResult,
      model_used: finalResult.model_used,
    })
  } catch (error) {
    console.error("Gemini API エラー:", error)
    return NextResponse.json(
      { error: "AI解析に失敗しました" },
      { status: 500 }
    )
  }
}
