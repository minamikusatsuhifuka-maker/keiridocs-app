/**
 * 支給額の判定（DBを見て上限の残枠を出し、computeSubsidy に渡す）。
 *
 * 規程そのもの（上限額・支給率・計算順序）は subsidy-rules.ts にある。
 * このファイルは「過去の申請をどう数えるか」だけを担う。
 *
 * ■ 上限枠の数え方
 *   上限は**立替額**にかかる。既に枠を使った額は
 *     Σ（立替額 − 上限超過額）
 *   で求める。超過分は枠を使っていない（担当が承認すれば枠外で加算される）ため差し引く。
 *
 * ■ 交通費＋宿泊費（講座ごと 30,000円）
 *   同じスタッフ・同じ講座の transport / lodging を合算する。
 *
 * ■ 書籍代・診療費（申請月ごと 5,000円）
 *   提出月（20日締め。手動指定があればそれ）が同じ同一区分を合算する。
 *   互いに別枠なので区分ごとに数える。
 *
 * ■ 初回／2回目以降（頂点への道）
 *   そのスタッフに「頂点への道」の**別の講座**の申請実績があれば2回目以降。
 *   初回は1人につき1回だけ。
 */

import { fetchAllRows } from "@/lib/supabase/fetch-all"
import { academyStartDate, parseLineProfile } from "@/lib/line-staff-profile"
import { formatYearMonth, resolveStaffSubmissionMonth } from "@/lib/submission-month"
import {
  computeSubsidy,
  isCourseOtherItem,
  isTravelItem,
  type CourseKind,
  type CourseRule,
  type ExpenseItem,
  type HoldReason,
  type SubsidyResult,
  isWithinAcademyTerm,
} from "@/lib/subsidy-rules"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"

type ServiceClient = SupabaseClient<Database>

/** 上限の合算に必要な過去の明細 */
interface PriorRow {
  id: string
  amount: number | null
  expense_item: string | null
  course_id: string | null
  excess_amount: number | null
  staff_receipt_id: string | null
}

export interface AssessInput {
  supabase: ServiceClient
  staffMemberId: string
  /** 立替額（領収書の金額） */
  amount: number
  item: ExpenseItem
  /** 研修・セミナーの場合の講座。講座マスタに無い場合は null＋pendingCourseName */
  courseId?: string | null
  courseKind?: CourseKind | null
  /** 講座の支給率の方式（courses.rule）。undecided なら担当の判断待ちにする */
  courseRule?: CourseRule | null
  /** 講座マスタに無い講座名で申請された場合 */
  pendingCourseName?: string | null
  /** 資格試験で合格通知・修了通知が未添付か */
  awaitingAttachment?: boolean
  /**
   * 交通費の金額に定期券区間の運賃が含まれている可能性があるか。
   *
   * ICカードは定期券区間を引き落とさないので通常は false。
   * 切符を買った場合や本人が分からない場合に true にし、担当の確認待ちにする。
   */
  commuterPassIncluded?: boolean
  /**
   * 支給の判定に使う日付（YYYY-MM-DD）。領収書の日付（支払日）を渡すこと。
   *
   * アカデミー会員の有効期間（3年）の判定に使う。
   * 20日締めの都合で申請が翌月になることがあるため、申請日で判定すると
   * 期限内に受講したものまで期限切れと判断されてしまう。
   * 読み取れていない場合は null（判定できないので担当の確認待ちになる）。
   */
  judgeDate?: string | null
  /** 提出日（20日締めの月割りに使う。既定は今） */
  submittedAt?: Date
  /** 提出月の手動指定（staff_receipts.ai_raw.submission_month） */
  manualSubmissionMonthRaw?: unknown
}

export interface AssessResult extends SubsidyResult {
  /** 初回／2回目以降の判定結果（頂点への道のみ意味を持つ） */
  isRepeat: boolean
  /** 2回目以降と判断した根拠の講座ID（記録用） */
  repeatBasisCourseId: string | null
  /** ATC方式での、これまでの受講料申請の回数（0 なら初回） */
  priorTuitionCount: number
  /** 確定していない理由。NULL なら確定 */
  holdReason: HoldReason | null
  /** 上限枠のうち既に使った立替額 */
  capUsed: number
}

/**
 * 支給額を判定する。
 *
 * 保留（holdReason）が付いた明細は、承認・割り当て・添付が済むまで
 * 税理士提出と支給集計に含めないこと。
 */
