import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { GoogleGenerativeAI } from "@google/generative-ai"
import { DEFAULT_GEMINI_MODEL } from "@/lib/gemini"
import { getCurrentUserRole } from "@/lib/auth"
import { subMonths, format } from "date-fns"

// AIレポート生成 API
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as { period?: string }
    const period = body.period || "1m"

    // 期間の開始日を計算
    const now = new Date()
    let dateFrom: string | null = null

    switch (period) {
      case "1m":
        dateFrom = format(subMonths(now, 1), "yyyy-MM-dd")
        break
      case "3m":
        dateFrom = format(subMonths(now, 3), "yyyy-MM-dd")
        break
      case "6m":
        dateFrom = format(subMonths(now, 6), "yyyy-MM-dd")
        break
      case "12m":
        dateFrom = format(subMonths(now, 12), "yyyy-MM-dd")
        break
      default:
        dateFrom = format(subMonths(now, 1), "yyyy-MM-dd")
    }

    // 権限取得（adminは全件、staff/viewerは自分の書類のみ）
    const auth = await getCurrentUserRole()
    const isAdminUser = auth?.role === "admin"

    // documentsテーブルから該当期間のデータを取得
    let query = supabase
      .from("documents")
      .select("type, vendor_name, amount, issue_date, due_date, status, created_at")

    // admin以外は自分の書類のみ
    if (!isAdminUser) {
      query = query.eq("user_id", user.id)
    }

    if (dateFrom) {
      query = query.gte("created_at", dateFrom)
    }

    const { data: documents, error: fetchError } = await query

    if (fetchError) {
      console.error("書類データ取得エラー:", fetchError)
      return NextResponse.json({ error: "書類データの取得に失敗しました" }, { status: 500 })
    }

    const docs = documents ?? []

    if (docs.length === 0) {
      return NextResponse.json({
        report: "# レポート生成不可\n\n指定された期間にデータがありません。書類を登録してからレポートを生成してください。",
      })
    }

    // settingsからgemini_modelを取得
    const { data: modelSetting } = await supabase
      .from("settings")
      .select("value")
      .eq("user_id", user.id)
      .eq("key", "gemini_model")
      .maybeSingle()

    const modelId = (typeof modelSetting?.value === "string" ? modelSetting.value : null)
      || DEFAULT_GEMINI_MODEL

    // Gemini APIでレポート生成
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY が設定されていません" }, { status: 500 })
    }

    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({ model: modelId })

    // 期間の表示名
    const periodLabels: Record<string, string> = {
      "1m": "過去1ヶ月",
      "3m": "過去3ヶ月",
      "6m": "過去6ヶ月",
      "12m": "過去12ヶ月",
    }
    const periodLabel = periodLabels[period] || period

    const prompt = `あなたは医療法人の経営コンサルタントです。以下の経理データを分析し、日本語でレポートを作成してください。

【分析期間】${periodLabel}（${dateFrom} 〜 ${format(now, "yyyy-MM-dd")}）
【データ件数】${docs.length}件

【分析項目】
1. 期間サマリー（総件数、総額、前期比較があれば増減率）
2. 支出カテゴリ分析（種別ごとの金額と割合、前期比）
3. 取引先分析（上位取引先、集中度、交渉余地）
4. キャッシュフロー注意点（支払期日の集中、大口支払い）
5. コスト削減の提案（具体的な施策3つ以上）
6. 経営改善アドバイス（医療法人特有の観点含む）

マークダウン形式で出力してください。

【経理データ（JSON）】
${JSON.stringify(docs, null, 2)}`

    const result = await model.generateContent(prompt)
    const report = result.response.text()

    return NextResponse.json({ report, model_used: modelId })
  } catch (error) {
    console.error("AIレポート生成エラー:", error)
    return NextResponse.json({ error: "レポートの生成に失敗しました" }, { status: 500 })
  }
}
