import { NextRequest, NextResponse } from "next/server"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { analyzePaymentMemo } from "@/lib/payment-memo-ai"

// テキスト＋（任意）画像を受けてAIで支払項目を抽出する（保存はしない・プレビュー用）
// 認証は /mkadmin と同じ Supabase Auth（管理画面内の機能）
export async function POST(request: NextRequest) {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = (await request.json()) as {
      raw_text?: string
      image_base64?: string
      image_mime_type?: string
    }

    const rawText = body.raw_text?.trim() || ""
    const hasImage = !!body.image_base64 && !!body.image_mime_type

    if (!rawText && !hasImage) {
      return NextResponse.json({ error: "テキストまたは画像を入力してください" }, { status: 400 })
    }

    const result = await analyzePaymentMemo(
      rawText,
      hasImage ? { base64: body.image_base64!, mimeType: body.image_mime_type! } : undefined
    )

    return NextResponse.json({
      ai_summary: result.ai_summary,
      items: result.items,
      model_used: result.model_used,
    })
  } catch (error) {
    console.error("支払いメモAI抽出エラー:", error)
    return NextResponse.json({ error: "AI抽出に失敗しました" }, { status: 500 })
  }
}
