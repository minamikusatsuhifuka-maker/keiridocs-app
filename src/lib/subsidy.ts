/**
 * アチーブメント参加区分による支給率・支給額の共通ロジック。
 *
 * 区分（subsidy_category）:
 *  - achievement_first  … アチーブメント初参加（全額・支給率1.0）
 *  - achievement_repeat … アチーブメント2回目以降（半額・支給率0.5）
 *  - other              … それ以外（全額・支給率1.0）
 *  - NULL（既存データ）  … 後方互換で全額（支給率1.0）扱い
 *
 * 立替額（amount）と区分は記録時に保存し、支給額は資料出力時に本関数で計算する。
 */

/** アチーブメント参加区分 */
export type SubsidyCategory = "achievement_first" | "achievement_repeat" | "other"

/** 区分の日本語ラベル（LINE・UI・CSV共通で利用） */
export const SUBSIDY_LABELS: Record<SubsidyCategory, string> = {
  achievement_first: "アチーブメント初参加",
  achievement_repeat: "アチーブメント2回目以降",
  other: "それ以外",
}

/** 区分の選択肢（既定は「それ以外」） */
export const SUBSIDY_OPTIONS: { value: SubsidyCategory; label: string }[] = [
  { value: "achievement_first", label: SUBSIDY_LABELS.achievement_first },
  { value: "achievement_repeat", label: SUBSIDY_LABELS.achievement_repeat },
  { value: "other", label: SUBSIDY_LABELS.other },
]

/** 任意値を有効な区分に正規化（不正・未指定は 'other' = 全額） */
export function normalizeSubsidyCategory(value: unknown): SubsidyCategory {
  if (value === "achievement_first" || value === "achievement_repeat" || value === "other") {
    return value
  }
  return "other"
}

/** 区分の支給率（2回目以降のみ0.5、それ以外・NULLは1.0） */
export function subsidyRate(category: string | null | undefined): number {
  return category === "achievement_repeat" ? 0.5 : 1.0
}

/**
 * 支給額を計算する。
 * 支給額 = 立替額 × 支給率（achievement_repeat のみ0.5）。半額の端数は切り捨て（Math.floor）。
 * other / achievement_first / NULL（既存データ）は全額（支給率1.0）として扱う。
 */
export function calcSubsidy(amount: number, category: string | null | undefined): number {
  const rate = category === "achievement_repeat" ? 0.5 : 1.0
  return Math.floor(amount * rate)
}

/** 区分ラベル（NULL・不正値は「それ以外」表記） */
export function subsidyLabel(category: string | null | undefined): string {
  return SUBSIDY_LABELS[normalizeSubsidyCategory(category)]
}
