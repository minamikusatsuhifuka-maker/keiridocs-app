import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database, Json } from "@/types/database"

/**
 * LINE申請用のスタッフ設定（staff_members.line_profile jsonb・migration 041）。
 *
 * - 定期券・初回設定の完了状態・最終申請日時・氏名変更申請を1つの jsonb にまとめて持つ。
 *   項目を増やすときは LineProfile に足すだけでよい（スキーマ変更不要）。
 * - 列が未適用（migration 041 未実行／スキーマキャッシュ未反映）の場合は available=false を返し、
 *   呼び出し側は「定期券の質問・初回設定の差し込み」を行わず従来どおり動かす。
 */

type Client = SupabaseClient<Database>

/** 定期券の登録内容。has=false は「定期券なし」（以降いっさい質問しない） */
export interface CommuterPass {
  has: boolean
  from?: string
  from_pref?: string
  to?: string
  to_pref?: string
  updated_at?: string
}

/**
 * 通勤手段。定期券を聞くかどうかの判断に使う。
 * - train: 電車 → 定期券の有無と区間を聞く
 * - car / bicycle_walk: 車・自転車・徒歩 → 定期券は「なし」で確定し、以降いっさい聞かない
 * - other: その他 → 念のため定期券の有無を聞く
 */
export type CommuteMethod = "train" | "car" | "bicycle_walk" | "other"

/** 通勤手段が定期券を持ちうるか（持ちえない手段では定期券を質問しない） */
export function mayHaveCommuterPass(method: CommuteMethod): boolean {
  return method === "train" || method === "other"
}

const COMMUTE_METHOD_LABELS: Record<CommuteMethod, string> = {
  train: "電車",
  car: "車",
  bicycle_walk: "自転車・徒歩",
  other: "その他",
}

/** 通勤手段の表示名（未回答は「未回答」） */
export function commuteMethodLabel(profile: LineProfile): string {
  const m = profile.commute_method
  return m ? COMMUTE_METHOD_LABELS[m] : "未回答"
}

/** 通勤手段が未回答か */
export function isCommuteMethodUnanswered(profile: LineProfile): boolean {
  return !profile.commute_method
}

/** 氏名変更の申請（担当が /mkadmin で変更する） */
export interface NameChangeRequest {
  requested_at: string
  /** 担当が対応済みにした日時（未対応は undefined） */
  resolved_at?: string
}

/**
 * 既受講の登録（アプリ導入前に受講した分）。
 *
 * ATC方式は「これまでの受講料申請の回数」で支給率を決める。アプリ導入前の受講や
 * 旧LINEからの申請は講座の情報を持たないため自動では数えられず、
 * 登録しないと既受講者が「初受講＝全額支給」と判定されて過大支給になる。
 * そこで担当がスタッフ×講座ごとに回数を登録する。
 *
 * count は「アプリ導入前に受講した回数」。初受講だけ済んでいるなら 1。
 * エントリが無い（未登録）と 0回（本当に初受講）は区別する。
 */
export interface PriorCourse {
  course_id: string
  count: number
  updated_at: string
  updated_by?: string
}

/**
 * 既受講の登録が1件以上あるか（いずれかの講座で受講回数1回以上）。
 *
 * 担当が登録した受講回数をそのまま使い、LINEに「初回ATC＋アカデミー会員費」を
 * 出すかどうかを判定する。別に手動スイッチを持たず記録1つで決めることで、
 * 2か所の食い違いによる確認もれ・過大支給を防ぐ。
 */
/** 担当か（スタッフからの問い合わせの転送先） */
export function isReceptionist(raw: unknown): boolean {
  return parseLineProfile(raw).is_receptionist === true
}

/** 一時休止中か（産休・育休・休職など。退職とは別） */
export function isSuspended(raw: unknown): boolean {
  return !!parseLineProfile(raw).suspended?.at
}

/** 休止の理由（未設定なら空文字） */
export function suspendReason(raw: unknown): string {
  return parseLineProfile(raw).suspended?.reason?.trim() ?? ""
}

/** アカデミー会員のサービス開始日（未登録なら null） */
export function academyStartDate(raw: unknown): string | null {
  const v = parseLineProfile(raw).academy?.start_date
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null
}

