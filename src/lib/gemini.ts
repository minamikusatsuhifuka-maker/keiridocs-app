// Gemini API ラッパー
import { GoogleGenerativeAI } from "@google/generative-ai"

/** デフォルトのGeminiモデル（環境変数 GEMINI_MODEL で一括変更可能。未設定時は gemini-3.5-flash） */
export const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash"

/** 選択可能なGeminiモデル一覧 */
export const GEMINI_MODELS = [
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", description: "高速・高精度・マルチモーダル対応（デフォルト）" },
] as const

/** 売上・振込書類の解析で判定に使う書類種別リスト */
export const SALES_ANALYSIS_DOCUMENT_TYPES = ["売上記録", "領収書", "請求書"] as const

/**
 * 売上・振込書類向けの追加抽出指示（extraHint）。
 * 新規売上登録（sales/route.ts）と再解析（reanalyze）で同一のものを使う。
 */
export const SALES_ANALYSIS_EXTRA_HINT = `
この書類は売上・振込に関する書類です。以下の情報を最優先で正確に抽出してください：
- vendor_name: 振込元の会社名・法人名（個人名でなく法人名を優先）
- amount: 振込金額のトータル合計（税込み総額）。明細の個別金額ではなく合計額
- issue_date: 振込日または売上日（YYYY-MM-DD形式）
- transfer_from: 振込元会社名（vendor_nameと同じ値でよい）
- transfer_date: 振込日（YYYY-MM-DD形式、issue_dateと同じ値でよい）
- transfer_total: 振込金額トータル（amountと同じ値でよい）
- description: 取引内容・サービス名の説明
金額が複数ある場合は最も大きい合計金額を採用してください。
金額はカンマ・通貨記号（¥/￥/$）・「円」を除いた半角数字のみで返すこと（例: 1200）。
PDFが複数ページの場合は全ページを確認し、振込金額の合計（トータル）を返すこと。
`

/** 支払方法・振込先のJSON項目（プロンプトのJSONテンプレートに差し込む） */
const PAYMENT_JSON_FIELDS = `  "payment_method": "支払方法（bank_transfer=振込が必要/auto_debit=口座振替・自動引落し/credit_card=カード払い/unknown=判別不能）",
  "bank_info": {
    "bank_name": "銀行名（無ければ空文字）",
    "branch_name": "支店名",
    "account_type": "口座種別（普通/当座 など）",
    "account_number": "口座番号",
    "account_holder": "口座名義"
  },`

/** 支払方法・振込先の判定ルール（プロンプト末尾に差し込む） */
const PAYMENT_EXTRACTION_RULES = `【支払方法（payment_method）の判定基準】
- 「お振込先」「振込先」「振込口座」など、こちらが振り込む口座が記載されている → bank_transfer
- 「口座振替」「自動引落し」「自動引落」「振替日」など、自動で引き落とされる旨の記載 → auto_debit
- 「カード」「クレジット」「クレジットカード払い」などの記載 → credit_card
- いずれも判別できない場合 → unknown
- 迷う場合、振込先口座の記載があれば原則 bank_transfer とする

【振込先情報（bank_info）の抽出ルール】
- 振込先（銀行名・支店名・口座種別・口座番号・口座名義）が記載されていれば bank_info に抽出する
- 振込先の記載が一切無ければ bank_info は null を返す
- 各項目が部分的に欠ける場合、見つかった項目のみ埋め、無い項目は空文字にする`

/** 税区分の選択肢 */
export const TAX_CATEGORIES = [
  "課税10%",
  "課税8%（軽減）",
  "非課税",
  "免税",
  "不課税",
  "未判定",
] as const

/** 勘定科目の選択肢（医療クリニック向け） */
export const ACCOUNT_TITLES = [
  "仕入高",
  "消耗品費",
  "通信費",
  "水道光熱費",
  "地代家賃",
  "リース料",
  "支払手数料",
  "広告宣伝費",
  "修繕費",
  "保険料",
  "福利厚生費",
  "雑費",
] as const

