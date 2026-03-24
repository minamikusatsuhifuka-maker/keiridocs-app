import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { GoogleGenerativeAI } from "@google/generative-ai"

export const maxDuration = 30

/**
 * 音声ファイルをGemini AIで書き起こすAPI
 * POST: FormData { audio: File }
 * Response: { text: string }
 */
export async function POST(request: NextRequest) {
  // 認証チェック
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const formData = await request.formData()
    const audioFile = formData.get("audio")

    if (!audioFile || !(audioFile instanceof File)) {
      return NextResponse.json({ error: "音声ファイルが必要です" }, { status: 400 })
    }

    // ファイルサイズチェック（10MB上限）
    if (audioFile.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: "ファイルサイズが10MBを超えています" }, { status: 400 })
    }

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEYが設定されていません" }, { status: 500 })
    }

    // 音声データをBase64に変換
    const arrayBuffer = await audioFile.arrayBuffer()
    const base64Data = Buffer.from(arrayBuffer).toString("base64")

    // MIMEタイプを判定
    const mimeType = audioFile.type || "audio/webm"

    // Gemini AIで書き起こし
    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" })

    const result = await model.generateContent([
      {
        inlineData: {
          data: base64Data,
          mimeType,
        },
      },
      "この音声を正確に書き起こしてください。音声の内容をそのままテキストにしてください。余計な説明やフォーマットは不要です。音声が聞き取れない場合は空文字を返してください。",
    ])

    const text = result.response.text().trim()

    return NextResponse.json({ text })
  } catch (error) {
    console.error("音声書き起こしエラー:", error)
    return NextResponse.json(
      { error: "音声の書き起こしに失敗しました" },
      { status: 500 }
    )
  }
}
