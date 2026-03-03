import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createHash } from "crypto"
import { uploadFile, getDocumentPath } from "@/lib/dropbox"

/**
 * 一意なファイル名を生成する
 * 形式: {取引先名}_{書類種別}_{日付}_{タイムスタンプ6桁}.{拡張子}
 */
function generateUniqueFileName(
  vendorName: string | undefined,
  docType: string,
  date: Date,
  originalFileName: string
): string {
  // 取引先名のサニタイズ（特殊文字をアンダースコアに置換）
  let vendor = (vendorName || "不明").replace(/[/\\:*?"<>|]/g, "_")
  // 長すぎる場合は20文字で切る
  if (vendor.length > 20) {
    vendor = vendor.substring(0, 20)
  }

  // 日付文字列（YYYYMMDD）
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  const dateStr = `${y}${m}${d}`

  // タイムスタンプ6桁（Date.now()の下6桁）
  const timestamp = Date.now().toString().slice(-6)

  // 拡張子を取得
  const dotIndex = originalFileName.lastIndexOf(".")
  const ext = dotIndex >= 0 ? originalFileName.substring(dotIndex) : ".jpg"

  return `${vendor}_${docType}_${dateStr}_${timestamp}${ext}`
}

// Dropboxアップロード API
export async function POST(request: NextRequest) {
  // 認証チェック
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as {
      base64: unknown
      fileName: unknown
      type: unknown
      date: unknown
      status: unknown
      vendorName: unknown
    }

    const { base64, fileName, type, date, status, vendorName } = body

    if (
      typeof base64 !== "string" ||
      typeof fileName !== "string" ||
      typeof type !== "string"
    ) {
      return NextResponse.json(
        { error: "base64, fileName, typeは必須です" },
        { status: 400 }
      )
    }

    // 日付パース（未指定なら今日）
    const dateObj = typeof date === "string" ? new Date(date) : new Date()
    const statusStr = typeof status === "string" ? status : "未処理"

    // 一意なファイル名を生成
    const vendorStr = typeof vendorName === "string" ? vendorName : undefined
    const uniqueFileName = generateUniqueFileName(vendorStr, type, dateObj, fileName)

    // Dropboxパスを生成
    const dropboxPath = getDocumentPath(type, uniqueFileName, dateObj, statusStr)

    // Base64をBufferに変換
    const fileBuffer = Buffer.from(base64, "base64")

    // SHA-256ハッシュを計算
    const fileHash = createHash("sha256").update(fileBuffer).digest("hex")

    // アップロード
    const resultPath = await uploadFile(dropboxPath, fileBuffer)

    return NextResponse.json({
      data: { path: resultPath, file_hash: fileHash },
    })
  } catch (error) {
    console.error("Dropbox アップロードエラー:", error)
    return NextResponse.json(
      { error: "ファイルのアップロードに失敗しました" },
      { status: 500 }
    )
  }
}