export function hasPriorCourseRecord(raw: unknown): boolean {
  return (parseLineProfile(raw).prior_courses ?? []).some((p) => (p?.count ?? 0) >= 1)
}

/**
 * その講座の枠を最後に数え直した日時。
 *
 * 同じ講座で複数回押された場合は**いちばん新しい1件**を使う。
 *
 * @returns ISO8601 の日時。数え直していなければ null
 */
/**
 * いま動いているテスト実行のID（無ければ null）。
 *
 * 終了済み（ended_at あり）は動いていないものとして扱う。
 */
export function activeTestRunId(raw: unknown): string | null {
  return activeTestRun(raw)?.id ?? null
}

/** いま動いているテスト実行（無ければ null）。画面に開始日時を出すために使う */
export function activeTestRun(raw: unknown): TestRun | null {
  const run = parseLineProfile(raw).test_run
  if (!run || !run.id || run.ended_at) return null
  return run
}

export function travelCapResetAt(raw: unknown, courseId: string | null | undefined): string | null {
  if (!courseId) return null
  const hits = (parseLineProfile(raw).travel_cap_resets ?? [])
    .filter((r) => r?.course_id === courseId && typeof r?.at === "string" && r.at)
    .map((r) => r.at)
    .sort()
  return hits.length > 0 ? hits[hits.length - 1] : null
}

/**
 * アチーブメントアカデミー会員の情報。
 *
 * 再受講は「3年で6回」で、起算は会費を支払って会員になった日。
 * 本人がLINEの「設定」から登録する（担当も管理画面から直せる）。
 */
export interface AcademyMembership {
  /** サービス開始日（YYYY-MM-DD）。例: 2025-12-01 → 2028-11-30 まで */
  start_date: string
  updated_at: string
  /** self=本人がLINEで登録／管理画面からはメールアドレス */
  updated_by?: string
}

/**
 * 一時休止（産休・育休・休職など）。
 *
 * 退職と違い、在籍したまま申請だけを止める。再開すれば元どおり使える。
 * 過去の申請・LINEの紐づけ・設定はすべて残る。
 */
export interface SuspendedState {
  at: string
  /** 休止の理由（例「産休」）。画面に出すだけで判定には使わない */
  reason?: string
  by?: string
}

/**
 * 交通費・宿泊費の枠（講座ごと30,000円）を数え直した記録。
 *
 * 枠は「講座ごと」だが、講座マスタは同じ講座名を再受講でも使い回すため、
 * 数え直さないと1回目の受講で枠を使い切り、2回目以降が全額超過になる。
 * 担当が「次の受講分として数え直す」を押したら、この日時より後の申請だけを数える。
 */
export interface TravelCapReset {
  course_id: string
  /** この日時より後の申請だけを枠に数える（ISO8601） */
  at: string
  /** 操作した人（メールアドレス）。記録用 */
  by?: string
  /** 数え直す直前までに使っていた額（記録用。判定には使わない） */
  used_before?: number
}

/**
 * テスト実行（実機テストの1回分）。
 *
 * 実機テストをやり直すとき、過去の記録を消さずにやり直せるようにするための印。
 * 開始するとIDを発行し、その間に作られた申請に test_run_id を付ける。
 *
 * - 重複判定と上限の累計は、**同じテスト実行の中だけ**で行う
 *   → 以前と同じ画像をそのまま使える。累計も0から数え直せる
 * - 本番の記録はテスト実行の判定に入らない。逆も同じ
 * - 会計士提出・給与集計からの除外は、従来どおり is_test で行う
 */
export interface TestRun {
  /** テスト実行のID（発行時刻ベース。申請の印に使う） */
  id: string
  /** 開始日時（ISO8601） */
  started_at: string
  /** 開始した人（メールアドレス）。記録用 */
  by?: string
  /** 終了日時。終了していなければ未設定 */
  ended_at?: string
}

/**
 * スタッフからの問い合わせ1件。
 *
 * これまでは担当のLINEへ送るだけで、アプリには何も残らなかった。
 * 担当が見落とすとどこにも残らず消えてしまうため、記録して
 * 「未対応／対応済み」を追えるようにする。
 */
