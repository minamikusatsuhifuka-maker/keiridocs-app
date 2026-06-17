// 支払いメモの重複判定ロジック（API・フロント共通）
// 判定基準: 金額(amount)の一致【必須】 ＋ 支払先(vendor_name)の一致
//   支払先は「正規化後の完全一致」または「一方が他方を包含する関係」を一致とみなす。
//   （例: 「クラウド会計ソフト」⊂「クラウド会計ソフト月額」のような表記ゆれを吸収するため）
//   一覧の重複マーク（フロント集計）と保存時チェック（API）の両方からこの判定を使い、
//   表示と警告が食い違わないようにする。

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
 * 金額を数値に正規化する。
 * カンマ・通貨記号（¥/￥/$）・「円」・空白を除去して数値化する。
 * 数値化できない場合は null（＝重複判定の対象外）。
 */
export function normalizeAmountValue(amount: number | string | null | undefined): number | null {
  if (typeof amount === "number") return Number.isNaN(amount) ? null : amount
  if (typeof amount === "string") {
    const n = Number(amount.replace(/[,，¥￥$\s円]/g, ""))
    return Number.isNaN(n) ? null : n
  }
  return null
}

/**
 * 支払先名が重複候補とみなせるか判定する。
 * - 正規化後に完全一致 → 一致
 * - 一方が他方を包含（前方一致・部分一致）→ 一致
 *   ただし短すぎる名前での誤検知を避けるため、短い方が3文字以上のときのみ包含を認める。
 */
export function vendorsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const va = normalizeVendor(a)
  const vb = normalizeVendor(b)
  if (!va || !vb) return false
  if (va === vb) return true
  // 包含関係（短い方が長い方に含まれる）。短い方が3文字以上のときのみ一致とみなす。
  const [short, long] = va.length <= vb.length ? [va, vb] : [vb, va]
  if (short.length >= 3 && long.includes(short)) return true
  return false
}

/** 重複判定に使う支払項目の最小情報 */
export interface DedupItem {
  vendor_name?: string | null
  amount?: number | string | null
}

/**
 * 2つの支払項目が重複候補かを判定する。
 * - 金額の一致を必須条件とする（金額が読み取れない＝nullの項目は対象外）
 * - その上で支払先名が一致（完全一致 or 包含関係）する場合のみ true
 * 金額一致を必須にすることで、毎月の定額など正当な別件の誤検知を抑える。
 */
export function isDuplicatePair(a: DedupItem, b: DedupItem): boolean {
  const amountA = normalizeAmountValue(a.amount)
  const amountB = normalizeAmountValue(b.amount)
  if (amountA === null || amountB === null || amountA !== amountB) return false
  return vendorsMatch(a.vendor_name, b.vendor_name)
}
