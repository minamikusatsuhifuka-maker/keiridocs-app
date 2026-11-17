/**
 * スタッフ立替の支給ルール（フェーズ2）。
 *
 * 規程の全体を**このファイル1箇所**に集約する。
 * 上限額・支給率を変える必要が出たら、ここだけを直せば全機能に反映される。
 *
 * ■ 規程
 *   【頂点への道（apex）】
 *     初回       受講料 全額 ／ 交通費＋宿泊費 合計30,000円まで全額 ／ 弁当代 全額
 *     2回目以降  受講料 半額 ／ 交通費＋宿泊費 30,000円で頭打ちにしてから半額 ／ 弁当代 全額
 *     ※初回は1人につき1回だけ
 *   【その他のアチーブメント講座（ach_other）】
 *     頂点への道の初回と同じ（半額にならない）。弁当代 対象
 *   【アチーブメント以外（non_ach）】
 *     受講料 全額 ／ 交通費＋宿泊費 合計30,000円まで ／ 弁当代 対象外
 *   【書籍代】【診療費】
 *     申請月（20日締め）ごとに各5,000円まで。互いに別枠
 *   【資格試験】
 *     合格通知・修了通知の添付があれば受験料 全額
 *   【交通費（通常業務）】【その他】
 *     全額・上限なし
 *
 * ■ 上限を超えた場合
 *   申請は拒否しない。支給額は上限で計算し、超過分は受付担当が
 *   追加支給額を入力して承認する（承認するまで確定しない）。
 *
 * ■ 弁当代の定義
 *   アチーブメントに事前申し込みした弁当のみ。各自が購入した弁当は対象外。
 */

/* ---------- 定数（規程の数値はここだけ） ---------- */

/** 交通費＋宿泊費の合計上限（講座1件あたり） */
export const TRAVEL_CAP_PER_COURSE = 30000

/** 書籍代の上限（申請月あたり） */
export const BOOKS_CAP_PER_MONTH = 5000

/** 診療費の上限（申請月あたり） */
export const MEDICAL_CAP_PER_MONTH = 5000

/** 頂点への道・2回目以降の支給率 */
export const REPEAT_RATE = 0.5

/* ---------- 区分 ---------- */

/** 講座の区分（講座マスタ courses.kind） */
export type CourseKind = "apex" | "ach_other" | "non_ach"

export const COURSE_KIND_LABELS: Record<CourseKind, string> = {
  apex: "頂点への道",
  ach_other: "その他のアチーブメント講座",
  non_ach: "アチーブメント以外のセミナー・研修",
}

/** 費用の内訳 */
export type ExpenseItem =
  | "tuition" // 受講料
  | "transport" // 交通費（研修）
  | "lodging" // 宿泊費
  | "bento" // 弁当代
  | "books" // 書籍代
  | "medical" // 診療費
  | "exam" // 受験料
  | "commute" // 交通費（通常業務）
  | "other" // その他

export const EXPENSE_ITEM_LABELS: Record<ExpenseItem, string> = {
  tuition: "受講料",
  transport: "交通費",
  lodging: "宿泊費",
  bento: "弁当代",
  books: "書籍代",
  medical: "診療費",
  exam: "受験料",
  commute: "交通費（通常業務）",
  other: "その他",
}

/** 交通費＋宿泊費の合計上限の対象になる内訳 */
export function isTravelItem(item: ExpenseItem): boolean {
  return item === "transport" || item === "lodging"
}

/** 弁当代を選べる講座か（アチーブメント以外では選べない） */
export function allowsBento(kind: CourseKind): boolean {
  return kind === "apex" || kind === "ach_other"
}

/** 選べる内訳（講座の区分で出し分ける。選べない区分はそもそも表示しない） */
export function availableItems(kind: CourseKind): ExpenseItem[] {
  const base: ExpenseItem[] = ["tuition", "transport", "lodging"]
  return allowsBento(kind) ? [...base, "bento"] : base
}

/* ---------- 支給額の計算 ---------- */

export interface SubsidyInput {
  /** 立替額（領収書の金額） */
  amount: number
  /** 内訳 */
  item: ExpenseItem
  /** 講座の区分（研修・セミナー以外は null） */
  courseKind?: CourseKind | null
  /** 頂点への道の2回目以降か（apex 以外では無視される） */
  isRepeat?: boolean
  /**
   * 同じ講座で既に上限枠を使った交通費＋宿泊費の**立替額**の合計。
   *
   * 支給額ではなく立替額を渡すこと。上限は立替額に対してかかり、
   * 支給率はそのあとで適用するため、支給額を渡すと枠が過大になる。
   * （transport / lodging のときだけ意味を持つ）
   */
  travelCapUsed?: number
  /**
   * 同じ申請月（20日締め）に既に上限枠を使った同一区分の**立替額**の合計。
   * 書籍代・診療費の月上限に使う。こちらも支給額ではなく立替額。
   */
  monthlyCapUsed?: number
}

export interface SubsidyResult {
  /** 支給額（上限と支給率を適用した確定分） */
  subsidy: number
  /** 上限を超えた立替額（0 なら超過なし）。担当の承認対象 */
  excess: number
  /** 適用した上限額（上限なしは null） */
  cap: number | null
  /** 適用した支給率 */
  rate: number
  /** スタッフと担当に見せる計算の根拠（1行） */
  reason: string
  /** 承認時に提示する追加支給額の既定値（超過分に支給率を適用した額） */
  suggestedApproval: number
}

/**
 * 支給額を計算する。
 *
 * **計算順序を変えないこと。** 上限 → 支給率 の順。
 * 逆にすると 交通費2万＋宿泊費2万＝4万（2回目以降）が
 * 2万（誤）になり、正しい1.5万より過大になる。
 */