export async function assessSubsidy(input: AssessInput): Promise<AssessResult> {
  const { supabase, staffMemberId, amount, item } = input

  // 1. 同じスタッフのスタッフ立替明細を全件取得（PostgRESTの1000件上限に当たると上限判定が狂う）
  const priors = await fetchAllRows<PriorRow>((from, to) =>
    supabase
      .from("petty_cash_transactions")
      .select("id, amount, expense_item, course_id, excess_amount, staff_receipt_id")
      .eq("category", "staff_refund")
      .eq("staff_member_id", staffMemberId)
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: PriorRow[] | null
        error: { message: string } | null
      }>
  )

  // 2. 上限枠の消費分を数える
  const capUsed = isTravelItem(item)
    ? sumCapUsed(priors.filter((p) => p.course_id && p.course_id === input.courseId && isTravelItem(p.expense_item as ExpenseItem)))
    : item === "books" || item === "medical"
      ? sumCapUsed(await filterSameSubmissionMonth(supabase, priors.filter((p) => p.expense_item === item), input))
      : 0

  // 3. ATC方式の再受講の回数。
  //    同じ講座を繰り返し受講するため、講座の違いではなく
  //    「その講座の受講料を何回受講したか」で数える。
  //
  //    アプリ導入前の受講や旧LINEからの申請は講座の情報を持たないため自動では数えられない。
  //    登録しないと既受講者が「初受講＝全額支給」と判定され過大支給になるので、
  //    担当が登録した既受講回数（line_profile.prior_courses）を足す。
  const registered =
    input.courseRule === "atc" && input.courseId
      ? await fetchRegisteredPriorCount(supabase, staffMemberId, input.courseId)
      : { count: 0, registered: true }

  const inApp =
    input.courseRule === "atc" && input.courseId
      ? priors.filter((p) => p.course_id === input.courseId && p.expense_item === "tuition").length
      : 0

  const priorTuitionCount = registered.count + inApp

  // 交通費・宿泊費も半額の回は半額にするため、受講料の実績から半額かどうかを引き継ぐ
  const isRepeat =
    input.courseRule === "atc"
      ? priorTuitionCount > 0 ||
        priors.some((p) => p.course_id === input.courseId && p.expense_item === "tuition")
      : // 旧式（別の講座の実績があれば2回目以降）
        input.courseKind === "apex" &&
        priors.some((p) => p.course_id && p.course_id !== input.courseId)

  // 4. 規程どおりに計算する
  const result = computeSubsidy({
    amount,
    item,
    courseKind: input.courseKind ?? null,
    courseRule: input.courseRule ?? null,
    priorTuitionCount: item === "tuition" ? priorTuitionCount : isRepeat ? 1 : 0,
    isRepeat,
    travelCapUsed: isTravelItem(item) ? capUsed : undefined,
    monthlyCapUsed: item === "books" || item === "medical" ? capUsed : undefined,
  })

  // 5. 保留の理由
  //    優先順：添付待ち → 講座の割り当て → 既受講回数が未登録 → 支給率が未定 → 上限超過
  //    既受講回数が未登録のまま確定させると、既受講者に全額を支給してしまうため保留する。
  //    入力漏れでも過大支給にならないよう、登録が無い＝保留とする（0回の登録とは区別する）。
  // アカデミー会員の有効期間（3年で6回）の判定。
  // 再受講の権利が切れたあとの扱いは未定のため、自動で支給せず担当の確認待ちにする。
  // 判定は領収書の日付で行う（申請が翌月になっても期限内なら通常どおり処理する）。
  const academyOutOfTerm =
    input.courseRule === "atc" && item === "tuition" && priorTuitionCount > 0
      ? await isAcademyOutOfTerm(supabase, staffMemberId, input.judgeDate)
      : false

  let holdReason: HoldReason | null = null
  // 定期券区間が金額に含まれている可能性があるものは、院が払う通勤手当との
  // 二重払いになるため自動で確定させない（差し引く額は担当が判断する）。
  if (input.commuterPassIncluded) holdReason = "pass"
  // 講座に紐づく「その他」は規程に当てはめられないため担当が判断する
  else if (isCourseOtherItem(item, input.courseId)) holdReason = "detail"
  else if (academyOutOfTerm) holdReason = "term"
  else if (input.awaitingAttachment) holdReason = "attach"
  else if (input.pendingCourseName && !input.courseId) holdReason = "course"
  else if (!registered.registered && item === "tuition") holdReason = "history"
  else if (result.needsDecision) holdReason = "undecided"
  else if (result.excess > 0) holdReason = "excess"

  return {
    ...result,
    isRepeat,
    repeatBasisCourseId: null,
    priorTuitionCount,
    holdReason,
    capUsed,
  }
}

