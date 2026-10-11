// 外貨建て書類の通貨判定・円換算・表示（クライアント/サーバー共用の純関数のみ）
//
// 外貨建ての請求書（例: Anthropic の $220.00 USD）を数値だけ円として登録してしまう事故を防ぐ。
// 原通貨・原金額・換算レート・換算方法は ocr_raw.foreign_currency に保存し、
// documents.amount には円換算額（換算できなければ null）を入れる。

/** 円換算の方法 */
export type ConversionMethod =
  /** 請求書に記載された換算レート（例: "conversion rate of 158.17"） */
  | "invoice_rate"
  /** 請求書の円建て記載（JCT額など）から逆算したレート */
  | "invoice_jpy_derived"
  /** 発行日（無ければ取り込み日）の市場レート（ECB参照レート） */
  | "market_rate"

/** 外貨建て書類の換算情報（ocr_raw.foreign_currency に保存する） */
export interface ForeignCurrencyInfo {
  /** 通貨コード（ISO 4217。例: USD） */
  currency: string
  /** 原通貨での金額（税込合計。例: 220） */
  amount_original: number | null
  /** 換算レート（1通貨あたりの円。換算できなければ null） */
  rate: number | null
  /** 換算方法（換算できなければ null） */
  method: ConversionMethod | null
  /** 市場レートの基準日（market_rate のときのみ） */
  rate_date: string | null
  /** 自動換算した円額（documents.amount の初期値。換算できなければ null） */
  amount_jpy: number | null
  /** 根拠の補足（例: "JCT amount in JPY ¥3,163 using a conversion rate of 158.17"） */
  evidence: string | null
}

/** 換算できなかったときの警告文（一覧の要確認マークの判定にも使う） */
export const CURRENCY_UNCONVERTED_WARNING_PREFIX = "外貨建ての書類ですが円に換算できませんでした"

export const CONVERSION_METHOD_LABEL: Record<ConversionMethod, string> = {
  invoice_rate: "請求書記載レート",
  invoice_jpy_derived: "請求書の円建て記載から逆算",
  market_rate: "市場レート",
}

/** 通貨記号 → 通貨コード */
const SYMBOL_TO_CODE: Array<[RegExp, string]> = [
  [/US\$|\$/, "USD"],
  [/€/, "EUR"],
  [/£/, "GBP"],
]

/** 表示用の通貨記号 */
const CODE_TO_SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" }

/**
 * AIの返した通貨表記を ISO 4217 コードに正規化する。
 * 円（JPY/円/¥）・不明は "JPY" を返す（既定は円のまま＝日本円の書類の挙動を変えない）。
 */
export function normalizeCurrencyCode(raw: unknown): string {
  if (typeof raw !== "string") return "JPY"
  const s = raw.trim().toUpperCase()
  if (!s) return "JPY"
  if (/^(JPY|YEN|円|¥|￥)$/.test(s)) return "JPY"
  if (/^[A-Z]{3}$/.test(s)) return s
  for (const [re, code] of SYMBOL_TO_CODE) {
    if (re.test(s)) return code
  }
  return "JPY"
}

/**
 * 書類テキストから外貨建てかどうかを判定する（AIの判定の裏づけ・補完用）。
 * 「$220.00」「220.00 USD」のような金額表記があるときだけ外貨とみなす。
 * 円の金額表記（¥・円）の方が多い書類は円建てとする（円建て請求書の欄外に $ がある程度では外貨にしない）。
 */
export function detectCurrencyFromText(text: string): string | null {
  if (!text) return null
  const counts: Record<string, number> = {}
  const add = (code: string, n: number) => {
    if (n > 0) counts[code] = (counts[code] ?? 0) + n
  }
  add("USD", (text.match(/(?:US)?\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?USD\b/g) ?? []).length)
  add("EUR", (text.match(/€\s?\d|\d[\d,.]*\s?(?:€|EUR\b)/g) ?? []).length)
  add("GBP", (text.match(/£\s?\d|\d[\d,.]*\s?GBP\b/g) ?? []).length)
  const jpy = (text.match(/[¥￥]\s?\d|\d[\d,]*\s?円|\d[\d,]*\s?JPY\b/g) ?? []).length

  let best: string | null = null
  let bestCount = 0
  for (const [code, n] of Object.entries(counts)) {
    if (n > bestCount) {
      best = code
      bestCount = n
    }
  }
  if (!best || bestCount <= jpy) return null
  return best
}

/**
 * 書類の通貨を確定する。
 * - 書類テキスト（PDFのテキストレイヤー等）に外貨の金額表記が円より多ければ、その通貨（AIが見落としても拾う）
 * - テキストに円の金額表記があれば円（AIが外貨と誤判定しても円建ての書類を壊さない）
 * - テキストが無い（画像・スキャンPDF）ときはAIの判定に従う
 */
export function decideCurrency(aiCurrency: unknown, sourceText: string): string {
  const fromText = detectCurrencyFromText(sourceText)
  if (fromText) return fromText
  if (/[¥￥]\s?\d|\d[\d,]*\s?円/.test(sourceText)) return "JPY"
  return normalizeCurrencyCode(aiCurrency)
}

/**
 * 書類テキストから「記載の換算レート」を取り出す。
 * 例: "JCT amount in JPY ¥3,163 using a conversion rate of 158.17." → 158.17
 */