export interface StaffInquiry {
  /** 受け付けた日時（ISO8601）。一覧の並び順と識別に使う */
  at: string
  /** 本文 */
  text: string
  /** 対応済みにした日時。未対応なら未設定 */
  done_at?: string
  /** 対応済みにした人（メールアドレス） */
  done_by?: string
}

export interface LineProfile {
  /** スタッフから届いた問い合わせ（新しいものを後ろに。古いものから切り捨てる） */
  inquiries?: StaffInquiry[]
  /** 担当からスタッフへ送った連絡の履歴（二重連絡を避けるために残す） */
  admin_messages?: { at: string; by?: string; text?: string }[]
  /**
   * いま動いているテスト実行。
   * 「新しいテストを開始」で入れ替える（過去のIDは申請側に残る）。
   */
  test_run?: TestRun
  /**
   * 担当か（スタッフからの問い合わせをこの人のLINEへ転送する）。
   * 院長は ADMIN_LINE_USER_ID で常に受け取るため、ここは担当者用。
   */
  is_receptionist?: boolean
  /** 交通費・宿泊費の枠を数え直した記録（講座ごと・最後の1件だけを使う） */
  travel_cap_resets?: TravelCapReset[]
  /** 一時休止。キーが無い＝利用中 */
  suspended?: SuspendedState
  /** アカデミー会員のサービス開始日。キーが無い＝未登録 */
  academy?: AcademyMembership
  /** 既受講の登録（講座ごと）。キーが無い＝1件も登録していない */
  prior_courses?: PriorCourse[]
  /** 通勤手段。キーが無い＝未回答 */
  commute_method?: CommuteMethod
  /** 通勤手段を登録・更新した日時 */
  commute_method_updated_at?: string
  /** キーが無い＝未回答 */
  commuter_pass?: CommuterPass
  name_confirmed_at?: string
  setup_completed_at?: string
  last_applied_at?: string
  name_change_requests?: NameChangeRequest[]
}

/** jsonb の値を LineProfile として安全に読む */
export function parseLineProfile(raw: unknown): LineProfile {
  if (!raw) return {}
  let obj: unknown = raw
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return {}
  return obj as LineProfile
}

/** 列未適用のエラーか（PostgREST のスキーマキャッシュ未反映を含む） */
function isMissingColumnError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return error.code === "PGRST204" || error.code === "42703" || /line_profile/.test(error.message || "")
}

/** LINE申請で使うスタッフ情報 */
export interface StaffLineState {
  id: string
  name: string
  homeStation: string | null
  homeStationPref: string | null
  isTest: boolean
  profile: LineProfile
  /** line_profile 列が使えるか（false なら定期券・初回設定は扱わない） */
  available: boolean
}

/** スタッフ1名の LINE 申請用の状態を読む（取得できなければ null） */
export async function loadStaffLineState(supabase: Client, staffId: string): Promise<StaffLineState | null> {
  const full = await supabase
    .from("staff_members")
    .select("id, name, home_station, home_station_pref, is_test, line_profile")
    .eq("id", staffId)
    .maybeSingle()
  if (!full.error && full.data) {
    const r = full.data as {
      id: string
      name: string
      home_station: string | null
      home_station_pref: string | null
      is_test: boolean | null
      line_profile: unknown
    }
    return {
      id: r.id,
      name: r.name,
      homeStation: r.home_station,
      homeStationPref: r.home_station_pref,
      isTest: !!r.is_test,
      profile: parseLineProfile(r.line_profile),
      available: true,
    }
  }
  if (full.error && !isMissingColumnError(full.error)) {
    console.error("[line-profile] スタッフ取得エラー:", full.error.message)
    return null
  }
  // 列未適用 → 従来の列だけで読む
  const basic = await supabase
    .from("staff_members")
    .select("id, name, home_station, home_station_pref, is_test")
    .eq("id", staffId)
    .maybeSingle()
  if (basic.error || !basic.data) return null
  const b = basic.data as {
    id: string
    name: string
    home_station: string | null
    home_station_pref: string | null
    is_test: boolean | null
  }
  console.warn("[line-profile] line_profile 列が未適用のため定期券・初回設定をスキップ（migration 041未実行?）")
  return {
    id: b.id,
    name: b.name,
    homeStation: b.home_station,
    homeStationPref: b.home_station_pref,
    isTest: !!b.is_test,
    profile: {},
    available: false,
  }
}