export function computeSubsidy(input: SubsidyInput): SubsidyResult {
  const amount = Math.max(0, Math.floor(input.amount))
  const rate = resolveRate(input)
  const cap = resolveCap(input)

  // 上限なし（受講料・弁当代・通常業務の交通費・その他・受験料）
  if (cap === null) {
    return {
      subsidy: Math.floor(amount * rate),
      excess: 0,
      cap: null,
      rate,
      reason: rate === 1 ? "全額支給" : "半額支給",
      suggestedApproval: 0,
    }
  }

  // 上限あり。既に枠を使った立替額を差し引いた残枠で判定する
  const alreadyPaid = Math.max(
    0,
    Math.floor((isTravelItem(input.item) ? input.travelCapUsed : input.monthlyCapUsed) ?? 0)
  )
  const remaining = Math.max(0, cap - alreadyPaid)
  const covered = Math.min(amount, remaining)
  const excess = amount - covered

  return {
    subsidy: Math.floor(covered * rate),
    excess,
    cap,
    rate,
    reason: buildReason({ cap, remaining, alreadyPaid, excess, rate, item: input.item }),
    // 超過分を承認する場合の既定値。2回目以降なら超過分も半額にするのが規程どおり
    suggestedApproval: Math.floor(excess * rate),
  }
}

/**
 * 支給率（頂点への道の2回目以降だけ半額。他は全額）。
 *
 * 半額になるのは**受講料・交通費・宿泊費**の3つだけ。
 * 弁当代は「すべて全額支給」なので、2回目以降でも半額にしない。
 */
function resolveRate(input: SubsidyInput): number {
  if (input.item === "bento") return 1
  if (input.courseKind === "apex" && input.isRepeat) return REPEAT_RATE
  return 1
}

/** 適用する上限額（上限なしは null） */
function resolveCap(input: SubsidyInput): number | null {
  if (input.item === "books") return BOOKS_CAP_PER_MONTH
  if (input.item === "medical") return MEDICAL_CAP_PER_MONTH
  // 交通費＋宿泊費は研修に紐づくときだけ上限がある（通常業務の交通費は commute で上限なし）
  if (isTravelItem(input.item) && input.courseKind) return TRAVEL_CAP_PER_COURSE
  return null
}

function buildReason(p: {
  cap: number
  remaining: number
  alreadyPaid: number
  excess: number
  rate: number
  item: ExpenseItem
}): string {
  const unit = isTravelItem(p.item) ? "この講座" : "今月"
  const capText = `${unit}の上限 ${yen(p.cap)}`
  const rateText = p.rate === 1 ? "" : "（さらに半額支給）"

  if (p.excess > 0) {
    return p.alreadyPaid > 0
      ? `${capText}。既に ${yen(p.alreadyPaid)} 申請済みのため残り ${yen(p.remaining)} まで対象${rateText}`
      : `${capText}を ${yen(p.excess)} 超過${rateText}`
  }
  return p.alreadyPaid > 0
    ? `${capText}の範囲内（既に ${yen(p.alreadyPaid)} 申請済み）${rateText}`
    : `${capText}の範囲内${rateText}`
}

function yen(n: number): string {
  return `¥${n.toLocaleString("ja-JP")}`
}

/* ---------- 保存済みの明細から支給額を出す ---------- */

/**
 * 保存済みの明細から支給額を計算する（一覧・CSV・集計で共通に使う）。
 *
 * 上限の残枠は申請時点の履歴で決まるため、出力のたびに再計算すると
 * 過去の金額が後から変わってしまう。そこで申請時に確定した
 * 超過額（excess_amount）と承認額（approved_excess）を保存しておき、
 * ここでは**保存された値だけ**から組み立てる。
 *
 *   支給額 = (立替額 − 上限超過額) × 支給率 + 承認された追加支給額
 *
 * - excess_amount が NULL（フェーズ1までの明細）は従来どおり 立替額 × 支給率
 * - approved_excess が NULL（未承認）は加算しない。0 は「承認しない」で確定
 */
export function calcStoredSubsidy(row: {
  amount: number | null
  subsidy_category?: string | null
  expense_item?: string | null
  excess_amount?: number | null
  approved_excess?: number | null
}): number {
  const amount = Math.max(0, Math.floor(row.amount ?? 0))
  const excess = Math.max(0, Math.floor(row.excess_amount ?? 0))
  const covered = Math.max(0, amount - excess)
  // 弁当代は2回目以降でも全額（半額は受講料・交通費・宿泊費のみ）
  const rate = row.expense_item === "bento" ? 1 : row.subsidy_category === "achievement_repeat" ? REPEAT_RATE : 1
  const approved = Math.max(0, Math.floor(row.approved_excess ?? 0))
  return Math.floor(covered * rate) + approved
}

/* ---------- 保留の理由 ---------- */

/** 確定していない理由。NULL（確定済み）以外は税理士提出・支給集計に含めない */
export type HoldReason = "excess" | "course" | "attach"

export const HOLD_REASON_LABELS: Record<HoldReason, string> = {
  excess: "上限超過の承認待ち",
  course: "講座の割り当て待ち",
  attach: "合格通知の添付待ち",
}

/** スタッフに見せる保留の説明 */
export const HOLD_REASON_STAFF_TEXT: Record<HoldReason, string> = {
  excess: "上限を超えた分は、担当が確認のうえご連絡します。",
  course: "講座の確認が必要なため、担当が確認のうえご連絡します。",
  attach: "合格通知または修了通知の写真を送っていただくと確定します。",
}
