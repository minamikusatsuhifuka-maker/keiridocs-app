// Gemini解析まわりの共有定義（型・選択肢・モデル定数）
//
// クライアントコンポーネントからも読まれるため、このファイルには
// Node専用API（node:module / node:path など）やサーバー専用の処理を置かないこと。
// 実際のAI呼び出しはサーバー専用の lib/gemini.ts 側に置く。

/**
 * 現行のGeminiモデル。モデル移行時はこの1行だけを書き換える。
 * ロールバック: この値を PREVIOUS_GEMINI_MODEL の値に戻して再デプロイすれば全AI機能が旧モデルに戻る。
 */
export const CURRENT_GEMINI_MODEL = "gemini-3.7-flash"

/** 直前世代のモデル（ロールバック先） */
export const PREVIOUS_GEMINI_MODEL = "gemini-3.5-flash"

/**
 * デフォルトのGeminiモデル。
 * 環境変数 GEMINI_MODEL が最優先（緊急の切り戻し用。設定されていればそのまま使う）。
 * 未設定時は CURRENT_GEMINI_MODEL。
 */
export const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || CURRENT_GEMINI_MODEL

/**
 * 選択可能なGeminiモデル一覧（設定画面のドロップダウン用）。
 * ここに載っていないモデルIDは resolveGeminiModel で無効として扱う（DBに旧モデルIDが残っていても現行モデルに寄せるため）。
 */
export const GEMINI_MODELS = [
  { id: CURRENT_GEMINI_MODEL, label: "Gemini 3.7 Flash", description: "高速・高精度・マルチモーダル対応（デフォルト）" },
] as const

/**
 * 設定（Supabase settings の gemini_model）に保存されたモデルIDを検証して解決する。
 * GEMINI_MODELS に無い値（旧世代のモデルIDが残っている等）は無視して DEFAULT_GEMINI_MODEL を返す。
 */
export function resolveGeminiModel(raw: unknown): string {
  if (typeof raw === "string") {
    const known = (GEMINI_MODELS as readonly { id: string }[]).some((m) => m.id === raw)
    if (known) return raw
  }
  return DEFAULT_GEMINI_MODEL
}

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

/** 分割支払い候補の型（1ファイルに独立した支払いが複数含まれる場合の1件分） */
export interface SplitPayment {
  vendor_name: string
  amount: number | null
  issue_date: string | null
  due_date: string | null
  description: string | null
  tax_category: string | null
  account_title: string | null
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
  /** 独立した複数支払いの分割候補（単一支払いの書類なら空配列） */
  payments: SplitPayment[]
  /**
   * 解析結果の信頼性に関する警告（人が必ず確認すべき点）。
   * 例: 取引先名が書類のテキストに見つからない（AIの推測の可能性）。
   */
  warnings: string[]
}

/** 取引先名がAIの推測だった疑いがあるときの警告文 */
export const VENDOR_UNVERIFIED_WARNING =
  "取引先名が書類内の文字と一致しません。AIの推測の可能性があるため必ず確認してください"
