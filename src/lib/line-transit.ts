import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database, Json } from "@/types/database"
import { settleStaffReceipt } from "@/lib/staff-refund-core"
import { findContentDuplicate, type ExistingDuplicate } from "@/lib/staff-receipt-dedup"

/**
 * LINE「領収書なし交通費」申請の対話セッションと確定処理（共通ロジック）。
 *
 * - セッションは line_transit_sessions（migration034）に1ユーザー1行で永続化する
 *   （Vercel関数インスタンスの再利用に依存せず、複数テキスト入力をまたいで状態を保持）。
 * - 確定は staff_receipts（領収書画像なし・image_hash なし）を作成し、既存の settleStaffReceipt で
 *   petty_cash_transactions に登録する（区分＝交通費＝全額・給与支給）。会計・CSVの既存ロジックに乗せる。
 */

type Client = SupabaseClient<Database>

/* ---------- 対話ステップ ---------- */

export type TransitStep =
  | "mode" // 交通手段の選択待ち（電車/その他）
  | "train_arrival_station" // 到着駅名の入力待ち（テキスト）
  | "train_arrival_pref" // 到着駅の県の選択待ち（QuickReply or テキスト）
  | "train_trip" // 片道/往復の選択待ち
  | "train_date" // 利用日の入力待ち（今日 or 日付）
  | "train_confirm" // 推定額の確認待ち（OK or 金額入力で上書き）
  | "other_amount" // 金額の手動入力待ち
  | "other_purpose" // 用途・支払先の入力待ち（任意）
  | "other_date" // 利用日の入力待ち
  | "other_confirm" // 確認待ち（OK）
  // 自宅最寄り駅 自己登録フロー（同じセッションテーブルを流用）
  | "home_input" // 駅名の入力待ち
  | "home_confirm" // 一意判定の確認待ち（OK/修正）
  | "home_pick" // 候補からの選択待ち

/** セッションに溜める入力途中データ */
export interface TransitData {
  mode?: "train" | "other"
  // 電車
  fromStation?: string
  fromPref?: string
  toStation?: string
  toPref?: string
  trip?: "one" | "round"
  oneWayFare?: number | null
  estimatedTotal?: number | null
  estimateMethod?: "ai" | "manual"
  // その他
  otherPurpose?: string
  // 共通
  useDate?: string // 利用日 YYYY-MM-DD
  amount?: number // 確定額（確認後）
  // 自宅最寄り駅 自己登録フロー用
  homeStationPick?: { station: string; pref: string; line?: string | null } // 一意判定の確認対象
  homeStationCandidates?: { station: string; pref: string; line?: string | null }[] // 候補選択肢
  /** 「電車代」トリガーで開始したが最寄り駅が未登録だった場合、登録完了後に電車代申請へ自動復帰させる印 */
  pendingTrain?: boolean
}

export interface TransitSession {
  staffMemberId: string | null
  step: TransitStep
  data: TransitData
}

/* ---------- 都道府県（到着駅の県・QuickReply用） ---------- */

/**
 * 到着駅の県の選択肢（南草津＝滋賀を起点に近畿＋セミナー開催の多い主要都市を優先）。
 * 一覧に無い県はテキストで県名を入力してもらう（train_arrival_pref はテキストも受け付ける）。
 * LINE QuickReply は最大13個まで。
 */
export const NEARBY_PREFECTURES = [
  "滋賀県",
  "京都府",
  "大阪府",
  "兵庫県",
  "奈良県",
  "三重県",
  "福井県",
  "岐阜県",
  "愛知県",
  "東京都",
  "神奈川県",
] as const

/* ---------- セッションCRUD ---------- */

/**
 * セッションを取得する。存在しない・テーブル未適用（migration034未実行）・エラー時は null。
 */
export async function getTransitSession(
  supabase: Client,
  lineUserId: string
): Promise<TransitSession | null> {
  const { data, error } = await supabase
    .from("line_transit_sessions")
    .select("staff_member_id, step, data")
    .eq("line_user_id", lineUserId)
    .maybeSingle()
  if (error) {
    console.warn("[line-transit] セッション取得スキップ（migration034未実行?）:", error.message)
    return null
  }
  if (!data) return null
  const row = data as { staff_member_id: string | null; step: string; data: unknown }
  return {
    staffMemberId: row.staff_member_id,
    step: row.step as TransitStep,
    data: (row.data && typeof row.data === "object" ? row.data : {}) as TransitData,
  }
}

/**
 * セッションを作成/更新（upsert）する。成功なら true。
 * テーブル未適用・エラー時は false（呼び出し側はフォールバック案内を出す）。
 */
