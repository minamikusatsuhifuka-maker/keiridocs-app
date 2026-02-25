// Gemini API ラッパー
import { GoogleGenerativeAI } from "@google/generative-ai"

/** デフォルトのGeminiモデル */
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-preview-05-20"

/** 選択可能なGeminiモデル一覧 */
export const GEMINI_MODELS = [
  { id: "gemini-2.5-flash-preview-05-20", label: "Gemini 2.5 Flash", description: "高速・低コスト・日常OCR向け" },
  { id: "gemini-2.5-pro-preview-05-06", label: "Gemini 2.5 Pro", description: "高精度・複雑書類向け" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", description: "安定版・高速" },
] as const

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

/** analyzeDocument のオプション */
interface AnalyzeOptions {
  /** 使用するGeminiモデルID */
  modelId?: string
  /** 判定に使用する書類種別リスト */
  documentTypes?: string[]
}

/**
 * Gemini AIで書類画像を解析し、経理情報を抽出する
 * @param base64Data Base64エンコードされた画像/PDFデータ
 * @param mimeType ファイルのMIMEタイプ
 * @param options モデルIDや書類種別リスト
 * @returns 解析結果と使用モデル名
 */
export async function analyzeDocument(
  base64Data: string,
  mimeType: string,
  options?: AnalyzeOptions
): Promise<OcrResult & { model_used: string }> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error("GEMINI_API_KEY が設定されていません")
    return { ...FALLBACK_RESULT, model_used: "" }
  }

  const modelId = options?.modelId || DEFAULT_GEMINI_MODEL

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: modelId })

  // 書類種別リストをプロンプトに動的に組み込む
  const typeList = options?.documentTypes?.length
    ? options.documentTypes.join("/")
    : "請求書/領収書/契約書"

  const prompt = `この画像は経理書類（${typeList}など）です。以下の情報をJSON形式で抽出してください。

必ず以下のJSON形式のみで回答してください。余計なテキストは含めないでください。

{
  "vendor_name": "取引先名（会社名・店舗名）",
  "amount": 金額（数値、税込。見つからない場合はnull）,
  "issue_date": "発行日（YYYY-MM-DD形式。見つからない場合はnull）",
  "due_date": "支払期日（YYYY-MM-DD形式。見つからない場合はnull）",
  "description": "摘要・品目の要約",
  "type": "書類種別（${typeList}のいずれか。判別できない場合はnull）",
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
    const parsed = parseOcrResponse(responseText)
    return { ...parsed, model_used: modelId }
  } catch (error) {
    console.error("Gemini API エラー:", error)
    return { ...FALLBACK_RESULT, model_used: modelId }
  }
}

/** 自動仕分けルールの型 */
export interface AutoClassifyRule {
  keyword: string
  document_type: string
  priority: number
  is_active: boolean
}

/**
 * AI解析結果に自動仕分けルールを適用する
 * 取引先名や摘要にキーワードが含まれていたら、そのルールの種別を自動設定する
 * AIの判定より自動仕分けルールを優先
 */
export function applyAutoClassifyRules(
  result: OcrResult,
  rules: AutoClassifyRule[]
): OcrResult {
  // 有効なルールのみ、優先度の高い順に適用
  const activeRules = rules
    .filter((r) => r.is_active)
    .sort((a, b) => b.priority - a.priority)

  const searchText = `${result.vendor_name} ${result.description ?? ""}`.toLowerCase()

  for (const rule of activeRules) {
    if (searchText.includes(rule.keyword.toLowerCase())) {
      return { ...result, type: rule.document_type }
    }
  }

  return result
}

/**
 * テキストデータからGemini AIで経理情報を抽出する（Word/Excel/CSV用）
 * @param text 抽出済みのテキストデータ
 * @param options モデルIDや書類種別リスト
 * @returns 解析結果と使用モデル名
 */
export async function analyzeDocumentFromText(
  text: string,
  options?: AnalyzeOptions
): Promise<OcrResult & { model_used: string }> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error("GEMINI_API_KEY が設定されていません")
    return { ...FALLBACK_RESULT, model_used: "" }
  }

  const modelId = options?.modelId || DEFAULT_GEMINI_MODEL

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: modelId })

  const typeList = options?.documentTypes?.length
    ? options.documentTypes.join("/")
    : "請求書/領収書/契約書"

  const prompt = `以下は経理書類（${typeList}など）のテキストデータです。以下の情報をJSON形式で抽出してください。

必ず以下のJSON形式のみで回答してください。余計なテキストは含めないでください。

{
  "vendor_name": "取引先名（会社名・店舗名）",
  "amount": 金額（数値、税込。見つからない場合はnull）,
  "issue_date": "発行日（YYYY-MM-DD形式。見つからない場合はnull）",
  "due_date": "支払期日（YYYY-MM-DD形式。見つからない場合はnull）",
  "description": "摘要・品目の要約",
  "type": "書類種別（${typeList}のいずれか。判別できない場合はnull）",
  "confidence": 解析の確信度（0.0〜1.0）
}

--- テキストデータ ---
${text}`

  try {
    const result = await model.generateContent(prompt)
    const responseText = result.response.text()
    const parsed = parseOcrResponse(responseText)
    return { ...parsed, model_used: modelId }
  } catch (error) {
    console.error("Gemini API エラー (テキスト解析):", error)
    return { ...FALLBACK_RESULT, model_used: modelId }
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
