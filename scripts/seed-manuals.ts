/**
 * マニュアル初期データ投入スクリプト
 * 実行: npx tsx scripts/seed-manuals.ts
 *
 * 皮膚科・美容皮膚科クリニック向けの一般的なマニュアル内容を
 * Gemini AIで生成しSupabaseに投入する
 */

import { createClient } from "@supabase/supabase-js"
import { GoogleGenerativeAI } from "@google/generative-ai"

// 環境変数を.env.localから読み込む
import { config } from "dotenv"
config({ path: ".env.local" })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const geminiKey = process.env.GEMINI_API_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  process.exit(1)
}
if (!geminiKey) {
  console.error("GEMINI_API_KEY が必要です")
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)
const genAI = new GoogleGenerativeAI(geminiKey)

interface Category {
  id: string
  name: string
  emoji: string
}

/** カテゴリごとのマニュアルトピック */
const MANUAL_TOPICS: Record<string, string[]> = {
  "処置・手順": [
    "液体窒素（クライオ）治療の手順",
    "パッチテスト実施手順",
    "皮膚生検（バイオプシー）の準備と介助",
    "ステロイド外用剤の塗布指導手順",
    "創傷処置（縫合後のケア）手順",
  ],
  "服務・規則・マナー": [
    "出退勤・勤怠管理のルール",
    "身だしなみ・服装規定",
    "患者様への接遇マナー（言葉遣い・態度）",
    "個人情報保護・守秘義務",
    "SNS・インターネット利用に関する規則",
  ],
  "機器操作・緊急時対応": [
    "オートクレーブ（高圧蒸気滅菌器）の操作手順",
    "ダーモスコピーの使い方と保守",
    "心肺蘇生（BLS）の手順",
    "アナフィラキシーショック発生時の対応",
    "停電・災害時の初動対応マニュアル",
  ],
  "美容施術・皮膚科診療": [
    "ケミカルピーリング施術手順",
    "レーザー脱毛の施術フロー",
    "ヒアルロン酸注入の準備と注意事項",
    "フォトフェイシャル（IPL）施術手順",
    "にきび（尋常性ざ瘡）の標準治療フロー",
    "アトピー性皮膚炎の生活指導ポイント",
  ],
  "新人研修": [
    "入職初日オリエンテーション",
    "診察室での介助の基本",
    "電子カルテの基本操作",
    "院内感染対策の基本（手洗い・PPE）",
    "先輩スタッフへの報告・連絡・相談のルール",
  ],
  "事務・経理・受付手順": [
    "受付業務の基本フロー（来院〜会計）",
    "保険証確認・レセプト入力の注意点",
    "自費診療の会計処理手順",
    "領収書・明細書の発行ルール",
    "月末の締め処理・日報作成手順",
    "電話応対のマニュアル",
  ],
}

async function generateManualContent(
  categoryName: string,
  topic: string
): Promise<string> {
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" })

  const prompt = `あなたは皮膚科・美容皮膚科クリニックのマニュアル作成担当者です。
以下のトピックについて、実用的なマニュアル内容を作成してください。

【カテゴリ】${categoryName}
【トピック】${topic}

【作成ルール】
- 具体的で実践的な内容にする
- 手順がある場合は番号付きリストで記述
- 注意事項やポイントは「※」や「【注意】」で強調
- 300〜600文字程度
- 日本語で作成
- マークダウン記法は使わず、プレーンテキストで
- クリニック名は「南草津皮フ科」とする`

  try {
    const result = await model.generateContent(prompt)
    return result.response.text()
  } catch (error) {
    console.error(`生成エラー (${topic}):`, error)
    return `${topic}のマニュアル内容（生成エラーのため仮テキスト）`
  }
}

async function main() {
  console.log("マニュアル初期データ投入を開始します...")

  // カテゴリ一覧を取得
  const { data: categories, error: catError } = await supabase
    .from("manual_categories")
    .select("id, name, emoji")

  if (catError || !categories || categories.length === 0) {
    console.error("カテゴリが見つかりません。先にマイグレーションを実行してください。")
    console.error("エラー:", catError)
    process.exit(1)
  }

  console.log(`${categories.length}個のカテゴリを検出`)

  const categoryMap = new Map<string, Category>()
  for (const cat of categories) {
    categoryMap.set(cat.name, cat as Category)
  }

  let totalInserted = 0

  for (const [categoryName, topics] of Object.entries(MANUAL_TOPICS)) {
    const category = categoryMap.get(categoryName)
    if (!category) {
      console.warn(`カテゴリ「${categoryName}」が見つかりません。スキップします。`)
      continue
    }

    console.log(`\n${category.emoji} ${categoryName} (${topics.length}件)`)

    for (const topic of topics) {
      // 既存チェック
      const { data: existing } = await supabase
        .from("manuals")
        .select("id")
        .eq("title", topic)
        .eq("category_id", category.id)
        .limit(1)

      if (existing && existing.length > 0) {
        console.log(`  ⏭️ ${topic} (既存のためスキップ)`)
        continue
      }

      console.log(`  📝 ${topic} を生成中...`)
      const content = await generateManualContent(categoryName, topic)

      const { error: insertError } = await supabase
        .from("manuals")
        .insert({
          category_id: category.id,
          title: topic,
          content,
          source: "AI生成（Gemini 2.0 Flash）",
        })

      if (insertError) {
        console.error(`  ❌ 挿入エラー: ${insertError.message}`)
      } else {
        console.log(`  ✅ ${topic}`)
        totalInserted++
      }

      // APIレート制限対策
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  console.log(`\n完了！ ${totalInserted}件のマニュアルを投入しました。`)
}

main().catch((error) => {
  console.error("実行エラー:", error)
  process.exit(1)
})
