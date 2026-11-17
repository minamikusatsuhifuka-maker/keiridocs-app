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

export interface LineProfile {
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

/** 氏名比較用の正規化（半角/全角スペース・中黒を除去） */
export function normalizePersonName(name: string): string {
  return name.replace(/[\s　・･]/g, "").trim()
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