/**
 * line_profile を部分更新する（読み込み → マージ → 書き込み）。成功なら true。
 * patch の値に undefined を渡したキーは削除する。
 */
export async function updateLineProfile(
  supabase: Client,
  staffId: string,
  patch: Partial<LineProfile>
): Promise<boolean> {
  const { data, error } = await supabase
    .from("staff_members")
    .select("line_profile")
    .eq("id", staffId)
    .maybeSingle()
  if (error) {
    console.warn("[line-profile] 読み込み失敗（migration 041未実行?）:", error.message)
    return false
  }
  const current = parseLineProfile((data as { line_profile?: unknown } | null)?.line_profile)
  const next: Record<string, unknown> = { ...current }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k]
    else next[k] = v
  }
  const { error: updateError } = await supabase
    .from("staff_members")
    .update({ line_profile: next as unknown as Json })
    .eq("id", staffId)
  if (updateError) {
    console.warn("[line-profile] 更新失敗:", updateError.message)
    return false
  }
  return true
}

/* ---------- 設定の完了判定 ---------- */

/** 定期券が未回答か */
export function isCommuterPassUnanswered(profile: LineProfile): boolean {
  return !profile.commuter_pass
}

/** 有効な定期券区間（「あり」で両端が揃っている場合のみ） */
export function activeCommuterPass(profile: LineProfile): Required<Pick<CommuterPass, "from" | "to">> & CommuterPass | null {
  const p = profile.commuter_pass
  if (!p?.has || !p.from || !p.to) return null
  return p as Required<Pick<CommuterPass, "from" | "to">> & CommuterPass
}

/** 初回設定（氏名確認・最寄り駅・定期券）が終わっているか */
export function isSetupComplete(state: StaffLineState): boolean {
  if (!state.available) return true // 列が無い環境では差し込まない（従来動作）
  return !!state.profile.setup_completed_at
}

/** 定期券の表示（例「あり（南草津 ⇄ 京都）」「なし」「未回答」） */
export function commuterPassLabel(profile: LineProfile): string {
  const p = profile.commuter_pass
  if (!p) return "未回答"
  if (!p.has) return "なし"
  if (!p.from || !p.to) return "あり（区間未登録）"
  return `あり（${stripStationSuffix(p.from)} ⇄ ${stripStationSuffix(p.to)}）`
}

/** 「○○駅」→「○○」（区間表示用） */
export function stripStationSuffix(station: string): string {
  return station.replace(/駅$/, "")
}

/** 未対応の氏名変更申請があるか */
export function hasPendingNameChange(profile: LineProfile): boolean {
  return (profile.name_change_requests ?? []).some((r) => !r.resolved_at)
}

/** 前回の申請から3か月以上空いているか（初回は false） */
export function isLongAbsence(profile: LineProfile, now = new Date()): boolean {
  if (!profile.last_applied_at) return false
  const last = Date.parse(profile.last_applied_at)
  if (!Number.isFinite(last)) return false
  const threeMonthsAgo = new Date(now)
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3)
  return last <= threeMonthsAgo.getTime()
}

/* ---------- 氏名照合（同姓対策） ---------- */

/** 氏名比較用の正規化（半角/全角スペース・中黒を除去し、半角カナ等をNFKCで統一） */
export function normalizePersonName(name: string): string {
  return name.normalize("NFKC").replace(/[\s　・･]/g, "").trim()
}

/**
 * スタッフ1名の照合対象となる氏名すべて。
 *
 * 結婚などで戸籍（行政上）の氏名が変わっても、職場では旧姓のまま働くことがある。
 * 給与・社会保険・源泉徴収は戸籍の氏名で処理するため両方を登録し、
 * **どちらの氏名で申請してもご本人と判定できる**ようにする。
 *
 * - name       … 仕事上の氏名（LINE・書類登録スタッフ・画面表示に使う）
 * - legal_name … 給与・行政上の氏名（未入力なら name と同じとみなす）
 */
export function staffNameVariants(member: { name: string; legal_name?: string | null }): string[] {
  const list = [member.name, member.legal_name ?? ""]
    .map((v) => normalizePersonName(v || ""))
    .filter((v) => v.length > 0)
  return Array.from(new Set(list))
}

