import { NextRequest, NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { GoogleGenerativeAI } from "@google/generative-ai"
import type { Database } from "@/types/database"

export const maxDuration = 60

type ManualRow = Database["public"]["Tables"]["manuals"]["Row"]
type CategoryRow = Database["public"]["Tables"]["manual_categories"]["Row"]

/** サービスロールキーでRLSをバイパスするSupabaseクライアント */
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createSupabaseClient<Database>(url, serviceKey)
}

/**
 * マニュアル検索API
 * POST: queryを受け取り、マニュアルを検索しGemini AIが回答を生成
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { query: string }
    const query = body.query?.trim()

    if (!query) {
      return NextResponse.json({ error: "検索クエリが必要です" }, { status: 400 })
    }

    const supabase = createServiceClient()

    // キーワードで部分一致検索（助詞・記号を除去してキーワード抽出）
    const keywords = query
      .replace(/[？?！!。、・\s]+/g, " ")
      .split(/\s+/)
      .filter((kw) => kw.length >= 2)
    console.log("[manual-search] クエリ:", query, "キーワード:", keywords)

    let manuals: ManualRow[] = []

    if (keywords.length > 0) {
      const orConditions = keywords
        .map((kw) => `title.ilike.%${kw}%,content.ilike.%${kw}%`)
        .join(",")

      const { data: rawManuals, error: searchError } = await supabase
        .from("manuals")
        .select("*")
        .or(orConditions)
        .limit(10)

      if (searchError) {
        console.error("[manual-search] 検索エラー:", searchError)
        return NextResponse.json({ error: "検索に失敗しました" }, { status: 500 })
      }
      manuals = (rawManuals || []) as ManualRow[]
      console.log("[manual-search] キーワード検索ヒット数:", manuals.length)
    }

    // キーワード検索で0件の場合、全件取得してGeminiに判断を委ねる
    if (manuals.length === 0) {
      console.log("[manual-search] キーワード検索0件 → 全件取得してGeminiに委ねます")
      const { data: allManuals } = await supabase
        .from("manuals")
        .select("*")
        .order("created_at", { ascending: true })
      manuals = (allManuals || []) as ManualRow[]
      console.log("[manual-search] マニュアル全件数:", manuals.length)
    }

    // カテゴリ情報を取得
    const { data: rawCategories } = await supabase
      .from("manual_categories")
      .select("*")

    const categories = (rawCategories || []) as CategoryRow[]
    const categoryMap = new Map(categories.map((c) => [c.id, c]))

    // Gemini AIで回答を生成
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      if (manuals.length === 0) {
        return NextResponse.json({
          answer: "マニュアルが登録されていません。管理者にお問い合わせください。",
          related_manuals: [],
          category: null,
        })
      }
      const topManual = manuals[0]
      const cat = topManual.category_id ? categoryMap.get(topManual.category_id) : null
      return NextResponse.json({
        answer: topManual.content,
        related_manuals: manuals.map((m) => ({
          id: m.id,
          title: m.title,
          category: m.category_id ? categoryMap.get(m.category_id)?.name : null,
        })),
        category: cat?.name || null,
      })
    }

    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" })

    // マニュアルが0件の場合は一般知識でフォールバック
    if (manuals.length === 0) {
      console.log("[manual-search] マニュアル0件 → 一般知識フォールバック")
      const fallbackPrompt = `あなたは皮膚科・美容皮膚科クリニック「南草津皮フ科」のAIアシスタントです。
マニュアルが登録されていないため、皮膚科・美容皮膚科クリニックの一般的な知識として回答してください。

【スタッフからの質問】
${query}

【回答ルール】
- 皮膚科クリニックの一般的な知識に基づいて回答する
- 「一般的な対応としては」と前置きして回答する
- 簡潔でわかりやすい日本語で回答する
- 箇条書きを活用して見やすくする
- 回答は500文字以内に収める
- 最後に「詳細は管理者にご確認ください」と付け加える`

      const result = await model.generateContent(fallbackPrompt)
      const answer = result.response.text()
      return NextResponse.json({
        answer,
        related_manuals: [],
        category: null,
      })
    }

    // マニュアル内容をコンテキストとしてGeminiに渡す
    const context = manuals
      .map((m) => {
        const cat = m.category_id ? categoryMap.get(m.category_id) : null
        return `【${cat?.emoji || "📄"} ${cat?.name || "未分類"}】${m.title}\n${m.content}`
      })
      .join("\n\n---\n\n")

    const prompt = `あなたは皮膚科・美容皮膚科クリニック「南草津皮フ科」のAIアシスタントです。
スタッフからの質問に、以下のマニュアル内容を参照して簡潔に回答してください。

【マニュアル内容】
${context}

【スタッフからの質問】
${query}

【回答ルール】
- マニュアルの内容に基づいて正確に回答する
- 簡潔でわかりやすい日本語で回答する
- LINEメッセージとして読みやすいように、適切に改行を入れる
- マニュアルに直接の記載がなくても、関連する内容から推測して回答する
- どうしても回答できない場合のみ「該当するマニュアルが見つかりませんでした」と伝える
- 箇条書きを活用して見やすくする
- 回答は500文字以内に収める`

    const result = await model.generateContent(prompt)
    const answer = result.response.text()

    // 関連マニュアル情報を整理
    const relatedManuals = manuals.map((m) => ({
      id: m.id,
      title: m.title,
      category: m.category_id ? categoryMap.get(m.category_id)?.name : null,
    }))

    const topCategory = manuals[0].category_id
      ? categoryMap.get(manuals[0].category_id)?.name
      : null

    return NextResponse.json({
      answer,
      related_manuals: relatedManuals,
      category: topCategory || null,
    })
  } catch (error) {
    console.error("[manual-search] エラー:", error)
    return NextResponse.json(
      { error: "マニュアル検索に失敗しました" },
      { status: 500 }
    )
  }
}
