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
 *   次のものは枠に数えない。数えると実際には支給していない額で枠が埋まり、
 *   正しい申請が「上限超過・支給額0円」になってしまう。
 *     - テストスタッフ（staff_members.is_test）の申請
 *       … 会計士提出・給与集計から除外しているものを枠だけ数えるのは不整合
 *     - 本人が取り消した申請（staff_receipts.ai_raw.cancelled_at）
 *     - 担当が枠を数え直した日時より前の申請（line_profile.travel_cap_resets）
 *       … 再受講のたびに枠を数え直すため
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
import {
  academyStartDate,
  activeTestRunId,
  parseLineProfile,
  travelCapResetAt,
} from "@/lib/line-staff-profile"
import { formatYearMonth, resolveStaffSubmissionMonth } from "@/lib/submission-month"
import {
  computeSubsidy,
  isTravelItem,
  needsDetailReview,
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
  created_at: string | null
  /** 領収書の日付（支払日）。受講ごとに束ねる区切りに使う */
  transaction_date: string | null
}

export interface AssessInput {
  supabase: ServiceClient
  staffMemberId: string
  /**
   * 過去の実績から除く明細のID。
   *
   * 保存済みの明細を計算し直すときに必ず指定する。
   * 指定しないと、その明細自身が「過去の受講」「枠の使用済み」として
   * 数えられ、初受講が再受講に、上限が自分の金額で埋まった扱いになる。
   * 申請時は明細がまだ無いため、この問題は起きていなかった。
   */
  excludeTransactionId?: string | null
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
   * 同じ内容の申請が既にあるか（二重申請の疑い）。
   *
   * 同じスタッフ・同じ日付・同じ金額・同じ支払先の申請が既に確定している場合に true。
   * 二重に支給してしまうと取り返せないため、自動では確定させない。
   */
  duplicateSuspected?: boolean
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
  /** 交通費・宿泊費の枠を数え始めた時点。全期間を数えているなら null */
  capResetAt: string | null
  /** 枠を数えた範囲の決め方（all=講座の全期間／tuition=受講ごと／manual=担当の数え直し） */
  capWindowOrigin: TravelWindowOrigin
  /** 枠を数えた範囲の開始日（受講料の領収書の日付）。制限なしは null */
  capWindowFrom: string | null
  /** 枠を数えた範囲の終了日（次の受講の開始日）。制限なしは null */
  capWindowTo: string | null
  /** テストスタッフのため枠を数えていないか（テスト申請は枠を消費しない） */
  capSkippedForTest: boolean
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
      .select("id, amount, expense_item, course_id, excess_amount, staff_receipt_id, created_at, transaction_date")
      .eq("category", "staff_refund")
      .eq("staff_member_id", staffMemberId)
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: PriorRow[] | null
        error: { message: string } | null
      }>
  )

  // 2. 上限枠の消費分を数える。
  //    取り消した申請は数えない（数えると実際には支給していない額で枠が埋まり、
  //    正しい申請が支給0円になる）。
  //
  //    テスト実行中は、そのテスト実行で作られた申請だけを数える。
  //    本番の申請はテストの累計に入らず、テストの申請も本番の累計に入らない。
  const staffState = await fetchStaffCapState(supabase, staffMemberId, input.courseId ?? null)
  // 計算し直す本人の明細は「過去の実績」ではないので外す
  const others = input.excludeTransactionId
    ? priors.filter((p) => p.id !== input.excludeTransactionId)
    : priors
  const counted = await selectCountableRows(supabase, others, staffState.testRunId)

  // 交通費・宿泊費の枠は「受講ごと」に数える。
  // 区切りは領収書の日付（申請の順番では変わらないようにするため）
  const travelWindow = resolveTravelWindow(
    counted,
    input.courseId ?? null,
    staffState.travelCapResetAt,
    input.judgeDate ?? null
  )

  const capUsed = isTravelItem(item)
    ? sumCapUsed(
        counted
          .filter(
            (p) =>
              p.course_id &&
              p.course_id === input.courseId &&
              isTravelItem(p.expense_item as ExpenseItem)
          )
          .filter((p) => isInTravelWindow(p, travelWindow))
      )
    : item === "books" || item === "medical"
      ? sumCapUsed(
          await filterSameSubmissionMonth(
            supabase,
            counted.filter((p) => p.expense_item === item),
            input
          )
        )
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

  // 取り消した申請・テスト申請は受講実績に数えない（counted を使う）
  const inApp =
    input.courseRule === "atc" && input.courseId
      ? counted.filter((p) => p.course_id === input.courseId && p.expense_item === "tuition").length
      : 0

  const priorTuitionCount = registered.count + inApp

  /*
   * 交通費・宿泊費の支給率を決めるための「過去の受講回数」。
   *
   * 今回の受講の受講料は、過去の受講に数えてはいけない。
   * 初受講でも受講料を先に申請していると inApp が1になり、
   * そのあとの交通費・宿泊費が再受講（半額）と判定されていた。
   *
   * 枠の区切り（travelWindow）が受講料の領収書で開かれている場合、
   * その1件が「今回の受講」の受講料なので差し引く。
   */
  const tuitionOfThisAttendance =
    isTravelItem(item) && travelWindow.origin === "tuition" ? 1 : 0
  const priorTuitionForTravel = Math.max(0, priorTuitionCount - tuitionOfThisAttendance)

  // 交通費・宿泊費も半額の回は半額にするため、受講料の実績から半額かどうかを引き継ぐ
  const isRepeat =
    input.courseRule === "atc"
      ? isTravelItem(item)
        ? priorTuitionForTravel > 0
        : priorTuitionCount > 0
      : // 旧式（別の講座の実績があれば2回目以降）
        input.courseKind === "apex" &&
        counted.some((p) => p.course_id && p.course_id !== input.courseId)

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
  // 二重払いは取り返せないため最優先で止める
  if (input.duplicateSuspected) holdReason = "dup"
  else if (input.commuterPassIncluded) holdReason = "pass"
  // 「その他」は規程に当てはめられないため、必ず担当が内容を見て判断する
  else if (needsDetailReview(item)) holdReason = "detail"
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
    capResetAt: travelWindow.manualAt,
    capWindowOrigin: travelWindow.origin,
    capWindowFrom: travelWindow.fromDate,
    capWindowTo: travelWindow.toDate,
    capSkippedForTest: staffState.isTest,
  }
}