export async function setTransitSession(
  supabase: Client,
  lineUserId: string,
  staffMemberId: string | null,
  step: TransitStep,
  data: TransitData
): Promise<boolean> {
  const { error } = await supabase.from("line_transit_sessions").upsert(
    {
      line_user_id: lineUserId,
      staff_member_id: staffMemberId,
      step,
      data: data as unknown as Json,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "line_user_id" }
  )
  if (error) {
    console.warn("[line-transit] セッション保存失敗（migration034未実行?）:", error.message)
    return false
  }
  return true
}

/**
 * 自宅最寄り駅を更新する（LINE自己登録）。/mkadmin の管理者登録と同じカラムを更新するため双方に反映される。
 * 駅名は「○○駅」表記で渡すこと（電車運賃推定 transit-fare.ts と整合）。
 */
export async function updateStaffHomeStation(
  supabase: Client,
  staffId: string,
  station: string,
  pref: string | null
): Promise<boolean> {
  const { error } = await supabase
    .from("staff_members")
    .update({ home_station: station, home_station_pref: pref })
    .eq("id", staffId)
  if (error) {
    console.error("[line-transit] 自宅最寄り駅の更新エラー:", error.message)
    return false
  }
  return true
}

/** セッションを削除する（確定・キャンセル時）。 */
export async function clearTransitSession(supabase: Client, lineUserId: string): Promise<void> {
  const { error } = await supabase
    .from("line_transit_sessions")
    .delete()
    .eq("line_user_id", lineUserId)
  if (error) console.warn("[line-transit] セッション削除失敗:", error.message)
}

/* ---------- 確定処理 ---------- */

export interface FinalizeParams {
  staffId: string
  staffName: string
  amount: number
  /** 利用日（YYYY-MM-DD）＝支払年月日相当 */
  useDate: string
  /** 支払先文言（例「電車：A駅→B駅（往復・AI推定）」「その他：○○バス（手動）」） */
  storeName: string
  /** 透明性のためのメタ情報（ai_raw に保存。issue_date は useDate を入れる） */
  meta: Record<string, unknown>
}

export type FinalizeStatus = "ok" | "duplicate" | "no_amount" | "error"

export interface FinalizeResult {
  status: FinalizeStatus
  duplicate?: ExistingDuplicate
}

/**
 * 領収書なし交通費を確定する。
 * 1. 内容（支払先＋金額＋利用日）の重複検知（画像ハッシュ無しでも従来通り機能）。
 * 2. staff_receipts を作成（領収書画像なし＝dropbox_path空・image_hashなし）。
 *    ai_raw.issue_date に利用日を入れ、会計士向けCSVの「支払年月日」が利用日になるようにする。
 * 3. settleStaffReceipt で petty_cash_transactions に登録（区分＝交通費＝全額・給与支給）。
 */
export async function finalizeTransitClaim(
  supabase: Client,
  params: FinalizeParams
): Promise<FinalizeResult> {
  const { staffId, staffName, amount, useDate, storeName, meta } = params
  if (!amount || amount <= 0) return { status: "no_amount" }

  // 1. 内容重複（同一スタッフ・支払先＋金額＋利用日）。画像が無くても従来の判定を機能させる
  const dup = await findContentDuplicate(supabase, {
    staffMemberId: staffId,
    storeName,
    amount,
    date: useDate,
  })
  if (dup) return { status: "duplicate", duplicate: dup }

  // 2. staff_receipts 作成（領収書画像なし）。image_hash は省略（＝null）でハッシュ重複判定はスキップ
  const ts = Date.now().toString().slice(-6)
  const aiRaw = { ...meta, issue_date: useDate } as unknown as Json
  const { data: inserted, error: insertError } = await supabase
    .from("staff_receipts")
    .insert({
      staff_member_id: staffId,
      file_name: `${staffName}_交通費(領収書なし)_${ts}`,
      dropbox_path: "", // 領収書画像なし（NOT NULL制約回避のため空文字）
      document_type: "交通費",
      date: useDate, // 利用日＝支払日相当
      amount,
      store_name: storeName,
      tax_category: null,
      account_title: null,
      ai_raw: aiRaw,
    })
    .select("id")
    .single()

  if (insertError || !inserted) {
    console.error("[line-transit] staff_receipts 作成エラー:", insertError)
    return { status: "error" }
  }

  // 3. 給与支給で精算確定（区分＝交通費＝全額。subsidy_category=other）
  try {
    const result = await settleStaffReceipt({
      staffReceiptId: (inserted as { id: string }).id,
      settlementMethod: "payroll",
      subsidyCategory: "other", // 交通費は全額
      expenseDetail: "交通費",
      client: supabase,
    })
    if (result.status === "ok") return { status: "ok" }
    if (result.status === "no_amount") return { status: "no_amount" }
    console.error("[line-transit] 精算確定が想定外:", result.status)
    return { status: "error" }
  } catch (e) {
    console.error("[line-transit] 精算確定エラー:", e)
    return { status: "error" }
  }
}
