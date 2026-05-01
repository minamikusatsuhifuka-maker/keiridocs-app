import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createHash } from "crypto"
import { uploadFile, ensureDropboxFolderExists } from "@/lib/dropbox"
import { analyzeDocument } from "@/lib/gemini"
import { sendRefundAlert, type RefundAlertItem } from "@/lib/resend"
import { getCurrentUserRole } from "@/lib/auth"
import type { Json } from "@/types/database"

export const maxDuration = 120

const SUPPORTED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/webp",
  "application/pdf",
] as const

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

// 返金書類専用のAI解析プロンプト
const REFUND_PROMPT_HINT = `
この書類は継続的役務契約の解約・返金に関する書類です。
以下の情報を最優先で抽出してください：
- vendor_name: 患者名または顧客名
- amount: 返金金額（円）
- issue_date: 解約日（YYYY-MM-DD形式）
- due_date: 返金予定日（YYYY-MM-DD形式）
- description: 契約内容・サービス名と担当者名を含む詳細説明
- type: "返金"固定
`

/**
 * 返金登録API
 * mode: "analyze" のときはAI解析のみ実行（DB登録・Dropbox保存・メール送信なし）
 * mode未指定 or それ以外のときは:
 *   1. Gemini AIで返金情報を解析
 *   2. Dropbox /経理書類/返金/{YYYY年MM月}/ に保存
 *   3. refund_recordsテーブルに登録
 *   4. notify_recipientsの宛先にアラートメール送信
 */
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
      contentType: unknown
      mode?: unknown
      // フロントから上書き値が渡される場合
      patient_name?: unknown
      amount?: unknown
      cancel_date?: unknown
      refund_date?: unknown
      service_name?: unknown
      staff_name?: unknown
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
      return NextResponse.json({ error: "JPG/PNG/PDFのみ対応しています" }, { status: 400 })
    }

    // Base64デコード
    let base64Data = body.file
    const commaIdx = base64Data.indexOf(",")
    if (commaIdx >= 0 && commaIdx < 100) base64Data = base64Data.substring(commaIdx + 1)

    const fileBuffer = Buffer.from(base64Data, "base64")
    if (fileBuffer.length === 0) {
      return NextResponse.json({ error: "ファイルデータが空です" }, { status: 400 })
    }

    const fileHash = createHash("sha256").update(fileBuffer).digest("hex")

    const isAnalyzeOnly = body.mode === "analyze"

    // 重複チェック（解析モードでも先に通知）
    const { data: existing } = await supabase
      .from("refund_records")
      .select("id, patient_name, cancel_date")
      .eq("file_hash", fileHash)
      .maybeSingle()

    if (existing) {
      return NextResponse.json({
        skipped: true,
        reason: `同じファイルがすでに登録済みです（患者名: ${existing.patient_name ?? "不明"}）`,
        existing_id: existing.id,
      })
    }

    // Gemini AI解析（返金書類専用プロンプト）
    let ocrResult
    try {
      ocrResult = await analyzeDocument(base64Data, mimeType, {
        documentTypes: ["返金", "解約", "領収書"],
        extraHint: REFUND_PROMPT_HINT,
      })
    } catch {
      ocrResult = null
    }

    // 解析モード: AI解析結果のみ返却
    if (isAnalyzeOnly) {
      return NextResponse.json({
        ocr_result: ocrResult,
        file_hash: fileHash,
      })
    }

    // フロント上書き値 or AI解析結果
    const patientName = typeof body.patient_name === "string" && body.patient_name.trim()
      ? body.patient_name.trim()
      : (ocrResult?.vendor_name ?? null)

    const amount = typeof body.amount === "number" && !isNaN(body.amount)
      ? body.amount
      : (typeof ocrResult?.amount === "number" ? ocrResult.amount : null)

    const cancelDate = typeof body.cancel_date === "string" && body.cancel_date.trim()
      ? body.cancel_date.trim()
      : (ocrResult?.issue_date ?? null)

    const refundDate = typeof body.refund_date === "string" && body.refund_date.trim()
      ? body.refund_date.trim()
      : (ocrResult?.due_date ?? null)

    const serviceName = typeof body.service_name === "string" && body.service_name.trim()
      ? body.service_name.trim()
      : null

    const staffName = typeof body.staff_name === "string" && body.staff_name.trim()
      ? body.staff_name.trim()
      : null

    // Dropbox保存
    const now = new Date()
    const refDateObj = cancelDate ? new Date(cancelDate) : now
    const safeDate = isNaN(refDateObj.getTime()) ? now : refDateObj
    const y = safeDate.getFullYear()
    const m = String(safeDate.getMonth() + 1).padStart(2, "0")
    const folderPath = `/経理書類/返金/${y}年${m}月`
    await ensureDropboxFolderExists(folderPath)

    const ext = body.filename.includes(".") ? body.filename.split(".").pop() : "pdf"
    const safePatient = (patientName ?? "不明").replace(/[/\\:*?"<>|]/g, "_").substring(0, 20)
    const timestamp = Date.now().toString().slice(-6)
    const dropboxFileName = `返金_${safePatient}_${y}${m}_${timestamp}.${ext}`
    const dropboxPath = `${folderPath}/${dropboxFileName}`

    let savedPath: string
    try {
      savedPath = await uploadFile(dropboxPath, fileBuffer)
    } catch (err) {
      return NextResponse.json(
        { error: `Dropbox保存失敗: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 }
      )
    }

    // DB登録
    const { data: record, error: dbError } = await supabase
      .from("refund_records")
      .insert({
        user_id: user.id,
        patient_name: patientName,
        amount,
        cancel_date: cancelDate,
        refund_date: refundDate,
        service_name: serviceName,
        staff_name: staffName,
        description: ocrResult?.description ?? null,
        dropbox_path: savedPath,
        file_hash: fileHash,
        ocr_raw: ocrResult ? (JSON.parse(JSON.stringify(ocrResult)) as Json) : null,
        status: "未処理",
      })
      .select()
      .single()

    if (dbError) {
      return NextResponse.json(
        { error: `DB登録失敗: ${dbError.message}` },
        { status: 500 }
      )
    }

    // アラートメール送信
    const { data: recipientRows } = await supabase
      .from("notify_recipients")
      .select("email")
      .eq("user_id", user.id)

    const toEmails = (recipientRows ?? []).map((r) => r.email).filter(Boolean)

    let mailResult: { success: boolean; error?: string } = { success: false, error: "通知先未設定" }
    if (toEmails.length > 0) {
      const alertItem: RefundAlertItem = {
        patient_name: patientName,
        amount,
        cancel_date: cancelDate,
        refund_date: refundDate,
        service_name: serviceName,
        staff_name: staffName,
        dropbox_path: savedPath,
      }
      mailResult = await sendRefundAlert(toEmails, alertItem)
    }

    return NextResponse.json({
      data: record,
      dropbox_path: savedPath,
      ocr_result: ocrResult,
      mail_sent: mailResult.success,
      mail_error: mailResult.error,
    })
  } catch (error) {
    console.error("[返金登録] エラー:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "処理に失敗しました" },
      { status: 500 }
    )
  }
}

// 返金一覧取得
export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const { data, error } = await supabase
    .from("refund_records")
    .select("*")
    .order("created_at", { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}
