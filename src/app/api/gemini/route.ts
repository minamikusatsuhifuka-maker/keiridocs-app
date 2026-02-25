import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { analyzeDocument } from "@/lib/gemini"

// Gemini AI解析 API
export async function POST(request: NextRequest) {
  // 認証チェック
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as { base64: unknown; mimeType: unknown }

    const { base64, mimeType } = body

    if (typeof base64 !== "string" || typeof mimeType !== "string") {
      return NextResponse.json(
        { error: "base64とmimeTypeは必須です" },
        { status: 400 }
      )
    }

    // サポートされるMIMEタイプの検証
    const supportedTypes = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "application/pdf",
    ]
    if (!supportedTypes.includes(mimeType)) {
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

    const result = await analyzeDocument(base64, mimeType)

    return NextResponse.json({ data: result })
  } catch (error) {
    console.error("Gemini API エラー:", error)
    return NextResponse.json(
      { error: "AI解析に失敗しました" },
      { status: 500 }
    )
  }
}
