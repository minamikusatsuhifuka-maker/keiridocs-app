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

/* ---------- スタッフ立替の詳細区分（LINE 2階層選択） ---------- */

/**
 * LINE精算フローの2階層区分。
 * 第1階層（group）で「アチーブメント関連 / それ以外」を選び、第2階層で詳細を選ぶ。
 *
 * - fullLabel        … 確認画面表示・expense_detail カラム保存に使うフル名称
 * - buttonLabel      … LINEボタン/クイックリプライ用ラベル（20文字以内）
 * - subsidyCategory  … 支給率判定に使う主区分（achievement_repeat=半額 / other=全額）。
 *                      半額は「セミナー2回目以降」のみ。他はすべて other（全額）。
 */
export type ExpenseDetailKey =
  | "ach_first"
  | "ach_repeat"
  | "bento"
  | "transport"
  | "lodging"
  | "books"
  | "insurance"
  | "other"

export type ExpenseGroup = "ach" | "other"

export interface ExpenseDetailDef {
  key: ExpenseDetailKey
  group: ExpenseGroup
  fullLabel: string
  buttonLabel: string
  subsidyCategory: SubsidyCategory
  /**
   * 第2階層の一覧には出さず、特定の選択の下のサブ選択でのみ表示する区分。
   * 例: 「弁当代」は「セミナー2回目以降」を選んだ後のサブ選択でのみ提示する。
   */
  subOnly?: boolean
}

/** 第1階層グループのラベル */
export const EXPENSE_GROUP_LABELS: Record<ExpenseGroup, string> = {
  ach: "アチーブメント関連",
  other: "それ以外",
}

/** スタッフ立替の詳細区分定義（半額は ach_repeat のみ、他は全額） */
export const STAFF_EXPENSE_DETAILS: ExpenseDetailDef[] = [
  {
    key: "ach_first",
    group: "ach",
    fullLabel: "初回ATC＋アカデミー会員費",
    buttonLabel: "初回ATC＋アカデミー会員費",
    subsidyCategory: "other",
  },
  {
    key: "ach_repeat",
    group: "ach",
    fullLabel: "セミナー2回目以降（ATC再受講、ATC以外のコース）",
    buttonLabel: "セミナー2回目以降",
    subsidyCategory: "achievement_repeat",
  },
  {
    // 「セミナー2回目以降」配下の弁当代のみ全額。第2階層には出さずサブ選択でのみ提示する
    key: "bento",
    group: "ach",
    fullLabel: "弁当代",
    buttonLabel: "弁当代",
    subsidyCategory: "other",
    subOnly: true,
  },
  { key: "transport", group: "other", fullLabel: "交通費", buttonLabel: "交通費", subsidyCategory: "other" },
  { key: "lodging", group: "other", fullLabel: "宿泊費", buttonLabel: "宿泊費", subsidyCategory: "other" },
  { key: "books", group: "other", fullLabel: "書籍代", buttonLabel: "書籍代", subsidyCategory: "other" },
  {
    key: "insurance",
    group: "other",
    fullLabel: "当院での保険診療代",
    buttonLabel: "当院での保険診療代",
    subsidyCategory: "other",
  },
  { key: "other", group: "other", fullLabel: "その他", buttonLabel: "その他", subsidyCategory: "other" },
]

/** detailKey から詳細区分定義を取得（不正値は undefined） */
export function getExpenseDetail(key: string | null | undefined): ExpenseDetailDef | undefined {
  return STAFF_EXPENSE_DETAILS.find((d) => d.key === key)
}

/** 指定グループの詳細区分一覧（サブ選択専用＝subOnly は第2階層に出さない） */
export function expenseDetailsByGroup(group: ExpenseGroup): ExpenseDetailDef[] {
  return STAFF_EXPENSE_DETAILS.filter((d) => d.group === group && !d.subOnly)
}
