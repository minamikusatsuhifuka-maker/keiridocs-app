import { NextRequest, NextResponse } from "next/server"
import { GoogleGenerativeAI } from "@google/generative-ai"
import { DEFAULT_GEMINI_MODEL } from "@/lib/gemini"

export const maxDuration = 60

/** チャットメッセージの型 */
interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

/** システムプロンプト */
const SYSTEM_PROMPT = `あなたは南草津皮フ科の経理・業務アシスタントです。
経費・書類管理・スタッフ領収書・マニュアル検索・勘定科目の判断などについて日本語で簡潔に回答してください。

回答のルール:
- 丁寧だが簡潔な日本語で回答する
- 不明な点は推測せず「分からない」と伝える
- 勘定科目の質問には具体的な科目名（仕入高、消耗品費、通信費、水道光熱費、地代家賃、リース料、支払手数料、広告宣伝費、修繕費、保険料、福利厚生費、雑費 など）で答える
- 長くなる場合は箇条書きで整理する`

/**
 * AIチャットAPI
 * POST: メッセージと会話履歴を受け取り、Gemini AIで回答を生成
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      message?: string
      history?: ChatMessage[]
    }

    const message = body.message?.trim()
    if (!message) {
      return NextResponse.json({ error: "メッセージが必要です" }, { status: 400 })
    }

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json(
        { error: "Gemini APIキーが設定されていません" },
        { status: 500 }
      )
    }

    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({
      model: DEFAULT_GEMINI_MODEL,
      systemInstruction: SYSTEM_PROMPT,
    })

    // 会話履歴を Gemini のフォーマットに変換
    const history = (body.history ?? [])
      .filter((m) => m && typeof m.content === "string" && m.content.trim())
      .map((m) => ({
        role: m.role === "assistant" ? ("model" as const) : ("user" as const),
        parts: [{ text: m.content }],
      }))

    // Gemini の制約: history は user で始まる必要があるため、先頭が model の場合はスキップ
    const startIndex = history.findIndex((h) => h.role === "user")
    const validHistory = startIndex >= 0 ? history.slice(startIndex) : []

    const chat = model.startChat({ history: validHistory })
    const result = await chat.sendMessage(message)
    const answer = result.response.text()

    return NextResponse.json({ answer })
  } catch (error) {
    console.error("[ai-chat] エラー:", error)
    return NextResponse.json(
      { error: "回答生成中にエラーが発生しました" },
      { status: 500 }
    )
  }
}