export function extractStatedRate(text: string): { rate: number; evidence: string } | null {
  if (!text) return null
  const patterns = [
    /conversion rate (?:of|:)?\s*([\d,]+\.\d+|\d{2,4})/i,
    /exchange rate (?:of|:)?\s*([\d,]+\.\d+|\d{2,4})/i,
    /1\s*(?:USD|EUR|GBP|US\$|\$|€|£)\s*=\s*(?:JPY|¥|￥)?\s*([\d,]+(?:\.\d+)?)/i,
    /(?:換算|為替)レート[:：\s]*([\d,]+(?:\.\d+)?)/,
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (!m) continue
    const rate = Number(m[1].replace(/,/g, ""))
    if (isPlausibleJpyRate(rate)) {
      // 根拠として該当行を残す（長すぎる場合は前後を詰める）
      const line = text.split(/\r?\n/).find((l) => l.includes(m[0])) ?? m[0]
      // 制御文字（PDF抽出で混ざる \u0000 等）は jsonb に保存できないため空白にする
      // eslint-disable-next-line no-control-regex
      return { rate, evidence: line.replace(/[\u0000-\u001f\s]+/g, " ").trim().slice(0, 160) }
    }
  }
  return null
}

/**
 * 円換算レートとして妥当な範囲か（主要通貨の対円レートは概ね 50〜500）。
 * AIや正規表現が別の数字（請求書番号・日付など）を拾ったときの歯止め。
 */
export function isPlausibleJpyRate(rate: unknown): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate >= 50 && rate <= 500
}

/** 原通貨額 × レートを円に換算する（1円未満は四捨五入） */
export function convertToJpy(amountOriginal: number, rate: number): number {
  return Math.round(amountOriginal * rate)
}

/** ocr_raw から外貨情報を安全に取り出す（外貨でなければ null） */
export function readForeignCurrency(ocrRaw: unknown): ForeignCurrencyInfo | null {
  if (!ocrRaw || typeof ocrRaw !== "object") return null
  const fc = (ocrRaw as Record<string, unknown>).foreign_currency
  if (!fc || typeof fc !== "object") return null
  const o = fc as Record<string, unknown>
  if (typeof o.currency !== "string" || o.currency === "JPY") return null
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)
  const method = o.method === "invoice_rate" || o.method === "invoice_jpy_derived" || o.method === "market_rate"
    ? o.method
    : null
  return {
    currency: o.currency,
    amount_original: num(o.amount_original),
    rate: num(o.rate),
    method,
    rate_date: typeof o.rate_date === "string" ? o.rate_date : null,
    amount_jpy: num(o.amount_jpy),
    evidence: typeof o.evidence === "string" ? o.evidence : null,
  }
}

/** 原通貨額の表示（例: $220.00 / 220.00 CHF） */
export function formatOriginalAmount(currency: string, amount: number | null): string {
  if (amount === null) return `${currency}（金額不明）`
  const n = amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const sym = CODE_TO_SYMBOL[currency]
  return sym ? `${sym}${n}` : `${n} ${currency}`
}

/**
 * 外貨建て書類の円額の内訳表示（金額欄の副次表示・提出リスト用）。
 * - 自動換算のまま: "$220.00 @158.17（請求書記載レート）"
 * - 円額を手動で上書き済み: "$220.00・円額は手動入力（実効 @158.32）"
 * - 換算できていない: "$220.00・円換算が必要"
 */
export function describeForeignAmount(fc: ForeignCurrencyInfo, amountJpy: number | null): string {
  const orig = formatOriginalAmount(fc.currency, fc.amount_original)
  if (amountJpy === null || amountJpy === 0) return `${orig}・円換算が必要`
  if (fc.amount_jpy !== null && amountJpy === fc.amount_jpy && fc.rate !== null && fc.method) {
    const date = fc.method === "market_rate" && fc.rate_date ? ` ${fc.rate_date}` : ""
    return `${orig} @${fc.rate}（${CONVERSION_METHOD_LABEL[fc.method]}${date}）`
  }
  const effective = fc.amount_original ? ` 実効 @${(amountJpy / fc.amount_original).toFixed(2)}` : ""
  return `${orig}・円額は手動入力（${effective.trim() || "レート不明"}）`
}

/**
 * 提出リスト（CSV/xlsx）の外貨列の文言。税理士が検算できるよう通貨コード・原金額・レート・方法を全部書く。
 * 例: "USD 220.00 × 158.17 = ¥34,797（請求書記載レート）"
 */
export function describeForeignAmountForAccountant(fc: ForeignCurrencyInfo, amountJpy: number | null): string {
  const orig = fc.amount_original !== null
    ? `${fc.currency} ${fc.amount_original.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `${fc.currency}（金額不明）`
  if (amountJpy === null || amountJpy === 0) return `${orig}（円換算未了）`
  if (fc.amount_jpy !== null && amountJpy === fc.amount_jpy && fc.rate !== null && fc.method) {
    const date = fc.method === "market_rate" && fc.rate_date ? ` ${fc.rate_date}` : ""
    return `${orig} × ${fc.rate} = ¥${amountJpy.toLocaleString()}（${CONVERSION_METHOD_LABEL[fc.method]}${date}）`
  }
  const effective = fc.amount_original ? `実効レート ${(amountJpy / fc.amount_original).toFixed(2)}` : "レート不明"
  return `${orig} → ¥${amountJpy.toLocaleString()}（円額は手動入力・${effective}）`
}