/**
 * 枠の判定に使うスタッフの状態を読む。
 *
 * - isTest             … テストスタッフか（テスト申請は枠を消費しない）
 * - travelCapResetAt   … その講座の枠を最後に数え直した日時
 */
async function fetchStaffCapState(
  supabase: ServiceClient,
  staffMemberId: string,
  courseId: string | null
): Promise<{ isTest: boolean; travelCapResetAt: string | null; testRunId: string | null }> {
  try {
    const { data, error } = await supabase
      .from("staff_members")
      .select("is_test, line_profile")
      .eq("id", staffMemberId)
      .maybeSingle()
    if (error || !data) return { isTest: false, travelCapResetAt: null, testRunId: null }
    const row = data as { is_test?: boolean | null; line_profile?: unknown }
    return {
      isTest: !!row.is_test,
      travelCapResetAt: travelCapResetAt(row.line_profile, courseId),
      testRunId: activeTestRunId(row.line_profile),
    }
  } catch {
    // 読めないときは枠を数える側に倒す（過大支給を防ぐ）
    return { isTest: false, travelCapResetAt: null, testRunId: null }
  }
}

/** 交通費・宿泊費の枠を、どの範囲で数えるか */
export type TravelWindowOrigin = "all" | "tuition" | "manual"

/** 交通費・宿泊費の枠を数える範囲 */
export interface TravelWindow {
  /** この日以降の領収書を数える（YYYY-MM-DD）。制限なしは null */
  fromDate: string | null
  /** この日より前の領収書を数える（次の受講の開始日）。制限なしは null */
  toDate: string | null
  /** この日時より後に申請した分だけを数える（担当の数え直し）。無ければ null */
  manualAt: string | null
  origin: TravelWindowOrigin
}

/**
 * 交通費・宿泊費の枠（講座ごと30,000円）を数える範囲を決める。
 *
 * ■ なぜ範囲が必要か
 * 枠は「講座ごと」だが、講座マスタは同じ講座名を再受講でも使い回すため、
 * 講座の生涯累計で数えると1回目の受講で枠を使い切り、
 * 2回目以降の交通費が全額「上限超過・支給額0円」になってしまう。
 *
 * ■ 受講ごとに束ねる（tuition）
 * **領収書の日付**で束ねる。申請した順番ではなく、支払った日で決める。
 *
 *   受講料の領収書の日付を区切りとして、
 *   「その受講料の日付以降、次の受講料の日付より前」の交通費・宿泊費を
 *   1つの受講分として累計する。
 *
 * 申請の順番は本人任せで管理できない（新幹線を先に出す、受講料を後で出すなど）。
 * 提出日時で区切ると、受講料を挟んだ前後で同じ移動の交通費が別の受講に
 * 分かれてしまい、累計されない。領収書の日付は申請の順番で変わらないため、
 * どの順で出しても同じ結果になる。
 *
 * ■ 手動の数え直し（manual）
 * 担当が数え直した場合は、それより後に申請した分だけを数える。
 * 日付の束ねと併用する（両方を満たすものだけが枠に入る）。
 *
 * @param judgeDate 今回の申請の領収書の日付（YYYY-MM-DD）。読めていなければ null
 */
