import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { uploadFile } from "@/lib/dropbox"
import { analyzeDocument } from "@/lib/gemini"
import type { Json } from "@/types/database"

/**
 * スタッフ領収書用のDropboxパスを生成する
 * /経理書類/スタッフ領収書/{スタッフ名}/{YYYY年MM月}/{スタッフ名}_{種別}_{日付}_{6桁}.{拡張子}
 */
function getStaffReceiptPath(
  staffName: string,
  docType: string,
  date: Date,
  originalFileName: string
): string {
  const year = `${date.getFullYear()}年`
  const month = `${String(date.getMonth() + 1).padStart(2, "0")}月`

  // ファイル名生成
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  const dateStr = `${y}${m}${d}`
  const timestamp = Date.now().toString().slice(-6)

  const dotIndex = originalFileName.lastIndexOf(".")
  const ext = dotIndex >= 0 ? originalFileName.substring(dotIndex) : ".jpg"

  // 種別のサニタイズ
  const safeType = (docType || "領収書").replace(/[/\\:*?"<>|]/g, "_")
  const safeName = staffName.replace(/[/\\:*?"<>|]/g, "_")

  const fileName = `${safeName}_${safeType}_${dateStr}_${timestamp}${ext}`

  return `/経理書類/スタッフ領収書/${safeName}/${year}${month}/${fileName}`
}

// スタッフ領収書: ファイル受取 → Gemini解析 → Dropbox保存 → DB保存
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as {
      base64: unknown
      mimeType: unknown
      fileName: unknown
      staffMemberId: unknown
      staffName: unknown
    }

    const { base64, mimeType, fileName, staffMemberId, staffName } = body

    if (
      typeof base64 !== "string" ||
      typeof mimeType !== "string" ||
      typeof fileName !== "string" ||
      typeof staffMemberId !== "string" ||
      typeof staffName !== "string"
    ) {
      return NextResponse.json(
        { error: "base64, mimeType, fileName, staffMemberId, staffName は必須です" },
        { status: 400 }
      )
    }

    // data URLプレフィックスがあれば除去
    let base64Data = base64
    const commaIndex = base64Data.indexOf(",")
    if (commaIndex >= 0 && commaIndex < 100) {
      base64Data = base64Data.substring(commaIndex + 1)
    }

    // Gemini AI解析
    const ocrResult = await analyzeDocument(base64Data, mimeType)

    // 解析結果から日付を取得（なければ今日）
    const dateObj = ocrResult.issue_date
      ? new Date(ocrResult.issue_date)
      : new Date()

    // 種別（AI判定 or デフォルト「領収書」）
    const docType = ocrResult.type || "領収書"

    // Dropboxパス生成・アップロード
    const dropboxPath = getStaffReceiptPath(staffName, docType, dateObj, fileName)
    const fileBuffer = Buffer.from(base64Data, "base64")

    if (fileBuffer.length === 0) {
      return NextResponse.json(
        { error: "ファイルデータが空です" },
        { status: 400 }
      )
    }

    const resultPath = await uploadFile(dropboxPath, fileBuffer)

    // DB保存
    const { data: receipt, error: insertError } = await supabase
      .from("staff_receipts")
      .insert({
        staff_member_id: staffMemberId,
        file_name: fileName,
        dropbox_path: resultPath,
        document_type: docType,
        date: ocrResult.issue_date || new Date().toISOString().split("T")[0],
        amount: ocrResult.amount,
        store_name: ocrResult.vendor_name || null,
        tax_category: ocrResult.tax_category || null,
        account_title: ocrResult.account_title || null,
        ai_raw: JSON.parse(JSON.stringify(ocrResult)) as Json,
      })
      .select()
      .single()

    if (insertError) throw insertError

    return NextResponse.json({
      data: receipt,
      ocr: {
        vendor_name: ocrResult.vendor_name,
        amount: ocrResult.amount,
        issue_date: ocrResult.issue_date,
        type: docType,
        tax_category: ocrResult.tax_category,
        account_title: ocrResult.account_title,
        confidence: ocrResult.confidence,
        model_used: ocrResult.model_used,
      },
    })
  } catch (error) {
    console.error("スタッフ領収書登録エラー:", error)
    return NextResponse.json(
      { error: "スタッフ領収書の登録に失敗しました" },
      { status: 500 }
    )
  }
}
