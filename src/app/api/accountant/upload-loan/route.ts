import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { ensureDropboxFolderExists, uploadFile } from "@/lib/dropbox"
import { analyzeDocument } from "@/lib/gemini"
import { createHash } from "crypto"

export const maxDuration = 120

const SUPPORTED_MIME_TYPES = [
  "image/jpeg", "image/jpg", "image/png",
  "image/heic", "image/webp", "application/pdf",
] as const

const LOAN_FOLDER = "/経理書類/融資関連"

function guessMimeType(fileName: string): string | null {
  const ext = fileName.split(".").pop()?.toLowerCase()
  switch (ext) {
    case "jpg": case "jpeg": return "image/jpeg"
    case "png": return "image/png"
    case "heic": return "image/heic"
    case "webp": return "image/webp"
    case "pdf": return "application/pdf"
    default: return null
  }
}

/**
 * AIの解析結果からファイルタイトルを生成
 * 例: "融資契約書_〇〇銀行_2026年05月.pdf"
 */
function buildLoanFileName(
  ocrResult: {
    vendor_name?: string | null
    description?: string | null
    issue_date?: string | null
    type?: string | null
  } | null,
  originalFileName: string
): string {
  const ext = originalFileName.includes(".")
    ? "." + originalFileName.split(".").pop()
    : ".pdf"

  // 書類種別ラベルの決定
  let docLabel = "融資書類"
  const desc = (ocrResult?.description ?? ocrResult?.type ?? "").toLowerCase()
  if (desc.includes("契約") || desc.includes("contract")) docLabel = "融資契約書"
  else if (desc.includes("返済") || desc.includes("償還") || desc.includes("repay")) docLabel = "返済予定表"
  else if (desc.includes("借入") || desc.includes("loan")) docLabel = "借入明細"
  else if (desc.includes("残高") || desc.includes("balance")) docLabel = "残高証明"
  else if (desc.includes("審査") || desc.includes("申込")) docLabel = "審査申込書"
  else if (desc.includes("保証") || desc.includes("guarantee")) docLabel = "保証書類"
  else if (desc.includes("決算") || desc.includes("financial")) docLabel = "決算書類"

  // 金融機関名
  const vendor = (ocrResult?.vendor_name ?? "").trim()
  const safeVendor = vendor
    ? vendor.replace(/[/\\:*?"<>|]/g, "_").substring(0, 20)
    : ""

  // 年月
  let yearMonth = ""
  if (ocrResult?.issue_date) {
    const d = new Date(ocrResult.issue_date)
    if (!isNaN(d.getTime())) {
      yearMonth = `_${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, "0")}月`
    }
  }
  if (!yearMonth) {
    const now = new Date()
    yearMonth = `_${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, "0")}月`
  }

  const vendorPart = safeVendor ? `_${safeVendor}` : ""
  const timestamp = Date.now().toString().slice(-5)
  return `${docLabel}${vendorPart}${yearMonth}_${timestamp}${ext}`
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "権限がありません" }, { status: 403 })
  }

  try {
    const body = await request.json() as {
      file: unknown
      filename: unknown
      contentType?: unknown
    }

    if (typeof body.file !== "string" || typeof body.filename !== "string") {
      return NextResponse.json({ error: "file と filename は必須です" }, { status: 400 })
    }

    let mimeType = typeof body.contentType === "string" ? body.contentType : ""
    if (!SUPPORTED_MIME_TYPES.includes(mimeType as typeof SUPPORTED_MIME_TYPES[number])) {
      const guessed = guessMimeType(body.filename)
      if (guessed) mimeType = guessed
    }
    if (!SUPPORTED_MIME_TYPES.includes(mimeType as typeof SUPPORTED_MIME_TYPES[number])) {
      return NextResponse.json(
        { error: "PDF・JPG・PNGのみ対応しています" },
        { status: 400 }
      )
    }

    // Base64デコード
    let base64Data = body.file
    const commaIdx = base64Data.indexOf(",")
    if (commaIdx >= 0 && commaIdx < 100) base64Data = base64Data.substring(commaIdx + 1)

    const fileBuffer = Buffer.from(base64Data, "base64")
    if (fileBuffer.length === 0) {
      return NextResponse.json({ error: "ファイルデータが空です" }, { status: 400 })
    }

    // 重複チェック（同じファイルは弾く）
    const fileHash = createHash("sha256").update(fileBuffer).digest("hex")

    // Gemini AIで書類を解析してタイトル生成に使う情報を抽出
    let ocrResult = null
    try {
      ocrResult = await analyzeDocument(base64Data, mimeType, {
        documentTypes: ["融資契約書", "返済予定表", "借入明細", "残高証明", "審査書類", "保証書類"],
      })
    } catch (e) {
      console.warn("[融資書類] AI解析失敗、ファイル名から生成します", e)
    }

    // AIが生成したタイトルでファイル名を決定
    const newFileName = buildLoanFileName(ocrResult, body.filename)

    // Dropboxフォルダを初回自動作成 → 以降は存在していてもOK
    await ensureDropboxFolderExists(LOAN_FOLDER)

    const dropboxPath = `${LOAN_FOLDER}/${newFileName}`

    let savedPath: string
    try {
      savedPath = await uploadFile(dropboxPath, fileBuffer)
      console.log(`[融資書類] 保存完了: ${savedPath}`)
    } catch (err) {
      return NextResponse.json(
        { error: `Dropbox保存失敗: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 }
      )
    }

    return NextResponse.json({
      fileName: newFileName,
      dropboxPath: savedPath,
      folder: LOAN_FOLDER,
      ocrSummary: {
        vendor: ocrResult?.vendor_name ?? null,
        date: ocrResult?.issue_date ?? null,
        description: ocrResult?.description ?? null,
      },
      fileHash,
    })
  } catch (error) {
    console.error("[融資書類] エラー:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "処理に失敗しました" },
      { status: 500 }
    )
  }
}