/** 支払方法の選択肢（bank_transfer/unknown は支払管理の対象、auto_debit/credit_card は除外） */
export const PAYMENT_METHODS = ["bank_transfer", "auto_debit", "credit_card", "unknown"] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

/** 振込先情報の型（bank_info にJSONで保存） */
export interface BankInfo {
  /** 銀行名 */
  bank_name: string
  /** 支店名 */
  branch_name: string
  /** 口座種別（普通/当座 等） */
  account_type: string
  /** 口座番号 */
  account_number: string
  /** 口座名義 */
  account_holder: string
}

/** 明細行の型 */
export interface OcrItem {
  item_name: string
  quantity: number
  unit_price: number
  amount: number
  category: string
  tax_rate: string
}

/** AI解析結果の型 */
export interface OcrResult {
  vendor_name: string
  amount: number | null
  issue_date: string | null
  due_date: string | null
  description: string | null
  type: string | null
  confidence: number
  tax_category: string | null
  account_title: string | null
  /** 支払方法（bank_transfer/auto_debit/credit_card/unknown） */
  payment_method: PaymentMethod
  /** 振込先情報（抽出できなければ null） */
  bank_info: BankInfo | null
  items: OcrItem[]
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
  tax_category: null,
  account_title: null,
  payment_method: "unknown",
  bank_info: null,
  items: [],
}

/** analyzeDocument のオプション */
interface AnalyzeOptions {
  /** 使用するGeminiモデルID */
  modelId?: string
  /** 判定に使用する書類種別リスト */
  documentTypes?: string[]
  /** 追加プロンプト指示（書類種別ごとに優先抽出項目を伝えるなど） */
  extraHint?: string
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

  // 追加ヒント（呼び出し元から渡される書類別の優先抽出指示など）
  const extraHintBlock = options?.extraHint?.trim()
    ? `\n\n【追加指示】\n${options.extraHint.trim()}\n`
    : ""

  const prompt = `この画像は経理書類（${typeList}など）です。以下の情報をJSON形式で抽出してください。${extraHintBlock}

必ず以下のJSON形式のみで回答してください。余計なテキストは含めないでください。

{
  "vendor_name": "取引先名（会社名・店舗名）",
  "amount": 金額（数値、税込。見つからない場合はnull）,
  "issue_date": "発行日（YYYY-MM-DD形式。見つからない場合はnull）",
  "due_date": "支払期日（YYYY-MM-DD形式。見つからない場合はnull）",
  "description": "摘要・品目の要約",
  "type": "書類種別（${typeList}のいずれか。判別できない場合はnull）",
  "confidence": 解析の確信度（0.0〜1.0）,
  "tax_category": "税区分（課税10%/課税8%（軽減）/非課税/免税/不課税/未判定のいずれか）",
  "account_title": "勘定科目（下記参照）",
${PAYMENT_JSON_FIELDS}
  "items": [
    {
      "item_name": "品目名",
      "quantity": 数量（数値）,
      "unit_price": 単価（数値）,
      "amount": 金額（数値）,
      "category": "カテゴリ（商品代/手数料/輸送費/関税/消費税/値引き/その他）",
      "tax_rate": "税区分（課税10%/課税8%（軽減）/非課税/未判定）"
    }
  ]
}

【items（明細行）の抽出ルール】
- 書類に明細行がある場合、各行を個別に抽出する
- 明細がない書類（領収書など）は、書類全体を1行として items に含める
- 送料・手数料・代引手数料なども個別の行として抽出する
- カテゴリの分類: 商品代, 手数料, 輸送費, 関税, 消費税, 値引き, その他

【税区分の判定基準】
- 食品・飲料 → 課税8%（軽減）
- 医薬品 → 非課税の場合が多い（医薬品仕入は課税10%）
- 一般的な事務用品・サービス → 課税10%
- 判定できない場合 → 未判定

【勘定科目の判定基準（医療クリニック・皮膚科向け）】
- 医薬品・医療材料 → 仕入高
- 事務用品・日用品 → 消耗品費
- 電話・インターネット → 通信費
- 電気・ガス・水道 → 水道光熱費
- テナント賃料 → 地代家賃
- 医療機器リース → リース料
- 振込手数料・代行手数料 → 支払手数料
- 広告・ホームページ → 広告宣伝費
- 設備修理 → 修繕費
- 社会保険・損害保険 → 保険料
- スタッフ関連（食事補助等） → 福利厚生費
- その他 → 雑費

${PAYMENT_EXTRACTION_RULES}`

