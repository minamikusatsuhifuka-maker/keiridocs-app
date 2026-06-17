// 支払いメモ専用のAI抽出ラッパー
// メール本文・テキスト・スクリーンショット画像から「支払いが必要な項目」を複数抽出する。
// 既存 src/lib/gemini.ts のパターン（inlineData での画像渡し・コードフェンス除去パース）を流用。
import { GoogleGenerativeAI } from "@google/generative-ai"
import { DEFAULT_GEMINI_MODEL, normalizeAmount, normalizePaymentMethod, type PaymentMethod } from "@/lib/gemini"

/** 抽出された個々の支払項目 */
export interface PaymentMemoExtractedItem {
  vendor_name: string
  amount: number | null
  due_date: string | null
  payment_method: PaymentMethod
  note: string | null
}

/** AI抽出の戻り値（支払項目の配列＋全体要約） */
export interface PaymentMemoAnalysisResult {
  ai_summary: string
  items: PaymentMemoExtractedItem[]
  model_used: string
}

/** 入力画像（任意） */
export interface PaymentMemoImageInput {
  base64: string
  mimeType: string
}

/** フォールバック値（AI失敗時） */
const FALLBACK: Omit<PaymentMemoAnalysisResult, "model_used"> = {
  ai_summary: "",
  items: [],
}

/** プロンプト本体 */
const PROMPT = `あなたは経理担当者を補助するAIです。
以下のテキスト（およびスクリーンショット画像があればその内容）から、「支払いが必要な項目」を抽出してください。
メール1通の中に複数の支払いが含まれる場合は、それぞれを別の項目として配列で返してください。

必ず以下のJSON形式のみで回答してください。余計なテキストやマークダウンの説明は含めないでください。

{
  "ai_summary": "全体の要約（どんな支払いが何件あるかを一文で）",
  "items": [
    {
      "vendor_name": "支払先（会社名・店舗名・サービス名）",
      "amount": 金額（数値、税込。読み取れない場合はnull）,
      "due_date": "支払期限（YYYY-MM-DD形式。読み取れない場合はnull）",
      "payment_method": "支払方法（bank_transfer/credit_card/auto_debit/unknown）",
      "note": "内容・備考（何の支払いか）"
    }
  ]
}

【支払方法（payment_method）の判定基準】
- 振込先口座（銀行名・口座番号など）の記載がある → bank_transfer
- クレジットカード・カード払いの記載 → credit_card
- 口座振替・自動引落し・自動引落の記載 → auto_debit
- いずれも判別できない → unknown

【抽出ルール】
- 金額・期限が読み取れない項目は無理に推測せず null を返すこと
- 支払いと無関係な内容（広告・お知らせなど）は項目に含めないこと
- 支払いが1件も見つからない場合は items を空配列 [] にすること
- 金額はカンマ・通貨記号（¥/￥/$）・「円」を除いた半角数字のみで返すこと（例: 1200）`

/**
 * 支払いメモのテキスト（＋任意の画像）をAIで解析し、支払項目の配列を返す。
 * @param rawText 貼り付けたテキスト原文（空でも可。画像のみの解析にも対応）
 * @param image スクリーンショット画像（任意。base64 と mimeType）
 * @param options モデルID
 */
export async function analyzePaymentMemo(
  rawText: string,
  image?: PaymentMemoImageInput,
  options?: { modelId?: string }
): Promise<PaymentMemoAnalysisResult> {
  const apiKey = process.env.GEMINI_API_KEY
  const modelId = options?.modelId || DEFAULT_GEMINI_MODEL

  if (!apiKey) {
    console.error("GEMINI_API_KEY が設定されていません")
    return { ...FALLBACK, model_used: modelId }
  }

  // テキストも画像も無ければ解析しない
  if (!rawText.trim() && !image) {
    return { ...FALLBACK, model_used: modelId }
  }

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: modelId })

  const prompt = `${PROMPT}

--- テキストデータ ---
${rawText || "(テキストなし。画像から抽出してください)"}`

  // 画像があれば inlineData として同梱（既存 analyzeDocument と同方式）
  const parts: Array<string | { inlineData: { data: string; mimeType: string } }> = [prompt]
  if (image) {
    parts.push({ inlineData: { data: image.base64, mimeType: image.mimeType } })
  }

  // 429（レート制限）対策: 最大4回まで指数バックオフ
  const maxRetries = 4
  const backoffMs = [5000, 10000, 20000, 40000]
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(parts)
      const responseText = result.response.text()
      return { ...parsePaymentMemoResponse(responseText), model_used: modelId }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      const is429 =
        errMsg.includes("429") ||
        errMsg.toLowerCase().includes("too many requests") ||
        errMsg.toLowerCase().includes("resource exhausted")

      if (is429 && attempt < maxRetries) {
        const waitMs = backoffMs[attempt] ?? 40000
        console.warn(`Gemini429 リトライ${attempt + 1}/${maxRetries}（${waitMs}ms待機）`)
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        continue
      }

      console.error("支払いメモAI解析エラー:", error)
      return { ...FALLBACK, model_used: modelId }
    }
  }

  return { ...FALLBACK, model_used: modelId }
}

/** Gemini応答（JSON文字列）を厳格にパースする。コードフェンス除去・失敗時フォールバック。 */
function parsePaymentMemoResponse(responseText: string): Omit<PaymentMemoAnalysisResult, "model_used"> {
  try {
    const cleaned = responseText
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim()

    const parsed = JSON.parse(cleaned) as Record<string, unknown>

    const items: PaymentMemoExtractedItem[] = []
    if (Array.isArray(parsed.items)) {
      for (const raw of parsed.items) {
        if (raw && typeof raw === "object") {
          const i = raw as Record<string, unknown>
          items.push({
            vendor_name: typeof i.vendor_name === "string" ? i.vendor_name : "",
            amount: normalizeAmount(i.amount),
            due_date: typeof i.due_date === "string" && i.due_date.trim() ? i.due_date : null,
            payment_method: normalizePaymentMethod(i.payment_method),
            note: typeof i.note === "string" ? i.note : null,
          })
        }
      }
    }

    return {
      ai_summary: typeof parsed.ai_summary === "string" ? parsed.ai_summary : "",
      items,
    }
  } catch {
    console.error("支払いメモAI応答のJSONパースに失敗:", responseText)
    return { ...FALLBACK }
  }
}
