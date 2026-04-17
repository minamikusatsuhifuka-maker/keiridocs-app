import { NextRequest, NextResponse } from "next/server"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { uploadFile } from "@/lib/dropbox"

// スキャナーで読み取ったファイルをDropboxの小口現金フォルダに保存
export async function POST(request: NextRequest) {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as {
      base64: string
      fileName: string
      dropboxPath: string
    }

    if (!body.base64 || !body.dropboxPath) {
      return NextResponse.json({ error: "base64 と dropboxPath は必須です" }, { status: 400 })
    }

    const buffer = Buffer.from(body.base64, "base64")
    if (buffer.length === 0) {
      return NextResponse.json({ error: "ファイルデータが空です" }, { status: 400 })
    }

    const uploadedPath = await uploadFile(body.dropboxPath, buffer)

    return NextResponse.json({ path: uploadedPath })
  } catch (error) {
    console.error("スキャナーアップロードエラー:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "アップロードに失敗しました" },
      { status: 500 }
    )
  }
}