  // 429（レート制限）対策: 最大4回まで指数バックオフでリトライ（5秒・10秒・20秒・40秒）
  const maxRetries = 4
  const backoffMs = [5000, 10000, 20000, 40000]
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
      const errMsg = error instanceof Error ? error.message : String(error)
      const is429 = errMsg.includes("429") || errMsg.toLowerCase().includes("too many requests") || errMsg.toLowerCase().includes("resource exhausted")

      // 429エラーで、リトライ余地があれば指数バックオフ（5秒・10秒・20秒・40秒）
      if (is429 && attempt < maxRetries) {
        const waitMs = backoffMs[attempt] ?? 40000
        console.warn(`Gemini429 リトライ${attempt + 1}/${maxRetries}（${waitMs}ms待機）`)
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        continue
      }

      console.error("Gemini API エラー:", error)
      return { ...FALLBACK_RESULT, model_used: modelId }
    }
  }

  return { ...FALLBACK_RESULT, model_used: modelId }
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
  "confidence": 解析の確信度（0.0〜1.0）,
  "tax_category": "税区分（課税10%/課税8%（軽減）/非課税/免税/不課税/未判定のいずれか）",
  "account_title": "勘定科目（下記参照）",
${PAYMENT_JSON_FIELDS}
  "items": [
    {
      "item_name": "品目名",
      "quantity": 数量（数値）,
      "unit_price": 単価（数値）,
      "amount": 金額（数値）,
      "category": "カテゴリ（商品代/手数料/輸送費/関税/消費税/値引き/その他）",
      "tax_rate": "税区分（課税10%/課税8%（軽減）/非課税/未判定）"
    }
  ]
}

【items（明細行）の抽出ルール】
- 書類に明細行がある場合、各行を個別に抽出する
- 明細がない書類（領収書など）は、書類全体を1行として items に含める
- 送料・手数料・代引手数料なども個別の行として抽出する
- カテゴリの分類: 商品代, 手数料, 輸送費, 関税, 消費税, 値引き, その他

【税区分の判定基準】
- 食品・飲料 → 課税8%（軽減）
- 医薬品 → 非課税の場合が多い（医薬品仕入は課税10%）
- 一般的な事務用品・サービス → 課税10%
- 判定できない場合 → 未判定

【勘定科目の判定基準（医療クリニック・皮膚科向け）】
- 医薬品・医療材料 → 仕入高
- 事務用品・日用品 → 消耗品費
- 電話・インターネット → 通信費
- 電気・ガス・水道 → 水道光熱費
- テナント賃料 → 地代家賃
- 医療機器リース → リース料
- 振込手数料・代行手数料 → 支払手数料
- 広告・ホームページ → 広告宣伝費
- 設備修理 → 修繕費
- 社会保険・損害保険 → 保険料
- スタッフ関連（食事補助等） → 福利厚生費
- その他 → 雑費

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

/** 名刺AI解析結果の型 */
export interface BusinessCardResult {
  company_name: string
  department: string
  name: string
  title: string
  email: string
  phone: string
  mobile: string
  address: string
  website: string
}

const BUSINESS_CARD_FALLBACK: BusinessCardResult = {
  company_name: "",
  department: "",
  name: "",
  title: "",
  email: "",
  phone: "",
  mobile: "",
  address: "",
  website: "",
}

/**
 * Gemini AIで名刺画像/PDFを解析し、連絡先情報を抽出する
 */
