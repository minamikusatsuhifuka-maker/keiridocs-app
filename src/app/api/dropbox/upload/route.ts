import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { uploadFile, getDocumentPath } from "@/lib/dropbox"

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
    }

    const { base64, fileName, type, date, status } = body

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

    // Dropboxパスを生成
    const dropboxPath = getDocumentPath(type, fileName, dateObj, statusStr)

    // Base64をBufferに変換してアップロード
    const fileBuffer = Buffer.from(base64, "base64")
    const resultPath = await uploadFile(dropboxPath, fileBuffer)

    return NextResponse.json({
      data: { path: resultPath },
    })
  } catch (error) {
    console.error("Dropbox アップロードエラー:", error)
    return NextResponse.json(
      { error: "ファイルのアップロードに失敗しました" },
      { status: 500 }
    )
  }
}