/**
 * アカデミー会員の有効期間の外か（＝自動で支給してよくないか）。
 *
 * - 開始日が未登録     → true（担当が確認して登録してから確定する）
 * - 判定日が読めない   → true（期限内か分からないまま支給しない）
 * - 期限を過ぎている   → true
 * - 期間内            → false
 */
async function isAcademyOutOfTerm(
  supabase: ServiceClient,
  staffMemberId: string,
  judgeDate: string | null | undefined
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("staff_members")
      .select("line_profile")
      .eq("id", staffMemberId)
      .maybeSingle()
    if (error || !data) return true
    const start = academyStartDate((data as { line_profile?: unknown }).line_profile)
    if (!start) return true
    const within = isWithinAcademyTerm(start, judgeDate)
    return within !== true
  } catch {
    // 判定できないときに支給してしまうと取り返せないため、保留側に倒す
    return true
  }
}

/** 上限枠を使った立替額の合計（超過分は枠を使っていないので差し引く） */
function sumCapUsed(rows: PriorRow[]): number {
  return rows.reduce((sum, r) => {
    const amount = r.amount ?? 0
    const excess = r.excess_amount ?? 0
    return sum + Math.max(0, amount - excess)
  }, 0)
}

/**
 * 同じ提出月（20日締め）の明細だけに絞る。
 *
 * 提出月は staff_receipts.created_at から判定し、手動指定（ai_raw.submission_month）があれば
 * そちらを優先する。既存の月割りロジックを使い、ここで独自に計算しないこと。
 */
async function filterSameSubmissionMonth(
  supabase: ServiceClient,
  rows: PriorRow[],
  input: AssessInput
): Promise<PriorRow[]> {
  const target = targetSubmissionMonth(input)
  if (!target) return []

  const receiptIds = rows.map((r) => r.staff_receipt_id).filter((v): v is string => !!v)
  if (receiptIds.length === 0) return []

  const receipts = await fetchAllRows<{ id: string; created_at: string; ai_raw: unknown }>(
    (from, to) =>
      supabase
        .from("staff_receipts")
        .select("id, created_at, ai_raw")
        .in("id", receiptIds)
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
          data: { id: string; created_at: string; ai_raw: unknown }[] | null
          error: { message: string } | null
        }>
  )

  // 手動指定（ai_raw.submission_month）優先・無ければ提出日の20日締め。既存ロジックに任せる
  const monthById = new Map(
    receipts.map((rc) => {
      const resolved = resolveStaffSubmissionMonth(rc.ai_raw, rc.created_at).month
      return [rc.id, resolved ? formatYearMonth(resolved) : ""]
    })
  )

  return rows.filter((r) => r.staff_receipt_id && monthById.get(r.staff_receipt_id) === target)
}

/** 今回の申請の提出月（"YYYY-MM"） */
function targetSubmissionMonth(input: AssessInput): string | null {
  const submitDate = (input.submittedAt ?? new Date()).toISOString()
  const resolved = resolveStaffSubmissionMonth(input.manualSubmissionMonthRaw, submitDate).month
  return resolved ? formatYearMonth(resolved) : null
}

/**
 * 担当が登録した既受講回数を読む。
 *
 * @returns count=登録された回数／registered=登録そのものがあるか
 *          （未登録と「0回」を区別する。未登録は保留にして過大支給を防ぐ）
 */
async function fetchRegisteredPriorCount(
  supabase: ServiceClient,
  staffMemberId: string,
  courseId: string
): Promise<{ count: number; registered: boolean }> {
  const { data, error } = await supabase
    .from("staff_members")
    .select("line_profile")
    .eq("id", staffMemberId)
    .single()
  if (error || !data) return { count: 0, registered: false }

  const profile = parseLineProfile(data.line_profile)
  const entry = (profile.prior_courses ?? []).find((p) => p.course_id === courseId)
  if (!entry) return { count: 0, registered: false }
  return { count: Math.max(0, Math.floor(entry.count)), registered: true }
}