export function resolveTravelWindow(
  counted: PriorRow[],
  courseId: string | null,
  manualResetAt: string | null,
  judgeDate: string | null
): TravelWindow {
  const base: TravelWindow = {
    fromDate: null,
    toDate: null,
    manualAt: manualResetAt,
    origin: manualResetAt ? "manual" : "all",
  }
  if (!courseId) return base

  // その講座の受講料の領収書の日付（古い順）
  const tuitionDates = Array.from(
    new Set(
      counted
        .filter((p) => p.course_id === courseId && p.expense_item === "tuition")
        .map((p) => (p.transaction_date ?? "").slice(0, 10))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    )
  ).sort()
  if (tuitionDates.length === 0) return base

  // 今回の領収書の日付が読めていない場合は束ねない（全期間を数える＝安全側）
  const d = (judgeDate ?? "").slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return base

  // 今回の日付が属する受講 = その日以前で最も新しい受講料の日付
  const fromDate = tuitionDates.filter((t) => t <= d).pop() ?? null
  // 次の受講の開始日（そこから先は別の受講の枠）
  const toDate = tuitionDates.find((t) => t > (fromDate ?? d)) ?? null

  return {
    fromDate,
    toDate,
    manualAt: manualResetAt,
    origin: fromDate ? "tuition" : base.origin,
  }
}

/** その明細を枠に数えるか（受講の範囲内かつ、担当の数え直しより後か） */
function isInTravelWindow(row: PriorRow, w: TravelWindow): boolean {
  if (w.manualAt && row.created_at && row.created_at <= w.manualAt) return false
  const d = (row.transaction_date ?? "").slice(0, 10)
  // 日付が無いものは安全側（枠に数える）
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return true
  if (w.fromDate && d < w.fromDate) return false
  if (w.toDate && d >= w.toDate) return false
  return true
}

/**
 * 枠の計算に数える明細だけを選ぶ。
 *
 * 次のものは数えない。
 *  - 本人が取り消した申請（ai_raw.cancelled_at）
 *    取り消し時に明細も消しているため通常は残らないが、削除に失敗した場合や
 *    管理画面からの操作で残ることがある。枠だけが埋まって正しい申請が
 *    支給0円になるのを防ぐため、ここでも除外する。
 *  - いまのテスト実行と関係のない申請
 *    テスト実行中（testRunId あり）は、そのテスト実行で作られた申請だけを数える。
 *    本番のときは、テスト実行の印が付いた申請を数えない。
 *    こうしないと、テストの申請が本番の枠を食ったり、
 *    本番の申請でテストの累計が埋まったりする。
 *
 * 手で登録した明細（staff_receipt_id が無い）は本番として扱う。
 */
/** ai_raw をオブジェクトとして読む（読めなければ空） */
function readAiRaw(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // 読めない場合は空として扱う
    }
  }
  return {}
}

async function selectCountableRows(
  supabase: ServiceClient,
  rows: PriorRow[],
  testRunId: string | null
): Promise<PriorRow[]> {
  const receiptIds = Array.from(
    new Set(rows.map((r) => r.staff_receipt_id).filter((v): v is string => !!v))
  )
  // 記録が無い＝手で登録した明細だけ。テスト実行中は数えない
  if (receiptIds.length === 0) return testRunId ? [] : rows

  try {
    type Meta = { id: string; ai_raw: unknown }
    const metas = await fetchAllRows<Meta>((from, to) =>
      supabase
        .from("staff_receipts")
        .select("id, ai_raw")
        .in("id", receiptIds)
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
          data: Meta[] | null
          error: { message: string } | null
        }>
    )
    const byId = new Map(metas.map((m) => [m.id, readAiRaw(m.ai_raw)]))

    return rows.filter((r) => {
      if (!r.staff_receipt_id) return !testRunId // 手で登録した明細は本番扱い
      const raw = byId.get(r.staff_receipt_id)
      if (!raw) return !testRunId
      if (raw.cancelled_at) return false
      const rowRun = typeof raw.test_run_id === "string" ? raw.test_run_id : null
      return testRunId ? rowRun === testRunId : rowRun === null
    })
  } catch {
    // 判定できないときは安全側に倒す
    // （本番は全件を数えて過大支給を防ぐ。テストは数えない）
    return testRunId ? [] : rows
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
