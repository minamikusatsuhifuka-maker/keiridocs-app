"use client"

import { Badge } from "@/components/ui/badge"
import { payEasyBadgeLabel, payEasyState } from "@/lib/payeasy"

/**
 * 一覧に出す Pay-easy の印。
 *
 * 既存の「⚠要振込」バッジと同じ場所・同じ見え方にそろえる。
 * 納付の進み具合が一目で分かるよう、2枚のうち何枚済んだかも出す。
 *
 *   💳 Pay-easy      … 未納付
 *   💳 Pay-easy 1/2  … 2枚のうち1枚だけ納付済み
 *   ✓ 納付済み        … すべて納付済み
 *   💳 要確認         … 納付書だが番号が足りない
 *
 * Pay-easy の書類でなければ何も出さない。
 */
export function PayEasyBadge({ ocrRaw, className }: { ocrRaw: unknown; className?: string }) {
  const label = payEasyBadgeLabel(ocrRaw)
  if (!label) return null

  const state = payEasyState(ocrRaw)
  const tone =
    state.status === "paid"
      ? "border-emerald-500 text-emerald-700 dark:text-emerald-400"
      : state.status === "partial"
        ? "border-amber-500 text-amber-700 dark:text-amber-400"
        : state.status === "incomplete"
          ? "border-rose-500 text-rose-700 dark:text-rose-400"
          : "border-sky-500 text-sky-700 dark:text-sky-400"

  const title =
    state.status === "incomplete"
      ? "Pay-easyの納付書ですが、番号が読み取れていません。書類詳細で確認してください"
      : state.status === "partial"
        ? `${state.total}枚のうち${state.paid}枚が納付済みです`
        : state.status === "paid"
          ? "すべて納付済みです"
          : "Pay-easyで納付する書類です"

  return (
    <Badge variant="outline" className={`${tone} ${className ?? ""}`} title={title}>
      {label}
    </Badge>
  )
}
