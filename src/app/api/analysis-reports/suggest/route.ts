import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { DEFAULT_GEMINI_MODEL } from "@/lib/gemini"
import { GoogleGenerativeAI } from "@google/generative-ai"
import type { Database, Json } from "@/types/database"

type AnalysisReportRow = Database["public"]["Tables"]["analysis_reports"]["Row"]

interface SuggestionItem {
  title: string
  description: string
  priority: "高" | "中" | "低"
  expected_effect: string
}

// Geminiに改善提案を求める
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as { report_id?: unknown }
    const reportId = typeof body.report_id === "string" ? body.report_id : ""

    if (!reportId) {
      return NextResponse.json({ error: "report_id は必須です" }, { status: 400 })
    }

    // レポート取得
    const { data: reportRaw, error: reportError } = await supabase
      .from("analysis_reports")
      .select("*")
      .eq("id", reportId)
      .single()

    if (reportError || !reportRaw) {
      return NextResponse.json({ error: "レポートが見つかりません" }, { status: 404 })
    }

    const report = reportRaw as AnalysisReportRow

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      console.error("GEMINI_API_KEY が設定されていません")
      return NextResponse.json({ error: "AI設定が不足しています" }, { status: 500 })
    }

    // プロンプト生成
    const prompt = `以下は皮膚科クリニックの経費データです。
経営効率化・コスト削減・業務改善のための具体的な提案を5つ、優先度順にJSON形式で返してください。
各提案には title/description/priority/expected_effect を含めること。

# レポート情報
- タイトル: ${report.title}
- 対象年月: ${report.year}年${report.month}月
- 合計金額: ¥${Number(report.total_amount).toLocaleString()}
- 書類件数: ${report.doc_count}件

# カテゴリ別内訳
${JSON.stringify(report.category_breakdown, null, 2)}

# 週別推移
${JSON.stringify(report.weekly_breakdown, null, 2)}

# 出力形式（必ずJSONのみを返す。コードブロック・説明文なし）
{
  "summary": "全体傾向の簡潔な説明（1-2文・日本語）",
  "suggestions": [
    {
      "title": "提案の見出し（15文字以内・日本語）",
      "description": "具体的な改善内容（80-150文字・日本語）",
      "priority": "高" | "中" | "低",
      "expected_effect": "期待される効果（金額や時間短縮などを含めて具体的に）"
    }
  ]
}

提案は優先度の高い順に並べ、必ず5件返すこと。priority は "高"/"中"/"低" のいずれかの文字列。`

    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({
      model: DEFAULT_GEMINI_MODEL,
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.7,
      },
    })

    const result = await model.generateContent(prompt)
    const text = result.response.text()

    // JSONパース
    let parsed: { summary?: string; suggestions?: SuggestionItem[] } = {}
    try {
      // コードブロックが混ざっていても拾えるように
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text) as {
        summary?: string
        suggestions?: SuggestionItem[]
      }
    } catch (parseError) {
      console.error("AI応答のJSONパース失敗:", parseError, text)
      return NextResponse.json(
        { error: "AIの応答を解析できませんでした" },
        { status: 500 }
      )
    }

    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : []
    const summary = typeof parsed.summary === "string" ? parsed.summary : null

    // DBに保存
    const { data: updated, error: updateError } = await supabase
      .from("analysis_reports")
      .update({
        ai_summary: summary,
        ai_suggestions: suggestions as unknown as Json,
      })
      .eq("id", reportId)
      .select()
      .single()

    if (updateError) {
      console.error("AI提案保存エラー:", updateError)
      return NextResponse.json(
        { error: "AI提案の保存に失敗しました" },
        { status: 500 }
      )
    }

    return NextResponse.json({ data: updated })
  } catch (error) {
    console.error("AI改善提案エラー:", error)
    return NextResponse.json(
      { error: "AI改善提案の生成に失敗しました" },
      { status: 500 }
    )
  }
}
