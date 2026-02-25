// Gemini API ラッパー
import { GoogleGenerativeAI } from "@google/generative-ai"

/** AI解析結果の型 */
export interface OcrResult {
  vendor_name: string
  amount: number | null
  issue_date: string | null
  due_date: string | null
  description: string | null
  type: string | null
  confidence: number
}

/** フォールバック値 */
const FALLBACK_RESULT: OcrResult = {
  vendor_name: "",
  amount: null,
  issue_date: null,
  due_date: null,
  description: null,
  type: null,
  confidence: 0,
}

/**
 * Gemini 2.5 Flashで書類画像を解析し、経理情報を抽出する
 * @param base64Data Base64エンコードされた画像/PDFデータ
 * @param mimeType ファイルのMIMEタイプ
 */
export async function analyzeDocument(
  base64Data: string,
  mimeType: string
): Promise<OcrResult> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error("GEMINI_API_KEY が設定されていません")
    return FALLBACK_RESULT
  }

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-05-20" })

  const prompt = `この画像は経理書類（請求書、領収書、契約書など）です。以下の情報をJSON形式で抽出してください。

必ず以下のJSON形式のみで回答してください。余計なテキストは含めないでください。

{
  "vendor_name": "取引先名（会社名・店舗名）",
  "amount": 金額（数値、税込。見つからない場合はnull）,
  "issue_date": "発行日（YYYY-MM-DD形式。見つからない場合はnull）",
  "due_date": "支払期日（YYYY-MM-DD形式。見つからない場合はnull）",
  "description": "摘要・品目の要約",
  "type": "書類種別（請求書/領収書/契約書のいずれか。判別できない場合はnull）",
  "confidence": 解析の確信度（0.0〜1.0）
}`

  try {
    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: base64Data,
          mimeType,
        },
      },
    ])

    const responseText = result.response.text()
    return parseOcrResponse(responseText)
  } catch (error) {
    console.error("Gemini API エラー:", error)
    return FALLBACK_RESULT
  }
}

/**
 * Geminiの応答テキストからJSONをパースする
 * 失敗時はフォールバック値を返す
 */
function parseOcrResponse(responseText: string): OcrResult {
  try {
    // マークダウンのコードブロックを除去
    const cleaned = responseText
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim()

    const parsed = JSON.parse(cleaned) as Record<string, unknown>

    return {
      vendor_name: typeof parsed.vendor_name === "string" ? parsed.vendor_name : "",
      amount: typeof parsed.amount === "number" ? parsed.amount : null,
      issue_date: typeof parsed.issue_date === "string" ? parsed.issue_date : null,
      due_date: typeof parsed.due_date === "string" ? parsed.due_date : null,
      description: typeof parsed.description === "string" ? parsed.description : null,
      type: typeof parsed.type === "string" ? parsed.type : null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    }
  } catch {
    console.error("Gemini応答のJSONパースに失敗:", responseText)
    return FALLBACK_RESULT
  }
}
