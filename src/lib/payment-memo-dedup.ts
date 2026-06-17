// 支払いメモの重複判定ロジック（API・フロント共通）
// 判定基準: 支払先(vendor_name)の正規化 ＋ 金額(amount)の一致

/**
 * 支払先名を正規化する。
 * - 前後空白除去（trim）
 * - Unicode NFKC正規化（全角→半角、半角カナ→全角カナ等の揺れを吸収）
 * - 連続空白を1つに圧縮、小文字化（大文字小文字の揺れ吸収）
 */
export function normalizeVendor(name: string | null | undefined): string {
  if (!name) return ""
  return name
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
}

/**
 * 重複判定用のキーを生成する。
 * 支払先が空、または金額が null の項目は重複判定の対象外（空文字キー）とする。
 */
export function dedupKey(vendorName: string | null | undefined, amount: number | null | undefined): string {
  const v = normalizeVendor(vendorName)
  if (!v || amount === null || amount === undefined || Number.isNaN(amount)) return ""
  return `${v}__${amount}`
}