export async function analyzeBusinessCard(
  base64Data: string,
  mimeType: string
): Promise<BusinessCardResult> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error("GEMINI_API_KEY が設定されていません")
    return BUSINESS_CARD_FALLBACK
  }

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: DEFAULT_GEMINI_MODEL })

  const prompt = `この画像は名刺です。以下の情報をJSON形式で抽出してください。
必ず以下のJSON形式のみで回答してください。余計なテキストやマークダウン記号は含めないでください。
情報が見つからない項目は空文字列("")にしてください。

{
  "company_name": "会社名・団体名",
  "department": "部署名",
  "name": "氏名（フルネーム）",
  "title": "役職・肩書き",
  "email": "メールアドレス",
  "phone": "固定電話番号",
  "mobile": "携帯電話番号",
  "address": "住所",
  "website": "ウェブサイトURL"
}

【抽出ルール】
- 電話番号は固定電話と携帯電話を区別する（090/080/070始まりは携帯）
- 複数のメールアドレスがある場合は最初の1件のみ
- 住所は郵便番号も含めて1行にまとめる
- 氏名は姓と名の間に全角スペースを入れる`

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
    const cleaned = responseText
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim()

    const parsed = JSON.parse(cleaned) as Record<string, unknown>
    return {
      company_name: typeof parsed.company_name === "string" ? parsed.company_name : "",
      department: typeof parsed.department === "string" ? parsed.department : "",
      name: typeof parsed.name === "string" ? parsed.name : "",
      title: typeof parsed.title === "string" ? parsed.title : "",
      email: typeof parsed.email === "string" ? parsed.email : "",
      phone: typeof parsed.phone === "string" ? parsed.phone : "",
      mobile: typeof parsed.mobile === "string" ? parsed.mobile : "",
      address: typeof parsed.address === "string" ? parsed.address : "",
      website: typeof parsed.website === "string" ? parsed.website : "",
    }
  } catch (error) {
    console.error("Gemini 名刺解析エラー:", error)
    return BUSINESS_CARD_FALLBACK
  }
}

/**
 * 金額を数値に正規化する。
 * - number ならそのまま（NaNはnull）
 * - string なら カンマ・通貨記号（¥/￥/$）・「円」・空白 を除去して数値化
 * - 数値化できない場合は null
 *
 * Geminiが金額を "1,200" / "¥1,200" / "1200円" のような文字列で返しても
 * null落ち（→0登録）にならないようにする。
 */
export function normalizeAmount(raw: unknown): number | null {
  if (typeof raw === "number") return isNaN(raw) ? null : raw
  if (typeof raw === "string") {
    const cleaned = raw.replace(/[,，¥￥$＄円\s]/g, "")
    if (cleaned === "") return null
    const n = Number(cleaned)
    return isNaN(n) ? null : n
  }
  return null
}

/**
 * 支払方法を正規化する。許可された値以外・未指定は "unknown" にフォールバックする。
 */
export function normalizePaymentMethod(raw: unknown): PaymentMethod {
  if (typeof raw === "string" && (PAYMENT_METHODS as readonly string[]).includes(raw)) {
    return raw as PaymentMethod
  }
  return "unknown"
}

/**
 * 振込先情報を正規化する。
 * - オブジェクトなら各項目を文字列化（無い項目は空文字）
 * - すべて空なら null（＝振込先記載なし）
 * - それ以外（null・文字列など）は null
 */