/** 給与・行政上の氏名（未登録なら仕事上の氏名） */
export function payrollName(member: { name: string; legal_name?: string | null }): string {
  const legal = (member.legal_name ?? "").trim()
  return legal || member.name
}

/** 仕事上の氏名と行政上の氏名が違うか（画面に併記するかの判定） */
export function hasSeparateLegalName(member: { name: string; legal_name?: string | null }): boolean {
  const legal = (member.legal_name ?? "").trim()
  return legal.length > 0 && normalizePersonName(legal) !== normalizePersonName(member.name)
}

/** 呼びかけ用の姓（「南 ひふ子」→「南」。空白が無ければ全体） */
export function familyName(name: string): string {
  const parts = name.trim().split(/[\s　]+/)
  return parts[0] || name
}

/**
 * 入力された氏名に一致するスタッフ候補を返す（同姓・同名を含めて全件）。
 *
 * - 姓名間の空白の有無は吸収する（「南ひふ子」「南 ひふ子」は同じ）。
 * - 完全一致があればそれだけを返す（フルネーム入力で一意に決まる）。
 * - 完全一致が無ければ、登録名が入力で始まる（姓だけの入力）／入力が登録名で始まる（登録が姓のみ）を候補にする。
 * - 1文字の入力は、登録名の姓と一致する場合（例「南」）のみ候補にする。
 * 戻り値が2件以上なら呼び出し側で本人に選ばせる（先頭1件に紐づけない）。
 */
export function matchStaffCandidates<T extends { id: string; name: string }>(staff: T[], input: string): T[] {
  const q = normalizePersonName(input.replace(/(さん|様)$/, ""))
  if (!q) return []
  const exact = staff.filter((s) => normalizePersonName(s.name) === q)
  if (exact.length > 0) return exact
  return staff.filter((s) => {
    const n = normalizePersonName(s.name)
    if (!n) return false
    // 姓だけの入力（1文字の姓「南」も可）：登録名の姓と一致
    if (normalizePersonName(familyName(s.name)) === q) return true
    // 2文字以上の前方一致（「南ひ」など）／登録が姓のみでフルネームが送られた場合
    return (q.length >= 2 && n.startsWith(q)) || (n.length >= 2 && q.startsWith(n))
  })
}

/**
 * 氏名の照合（フルネームの完全一致のみ）。
 *
 * 候補を複数提示すると、申請者に**他のスタッフの氏名が見えてしまう**。
 * 個人情報の観点からそれは避けたいので、部分一致や姓だけの一致は受け付けず、
 * フルネームが完全に一致した場合だけ本人と判定する。
 *
 * 比較は normalizePersonName で正規化するため、
 * **姓と名の間のスペースの有無や全角・半角の違いは問わない**
 * （「南ひふ子」「南 ひふ子」「南　ひふ子」はすべて同じ扱い）。
 *
 * 仕事上の氏名と行政上の氏名（旧姓のまま勤務している場合）の
 * **どちらを送っても一致**する（staffNameVariants を参照）。
 *
 * 同姓同名が2名いる場合はここでは区別できないので、呼び出し側で担当への確認を案内する。
 * /mkadmin 側には同姓同名の警告を出しており、担当が区別できる氏名に直せる。
 */
export function matchStaffByFullName<T extends { id: string; name: string; legal_name?: string | null }>(
  staff: T[],
  input: string
): T[] {
  const q = normalizePersonName(input.replace(/(さん|様)$/, ""))
  if (!q) return []
  return staff.filter((s) => staffNameVariants(s).includes(q))
}

/** 同姓・同名のスタッフがいるかの判定（/mkadmin の警告用） */
export function findNameConflicts<T extends { id: string; name: string }>(
  staff: T[]
): Map<string, "same_name" | "same_family"> {
  const result = new Map<string, "same_name" | "same_family">()
  for (const a of staff) {
    for (const b of staff) {
      if (a.id === b.id) continue
      if (normalizePersonName(a.name) === normalizePersonName(b.name)) {
        result.set(a.id, "same_name")
      } else if (familyName(a.name) === familyName(b.name) && result.get(a.id) !== "same_name") {
        result.set(a.id, "same_family")
      }
    }
  }
  return result
}