export function normalizeBankInfo(raw: unknown): BankInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
  const info: BankInfo = {
    bank_name: str(o.bank_name),
    branch_name: str(o.branch_name),
    account_type: str(o.account_type),
    account_number: str(o.account_number),
    account_holder: str(o.account_holder),
  }
  // 全項目が空なら振込先記載なしとみなす
  const hasAny = Object.values(info).some((v) => v !== "")
  return hasAny ? info : null
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

    // 明細行をパース
    const items: OcrItem[] = []
    if (Array.isArray(parsed.items)) {
      for (const item of parsed.items) {
        if (item && typeof item === "object") {
          const i = item as Record<string, unknown>
          items.push({
            item_name: typeof i.item_name === "string" ? i.item_name : "",
            quantity: typeof i.quantity === "number" ? i.quantity : 1,
            unit_price: normalizeAmount(i.unit_price) ?? 0,
            amount: normalizeAmount(i.amount) ?? 0,
            category: typeof i.category === "string" ? i.category : "その他",
            tax_rate: typeof i.tax_rate === "string" ? i.tax_rate : "未判定",
          })
        }
      }
    }

    return {
      vendor_name: typeof parsed.vendor_name === "string" ? parsed.vendor_name : "",
      amount: normalizeAmount(parsed.amount),
      issue_date: typeof parsed.issue_date === "string" ? parsed.issue_date : null,
      due_date: typeof parsed.due_date === "string" ? parsed.due_date : null,
      description: typeof parsed.description === "string" ? parsed.description : null,
      type: typeof parsed.type === "string" ? parsed.type : null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      tax_category: typeof parsed.tax_category === "string" ? parsed.tax_category : null,
      account_title: typeof parsed.account_title === "string" ? parsed.account_title : null,
      payment_method: normalizePaymentMethod(parsed.payment_method),
      bank_info: normalizeBankInfo(parsed.bank_info),
      items,
    }
  } catch {
    console.error("Gemini応答のJSONパースに失敗:", responseText)
    return FALLBACK_RESULT
  }
}

/** 支払い内容の要約に使う入力（書類の既存データから組み立てる） */
export interface PaymentPurposeInput {
  vendor_name?: string | null
  type?: string | null
  amount?: number | null
  description?: string | null
  account_title?: string | null
  items?: Array<{ item_name?: string | null; category?: string | null }>
}

/**
 * 書類の既存データ（取引先・種別・摘要・品目など）から、支払い内容をAIで簡潔に要約する。
 * best-effort。判定不能・失敗時は空文字を返す（無理に埋めない）。
 * @returns 20〜40字目安の日本語要約（失敗・判定不能時は ""）
 */
export async function summarizePaymentPurpose(
  input: PaymentPurposeInput,
  options?: { modelId?: string }
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return ""

  // 要約の材料を組み立てる（空要素は除外）
  const itemNames = (input.items ?? [])
    .map((it) => (typeof it?.item_name === "string" ? it.item_name.trim() : ""))
    .filter((n) => n.length > 0)
  const material = [
    input.vendor_name ? `取引先: ${input.vendor_name}` : "",
    input.type ? `種別: ${input.type}` : "",
    input.account_title ? `勘定科目: ${input.account_title}` : "",
    input.amount != null ? `金額: ${input.amount}円` : "",
    input.description ? `摘要: ${input.description}` : "",
    itemNames.length ? `品目: ${itemNames.slice(0, 8).join(" / ")}` : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n")

  // 材料が乏しすぎる場合はAIを呼ばず空を返す
  if (material.trim().length < 3) return ""

  const modelId = options?.modelId || DEFAULT_GEMINI_MODEL
  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: modelId })

  const prompt = `次の経理書類の情報から、この支払いが「何の支払いか（支払い内容）」を日本語で簡潔に要約してください。

条件:
- 20〜40字程度。区分名（例: セミナー代・講演料・薬剤代・電気料金・消防設備点検 等）が分かる表現にする。
- 品目が複数ある場合は代表品目＋「ほか」等でまとめる。
- 要約の一文のみを返す。前置き・記号・引用符・改行・説明は一切付けない。
- 判定できない場合は空文字だけを返す。

--- 書類情報 ---
${material}`

  try {
    const result = await model.generateContent(prompt)
    let text = result.response.text() ?? ""
    // 先頭行のみ・前後の引用符/空白を除去（best-effort）
    text = text.split(/\r?\n/)[0]?.trim() ?? ""
    text = text.replace(/^["「『]+/, "").replace(/["」』]+$/, "").trim()
    if (text.length > 60) text = text.slice(0, 60)
    return text
  } catch (error) {
    console.error("支払い内容の要約に失敗:", error)
    return ""
  }
}
