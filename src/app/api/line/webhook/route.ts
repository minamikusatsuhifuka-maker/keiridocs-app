import { NextRequest, NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { uploadFile } from "@/lib/dropbox"
import {
  analyzeDocument,
  DEFAULT_GEMINI_MODEL,
  normalizeAmount,
  STAFF_RECEIPT_ANALYSIS_EXTRA_HINT,
  type OcrResult,
} from "@/lib/gemini"
import { settleStaffReceipt } from "@/lib/staff-refund-core"
import {
  deriveReceiptCandidates,
  fetchSplitSiblings,
  type ReceiptCandidate,
  type SiblingReceipt,
} from "@/lib/staff-receipt-split"
import { estimateTrainFare } from "@/lib/transit-fare"
import {
  getTransitSession,
  setTransitSession,
  clearTransitSession,
  finalizeTransitClaim,
  updateStaffHomeStation,
  NEARBY_PREFECTURES,
  type TransitData,
  type TransitSession,
} from "@/lib/line-transit"
import { judgeStation, toStationName } from "@/lib/station-judge"
import {
  EXPENSE_GROUP_LABELS,
  expenseDetailsByGroup,
  getExpenseDetail,
  calcSubsidy,
  type ExpenseGroup,
} from "@/lib/subsidy"
import {
  findImageHashDuplicate,
  findContentDuplicate,
  type ExistingDuplicate,
} from "@/lib/staff-receipt-dedup"
import type { Database } from "@/types/database"
import type { Json } from "@/types/database"
import crypto from "crypto"

/** Vercel関数のタイムアウトを60秒に延長（Gemini + Dropbox処理に十分な時間を確保） */
export const maxDuration = 60

/* ---------- 型定義 ---------- */

interface LineEvent {
  type: string
  replyToken: string
  source: {
    type: string
    userId: string
  }
  message?: {
    type: string
    id: string
    text?: string
    contentProvider?: {
      type: string
    }
  }
  /** ボタンテンプレートのpostbackアクションで送られるデータ */
  postback?: {
    data: string
  }
}

/* ---------- スタッフ名メモリ ---------- */

interface StaffNameEntry {
  staffId: string
  staffName: string
  expiresAt: number
}

/** userIdをキーにスタッフ名を一時保持（30分で期限切れ） */
const staffNameCache = new Map<string, StaffNameEntry>()
const CACHE_TTL_MS = 30 * 60 * 1000

interface LineWebhookBody {
  destination: string
  events: LineEvent[]
}

/* ---------- ヘルパー ---------- */

/** サービスロールキーでRLSをバイパスするSupabaseクライアント */
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createSupabaseClient<Database>(url, serviceKey)
}

/** LINE署名検証 */
function verifySignature(body: string, signature: string): boolean {
  const channelSecret = process.env.LINE_CHANNEL_SECRET
  if (!channelSecret) return false

  const hash = crypto
    .createHmac("SHA256", channelSecret)
    .update(body)
    .digest("base64")

  return hash === signature
}

/** LINEからユーザープロフィールを取得 */
async function getLineUserProfile(userId: string): Promise<{ displayName: string } | null> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) return null

  const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) return null
  return res.json()
}

/** LINEから画像バイナリを取得 */
async function getLineMessageContent(messageId: string): Promise<Buffer | null> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) return null

  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${token}` } }
  )

  if (!res.ok) return null
  const arrayBuffer = await res.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

/** LINE Push メッセージ送信（replyToken不要、userIdに直接送信） */
async function pushMessage(userId: string, text: string): Promise<boolean> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) return false

  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: userId,
        messages: [{ type: "text", text }],
      }),
    })

    if (!res.ok) {
      const errorBody = await res.text()
      console.error("LINE Push送信失敗:", res.status, errorBody)
      return false
    }
    return true
  } catch (error) {
    console.error("LINE Push送信エラー:", error)
    return false
  }
}

/** LINE返信メッセージ送信（失敗時はfalseを返す） */
async function replyMessage(replyToken: string, text: string): Promise<boolean> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) return false

  try {
    const res = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text }],
      }),
    })

    if (!res.ok) {
      const errorBody = await res.text()
      console.error("LINE Reply送信失敗:", res.status, errorBody)
      return false
    }
    return true
  } catch (error) {
    console.error("LINE Reply送信エラー:", error)
    return false
  }
}

/**
 * LINEにメッセージを送信する（reply → push フォールバック付き）
 * replyTokenの有効期限切れ時にpushMessageで再送する
 */
async function sendLineMessage(
  replyToken: string,
  userId: string,
  text: string
): Promise<void> {
  const replied = await replyMessage(replyToken, text)
  if (!replied) {
    console.log("Reply失敗のためPushで再送:", userId)
    await pushMessage(userId, text)
  }
}

/** LINEのpostbackボタンアクション */
interface PostbackAction {
  type: "postback"
  label: string
  data: string
  displayText?: string
}

/** 任意のmessageオブジェクト配列をreplyで送信（失敗時はfalse） */
async function replyRaw(replyToken: string, messages: unknown[]): Promise<boolean> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) return false
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ replyToken, messages }),
    })
    if (!res.ok) {
      console.error("LINE Reply(raw)送信失敗:", res.status, await res.text())
      return false
    }
    return true
  } catch (error) {
    console.error("LINE Reply(raw)送信エラー:", error)
    return false
  }
}

/** 任意のmessageオブジェクト配列をpushで送信（失敗時はfalse） */
async function pushRaw(userId: string, messages: unknown[]): Promise<boolean> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) return false
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to: userId, messages }),
    })
    if (!res.ok) {
      console.error("LINE Push(raw)送信失敗:", res.status, await res.text())
      return false
    }
    return true
  } catch (error) {
    console.error("LINE Push(raw)送信エラー:", error)
    return false
  }
}

/**
 * クイックリプライ付きテキストメッセージを送信する（reply→pushフォールバック付き）。
 * 選択肢が5個以上（ボタンテンプレートの上限4を超える）場合や、本文が長い確認画面で使う。
 * - 本文は最大5000文字、選択肢は最大13個、ラベルは20文字以内（LINE仕様）
 */
async function sendLineQuickReply(
  replyToken: string,
  userId: string,
  text: string,
  items: PostbackAction[]
): Promise<void> {
  const message = {
    type: "text",
    text: text.slice(0, 4900),
    quickReply: {
      items: items.slice(0, 13).map((a) => ({
        type: "action",
        action: {
          type: "postback",
          label: a.label.slice(0, 20),
          data: a.data,
          displayText: a.displayText,
        },
      })),
    },
  }
  const replied = await replyRaw(replyToken, [message])
  if (!replied) {
    console.log("Reply(quickReply)失敗のためPushで再送:", userId)
    await pushRaw(userId, [message])
  }
}

/** Date を日本時間（JST）の YYYY-MM-DD 文字列に変換する（Vercelのサーバ時刻はUTCのため明示変換） */
function toJstDateString(date: Date): string {
  // en-CA ロケールは YYYY-MM-DD 形式を返す
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date)
}

/**
 * スタッフ領収書用のDropboxパスを生成する（申請日フォルダ）
 * 本番: /経理書類/スタッフ領収書/{スタッフ名}/{申請日YYYY-MM-DD}/{ファイル名}
 * テスト: /経理書類/テスト/{スタッフ名}/{申請日YYYY-MM-DD}/{ファイル名}（is_test=true）
 * @param applicationDate 申請日（アップロード日）の YYYY-MM-DD 文字列（JST）
 * @param isTest テストスタッフ（保存先を本番と分離する）
 */
function getStaffReceiptPath(
  staffName: string,
  applicationDate: string,
  originalFileName: string,
  isTest = false
): string {
  const safeName = staffName.replace(/[/\\:*?"<>|]/g, "_")
  const base = isTest ? "/経理書類/テスト" : "/経理書類/スタッフ領収書"
  return `${base}/${safeName}/${applicationDate}/${originalFileName}`
}

/** 金額をフォーマット（3桁区切り） */
function formatAmount(amount: number | null): string {
  if (amount === null || amount === undefined) return "不明"
  return amount.toLocaleString("ja-JP")
}

/** 重複領収書の警告メッセージ（二重申請ブロック時にスタッフへ返す） */
function buildDuplicateWarning(dup: ExistingDuplicate): string {
  const appliedDate = toJstDateString(new Date(dup.created_at))
  return (
    "⚠️ この領収書はすでに登録されています。\n" +
    "─────────────\n" +
    `🏪 ${dup.store_name || "不明"}\n` +
    `💰 ¥${formatAmount(dup.amount ?? null)}\n` +
    `📅 申請日：${appliedDate}\n` +
    "─────────────\n" +
    "二重申請の可能性があるため、登録を中止しました。\n" +
    "ご不明な場合は院長にご確認ください。"
  )
}

/* ---------- Webhookハンドラ ---------- */

export async function POST(request: NextRequest) {
  // リクエストボディを文字列で取得（署名検証に使用）
  const rawBody = await request.text()

  // 署名検証
  const signature = request.headers.get("x-line-signature") || ""
  if (!verifySignature(rawBody, signature)) {
    console.error("LINE署名検証失敗")
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  const body = JSON.parse(rawBody) as LineWebhookBody

  // 各イベントを処理（非同期で並行処理しない＝返信トークンの有効期限対策）
  for (const event of body.events) {
    try {
      await handleEvent(event)
    } catch (error) {
      console.error("LINE Webhookイベント処理エラー:", error)
    }
  }

  // LINEプラットフォームには常に200を返す
  return NextResponse.json({ status: "ok" })
}

/** スタッフ一覧からスタッフ名を部分一致検索 */
/** LINEの振り分けで使うスタッフ行（staff_members の必要最小限） */
type StaffRow = { id: string; name: string; line_user_id?: string | null }

/** スタッフ一覧を取得する（取得できなければ null） */
async function fetchStaffMembers(
  supabase: ReturnType<typeof createServiceClient>
): Promise<StaffRow[] | null> {
  const { data, error } = await supabase.from("staff_members").select("id, name, line_user_id")
  if (error || !data) {
    console.error("staff_members取得エラー:", error)
    return null
  }
  return data as StaffRow[]
}

function findStaffByName(
  staffMembers: { id: string; name: string; line_user_id?: string | null }[],
  searchName: string
): { id: string; name: string; line_user_id?: string | null } | undefined {
  return staffMembers.find(
    (s) => searchName.includes(s.name) || s.name.includes(searchName)
  )
}

/** スタッフ名の一覧テキストを生成 */
function getStaffNameList(staffMembers: { id: string; name: string }[]): string {
  return staffMembers.map((s) => s.name).join("・")
}

/** イベント振り分け */
async function handleEvent(event: LineEvent): Promise<void> {
  // デバッグ: LINE user IDをVercelログに出力
  if (event.source?.userId) {
    console.log(`LINE_USER_ID: ${event.source.userId}`)
  }

  // ボタンテンプレートの確定（精算方法の選択）
  if (event.type === "postback") {
    await handlePostback(event)
    return
  }

  if (event.type !== "message") return

  const messageType = event.message?.type
  if (messageType === "image") {
    await handleImageMessage(event)
  } else if (messageType === "text") {
    await handleTextMessage(event)
  }
}

/**
 * postbackデータを振り分ける。新フロー（給与一本化・2階層区分・確認/修正）:
 *  - action=t1&rid=...&g=ach|other      … 第1階層選択 → 第2階層（サブ選択）を返す
 *  - action=t2&rid=...&d=<detailKey>    … 第2階層選択 → 確認画面（OK/修正）を返す
 *  - action=ok&rid=...&d=<detailKey>    … 確定 → 給与支給で精算登録
 *  - action=fix&rid=...                 … 修正 → 第1階層に戻る（写真再送不要）
 */
async function handlePostback(event: LineEvent): Promise<void> {
  const { postback } = event
  if (!postback?.data) return

  const params = new URLSearchParams(postback.data)
  const action = params.get("action")

  switch (action) {
    // 申請メニュー
    case "apm": // 申請項目の選択
      await handleApplicationMenuPostback(event, params)
      return
    case "apx": // メニューを閉じる
      await sendLineMessage(
        event.replyToken,
        event.source.userId,
        "メニューを閉じました。\n「申請」と送るといつでも表示できます。"
      )
      return
    case "t1":
      await handleTier1Postback(event, params)
      return
    case "t2":
      await handleTier2Postback(event, params)
      return
    case "ok":
      await handleConfirmPostback(event, params)
      return
    case "fix":
      await handleFixPostback(event, params)
      return
    // 領収書なし交通費フロー
    case "trm": // 交通手段の選択（電車/その他）
      await handleTransitModePostback(event, params)
      return
    case "trp": // 到着駅の県の選択
      await handleTransitPrefPostback(event, params)
      return
    case "trt": // 片道/往復の選択
      await handleTransitTripPostback(event, params)
      return
    case "trd": // 利用日＝今日
      await handleTransitTodayPostback(event)
      return
    case "trok": // 確認OK → 確定
      await handleTransitConfirmPostback(event)
      return
    case "trx": // キャンセル
      await handleTransitCancelPostback(event)
      return
    // 自宅最寄り駅 自己登録フロー
    case "hsok": // 確認OK → 保存
      await handleHomeStationConfirmPostback(event)
      return
    case "hspick": // 候補選択 → 保存
      await handleHomeStationPickPostback(event, params)
      return
    case "hsfix": // 入力し直す
      await handleHomeStationFixPostback(event)
      return
    case "hsx": // キャンセル
      await handleHomeStationCancelPostback(event)
      return
  }
}

/** 申請メニューで選ばれた項目の開始処理へ振り分ける */
async function handleApplicationMenuPostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const key = params.get("k")
  const item = APPLICATION_MENU.find((m) => m.key === key)
  if (!item) {
    await sendApplicationMenu(replyToken, source.userId)
    return
  }
  const supabase = createServiceClient()
  const staffMembers = await fetchStaffMembers(supabase)
  if (!staffMembers) {
    await sendLineMessage(replyToken, source.userId, "⚠️ システムエラーが発生しました。管理者にご連絡ください。")
    return
  }
  await item.start(event, supabase, staffMembers)
}

/**
 * 第1階層（アチーブメント関連/それ以外）のクイックリプライを送信する。
 * 画像受信直後と「修正」時の両方から呼ばれる。
 */
async function sendTier1(
  replyToken: string,
  userId: string,
  receiptId: string,
  header: string
): Promise<void> {
  await sendLineQuickReply(replyToken, userId, `${header}\nこの立替の区分を選んでください。`, [
    {
      type: "postback",
      label: EXPENSE_GROUP_LABELS.ach,
      data: `action=t1&rid=${receiptId}&g=ach`,
      displayText: EXPENSE_GROUP_LABELS.ach,
    },
    {
      type: "postback",
      label: EXPENSE_GROUP_LABELS.other,
      data: `action=t1&rid=${receiptId}&g=other`,
      displayText: EXPENSE_GROUP_LABELS.other,
    },
  ])
}

/**
 * 領収書IDから、そのスタッフが「セミナー2回目以降」を申請済みかを判定する。
 * staff_members.seminar_repeat_claimed_at が非NULLなら申請済み。
 * 申請済みのスタッフには以降「初回ATC＋アカデミー会員費」を非表示にする。
 * カラム未適用（migration 032未実行）・エラー時は未申請扱い（ボタンを出す）。
 */
async function isSeminarRepeatClaimedByReceipt(
  supabase: ReturnType<typeof createServiceClient>,
  receiptId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("staff_receipts")
    .select("staff_members!inner(seminar_repeat_claimed_at)")
    .eq("id", receiptId)
    .single()
  if (error) {
    console.warn("[LINE Bot] セミナー2回目以降判定スキップ（migration 032未実行?）:", error.message)
    return false
  }
  const claimedAt = (
    data as unknown as { staff_members: { seminar_repeat_claimed_at: string | null } } | null
  )?.staff_members?.seminar_repeat_claimed_at
  return !!claimedAt
}

/**
 * 「セミナー2回目以降」申請完了を記録する（staff_members.seminar_repeat_claimed_at をセット）。
 * 以降そのスタッフには「初回ATC＋アカデミー会員費」を非表示にする。
 * 会計履歴は書き換えない。カラム未適用・失敗時はログのみで精算フローは止めない。
 */
async function markSeminarRepeatClaimed(
  supabase: ReturnType<typeof createServiceClient>,
  receiptId: string
): Promise<void> {
  try {
    const { data } = await supabase
      .from("staff_receipts")
      .select("staff_member_id")
      .eq("id", receiptId)
      .single()
    const staffId = (data as { staff_member_id?: string } | null)?.staff_member_id
    if (!staffId) return
    // 未設定（NULL）の場合のみセット。既に申請済みなら元の申請日時を保持する
    const { error } = await supabase
      .from("staff_members")
      .update({ seminar_repeat_claimed_at: new Date().toISOString() })
      .eq("id", staffId)
      .is("seminar_repeat_claimed_at", null)
    if (error) {
      console.warn("[LINE Bot] seminar_repeat_claimed_at 更新スキップ（migration 032未実行?）:", error.message)
    }
  } catch (e) {
    console.warn("[LINE Bot] seminar_repeat_claimed_at 更新エラー:", e)
  }
}

/** 第1階層選択 → 第2階層（サブ選択）のクイックリプライを返す */
async function handleTier1Postback(
  event: LineEvent,
  params: URLSearchParams
): Promise<void> {
  const { replyToken, source } = event
  const receiptId = params.get("rid")
  const group = params.get("g") as ExpenseGroup | null
  if (!receiptId || (group !== "ach" && group !== "other")) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 処理できませんでした。もう一度お試しください。")
    return
  }

  const supabase = createServiceClient()

  // アチーブメント関連は、「セミナー2回目以降」申請済みなら以降「初回ATC＋アカデミー会員費」を非表示にする
  let details = expenseDetailsByGroup(group)
  let claimed = false
  if (group === "ach") {
    claimed = await isSeminarRepeatClaimedByReceipt(supabase, receiptId)
    if (claimed) {
      details = details.filter((d) => d.key !== "ach_first")
    }
  }

  const items: PostbackAction[] = details.map((d) => ({
    type: "postback",
    label: d.buttonLabel,
    data: `action=t2&rid=${receiptId}&d=${d.key}`,
    displayText: d.buttonLabel,
  }))

  // アチーブメント関連は補足（再受講・他コース）を本文に記載（ボタンラベルは20文字制限のため）
  let text: string
  if (group === "ach") {
    // セミナーに伴う交通費・宿泊費は「セミナー2回目以降」で登録（半額対象）するよう案内（内訳分けはしない）
    const travelNote =
      "\n\n※セミナーに伴う交通費・宿泊費も「セミナー2回目以降」で登録してください（半額対象）。"
    text = claimed
      ? "アチーブメント関連のどれですか？\n\n・セミナー2回目以降（ATC再受講、ATC以外のコース）" + travelNote
      : "アチーブメント関連のどれですか？\n\n・初回ATC＋アカデミー会員費\n・セミナー2回目以降（ATC再受講、ATC以外のコース）" + travelNote
  } else {
    text = "種類を選んでください。"
  }

  await sendLineQuickReply(replyToken, source.userId, text, items)
}

/**
 * 「セミナー2回目以降」配下のサブ選択（弁当代＝全額 / その他＝半額）を送る。
 * 弁当代は subOnly のため第2階層には出さず、このサブ選択でのみ提示する。
 */
async function sendSeminarRepeatSubChoice(
  replyToken: string,
  userId: string,
  receiptId: string
): Promise<void> {
  await sendLineQuickReply(
    replyToken,
    userId,
    "セミナー2回目以降ですね。内訳を選んでください。\n\n" +
      "・弁当代 … 全額支給\n" +
      "・その他（参加費・交通費・宿泊費など）… 半額支給",
    [
      {
        type: "postback",
        label: "弁当代（全額）",
        // 弁当代は別キー（subsidy_category=other＝全額）。サブ選択は不要なので直接確認へ
        data: `action=t2&rid=${receiptId}&d=bento`,
        displayText: "弁当代（全額）",
      },
      {
        type: "postback",
        label: "その他（半額）",
        // セミナー2回目以降そのまま（半額）。sub=1 でサブ選択済みとして確認へ進める
        data: `action=t2&rid=${receiptId}&d=ach_repeat&sub=1`,
        displayText: "その他（半額）",
      },
    ]
  )
}

/** 第2階層選択 → 確認画面（OK/修正）を返す */
async function handleTier2Postback(
  event: LineEvent,
  params: URLSearchParams
): Promise<void> {
  const { replyToken, source } = event
  const receiptId = params.get("rid")
  const detail = getExpenseDetail(params.get("d"))
  if (!receiptId || !detail) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 処理できませんでした。もう一度お試しください。")
    return
  }

  // 「セミナー2回目以降」を選んだ直後は、弁当代（全額）/その他（半額）のサブ選択を挟む
  if (detail.key === "ach_repeat" && params.get("sub") !== "1") {
    await sendSeminarRepeatSubChoice(replyToken, source.userId, receiptId)
    return
  }

  try {
    const supabase = createServiceClient()
    const fetched = await fetchReceiptWithSiblings(supabase, receiptId)
    if (!fetched) {
      await sendLineMessage(replyToken, source.userId, "⚠️ 対象の領収書が見つかりませんでした。")
      return
    }
    const { receipt, siblings } = fetched
    const staffName = receipt.staffName
    const isHalf = detail.subsidyCategory === "achievement_repeat"
    // 申請日 = アップロード日（領収書の登録日）をJSTで表示
    const applicationDate = toJstDateString(new Date(receipt.created_at))

    // 複数領収証（分割兄弟）の場合: 各件の内訳と合計・支給額合計で確認する
    if (siblings.length >= 2) {
      const totalAmount = siblings.reduce((sum, s) => sum + (s.amount ?? 0), 0)
      const totalSubsidy = siblings.reduce(
        (sum, s) => sum + calcSubsidy(s.amount ?? 0, detail.subsidyCategory),
        0
      )
      const lines = siblings
        .map(
          (s, i) =>
            `${circled(i)} ${(s.store_name || "不明").slice(0, 20)} ¥${formatAmount(s.amount)}（${s.date || "日付不明"}）`
        )
        .join("\n")
      const multiText =
        "以下の内容で登録します。確認してください。\n" +
        "─────────────\n" +
        `👤 スタッフ：${staffName}\n` +
        `🧾 ${siblings.length}件の領収書（1ファイル）\n` +
        `${lines}\n` +
        `🏷 区分：${detail.fullLabel}（全${siblings.length}件に適用）\n` +
        `💰 立替額合計：¥${formatAmount(totalAmount)}\n` +
        `💴 支給額合計：¥${formatAmount(totalSubsidy)}（${isHalf ? "半額" : "全額"}・給与支給）\n` +
        `📅 申請日：${applicationDate}\n` +
        "─────────────\n" +
        "この内容でよろしいですか？"
      await sendLineQuickReply(replyToken, source.userId, multiText, [
        {
          type: "postback",
          label: "✅ OK",
          data: `action=ok&rid=${receiptId}&d=${detail.key}`,
          displayText: "✅ OK",
        },
        {
          type: "postback",
          label: "🔄 修正",
          data: `action=fix&rid=${receiptId}`,
          displayText: "🔄 修正",
        },
      ])
      return
    }

    const amount = receipt.amount

    // 金額が読み取れない場合は確認に進めず手動精算を案内（誤精算防止）
    if (!amount || amount <= 0) {
      await sendLineMessage(
        replyToken,
        source.userId,
        "⚠️ 金額が読み取れていないため精算できません。経理側で手動登録してください。"
      )
      return
    }

    const storeName = receipt.store_name || "不明"
    // 支給額（セミナー2回目以降のみ半額・端数切り捨て、他は全額）
    const subsidy = calcSubsidy(amount, detail.subsidyCategory)

    const text =
      "以下の内容で登録します。確認してください。\n" +
      "─────────────\n" +
      `👤 スタッフ：${staffName}\n` +
      `🏪 店名：${storeName}\n` +
      `💰 立替額：¥${formatAmount(amount)}\n` +
      `🏷 区分：${detail.fullLabel}\n` +
      `💴 支給額：¥${formatAmount(subsidy)}（${isHalf ? "半額" : "全額"}・給与支給）\n` +
      `📅 申請日：${applicationDate}\n` +
      "─────────────\n" +
      "この内容でよろしいですか？"

    await sendLineQuickReply(replyToken, source.userId, text, [
      {
        type: "postback",
        label: "✅ OK",
        data: `action=ok&rid=${receiptId}&d=${detail.key}`,
        displayText: "✅ OK",
      },
      {
        type: "postback",
        label: "🔄 修正",
        data: `action=fix&rid=${receiptId}`,
        displayText: "🔄 修正",
      },
    ])
  } catch (error) {
    console.error("[LINE Bot] 確認画面生成エラー:", error)
    await sendLineMessage(replyToken, source.userId, "⚠️ 処理中にエラーが発生しました。経理にご相談ください。")
  }
}

/** 「修正」→ 第1階層からやり直し（写真再送不要） */
async function handleFixPostback(
  event: LineEvent,
  params: URLSearchParams
): Promise<void> {
  const { replyToken, source } = event
  const receiptId = params.get("rid")
  if (!receiptId) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 処理できませんでした。もう一度お試しください。")
    return
  }
  await sendTier1(replyToken, source.userId, receiptId, "もう一度、区分を選んでください。")
}

/** 「OK」→ 給与支給（payroll）固定で精算確定。詳細区分・主区分マッピングを保存 */
async function handleConfirmPostback(
  event: LineEvent,
  params: URLSearchParams
): Promise<void> {
  const { replyToken, source } = event
  const receiptId = params.get("rid")
  const detail = getExpenseDetail(params.get("d"))
  if (!receiptId || !detail) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 処理できませんでした。もう一度お試しください。")
    return
  }

  const supabase = createServiceClient()

  try {
    // 分割兄弟（1ファイル複数領収証）がある場合は全件を同一区分で一括精算する
    const fetched = await fetchReceiptWithSiblings(supabase, receiptId)
    if (fetched && fetched.siblings.length >= 2) {
      await settleMultiReceipts(
        supabase,
        event,
        fetched.siblings,
        detail,
        fetched.receipt.staffName,
        fetched.receipt.isTest
      )
      return
    }

    const result = await settleStaffReceipt({
      staffReceiptId: receiptId,
      settlementMethod: "payroll", // LINEからは常に給与支給に一本化
      subsidyCategory: detail.subsidyCategory, // 支給率（achievement_repeat=半額 / other=全額）
      expenseDetail: detail.fullLabel, // 6種類の詳細区分フル名称
      client: supabase,
    })

    switch (result.status) {
      case "already":
        await sendLineMessage(replyToken, source.userId, "ℹ️ この領収書はすでに登録済みです。")
        return
      case "not_found":
        await sendLineMessage(replyToken, source.userId, "⚠️ 対象の領収書が見つかりませんでした。")
        return
      case "no_amount":
        await sendLineMessage(replyToken, source.userId, "⚠️ 金額が読み取れていないため精算できません。経理にご相談ください。")
        return
      case "ok": {
        const amount = result.amount ?? 0
        const subsidy = calcSubsidy(amount, detail.subsidyCategory)
        const isHalf = detail.subsidyCategory === "achievement_repeat"

        // 「セミナー2回目以降」（その他＝半額／弁当代＝全額のどちらも）が確定したら記録
        // （以降「初回ATC＋アカデミー会員費」をLINEで非表示）
        if (detail.key === "ach_repeat" || detail.key === "bento") {
          await markSeminarRepeatClaimed(supabase, receiptId)
        }

        await sendLineMessage(
          replyToken,
          source.userId,
          "✅ 登録しました。給与支給で処理されます。\nお疲れさまでした！"
        )

        // 院長へpush通知（ADMIN_LINE_USER_ID未設定ならスキップ）。テストスタッフは通知しない
        const { data: testCheck } = await supabase
          .from("staff_receipts")
          .select("staff_members!inner(is_test)")
          .eq("id", receiptId)
          .single()
        const isTest = !!(
          testCheck as unknown as { staff_members?: { is_test?: boolean } } | null
        )?.staff_members?.is_test
        const adminId = process.env.ADMIN_LINE_USER_ID
        if (adminId && !isTest) {
          await pushMessage(
            adminId,
            `🧾 ${result.staffName}さんが ¥${formatAmount(amount)} を立替（${result.storeName || "不明"}）。\n` +
              `区分: ${detail.fullLabel}\n` +
              `支給額: ¥${formatAmount(subsidy)}（${isHalf ? "半額" : "全額"}・給与支給）`
          )
        }
        return
      }
    }
  } catch (error) {
    console.error("[LINE Bot] 精算確定エラー:", error)
    await sendLineMessage(replyToken, source.userId, "⚠️ 精算処理中にエラーが発生しました。経理にご相談ください。")
  }
}

/* ========== 領収書なし交通費フロー（電車＝AI推定＋確認 / その他＝手動） ========== */

/* ---------- リッチメニュー用トリガー文言 ---------- */

/**
 * トリガー判定用の正規化。
 * リッチメニューのボタン文言とスタッフの手入力の表記ゆれを吸収するため、
 * 空白（半角/全角）・各種括弧・区切り記号を除去し、全角英数を半角小文字にする。
 * 例：「交通費（領収書なし）」「交通費(領収書なし)」「 交通費 領収書なし 」→ 交通費領収書なし
 */
function normalizeTrigger(text: string): string {
  return text
    .replace(/[\s　]/g, "")
    .replace(/[（）()［］[\]｛｝{}【】〔〕「」『』<>＜＞]/g, "")
    .replace(/[・,、.．。!！?？:：;；'"”’＇＂/／|｜]/g, "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
}

/* ---------- 申請メニューの項目定義（ここに1件追加すればメニューにもトリガーにも反映される） ---------- */

/**
 * 申請メニューの1項目。
 *
 * 【項目を増やす手順】
 *  1. この下の APPLICATION_MENU に要素を1つ追加する（key は postback データに載るので変更禁止・重複禁止）
 *  2. start に、その申請の開始処理（既存フローの起動関数）を書く
 * → 申請メニューのQuick Reply・テキストのトリガー判定・postbackの振り分けの3つすべてに自動で反映される。
 */
interface ApplicationMenuItem {
  /** postback の識別子（英数字。既存の値は変更しない） */
  key: string
  /** Quick Reply のボタン文言（LINE仕様で20文字以内） */
  label: string
  /** テキストで直接開始できるトリガー文言（正規化後の完全一致で判定） */
  triggers: string[]
  /** 選択・トリガー時の開始処理 */
  start: (
    event: LineEvent,
    supabase: ReturnType<typeof createServiceClient>,
    staffMembers: StaffRow[]
  ) => Promise<void>
}

/** 申請メニューに並べる項目（Quick Reply は最大13個。キャンセルの1枠を除き12件まで） */
const APPLICATION_MENU: ApplicationMenuItem[] = [
  {
    key: "train",
    label: "🚃 電車代（領収書なし）",
    triggers: [
      "電車代",
      "電車",
      "電車の交通費",
      "電車代申請",
      "電車代の申請",
      "電車代を申請",
      "電車申請",
      "電車の交通費申請",
      "電車交通費",
      "電車賃",
      "でんしゃだい",
    ],
    start: (event, supabase, staffMembers) => startTrainTransit(event, supabase, staffMembers),
  },
  {
    key: "other",
    label: "🚌 交通費（バス・車など）",
    triggers: [
      "交通費その他",
      "その他の交通費",
      "バス代",
      "バス代申請",
      "ガソリン代",
      "駐車場代",
    ],
    start: (event, supabase, staffMembers) => startOtherTransit(event, supabase, staffMembers),
  },
  {
    key: "transit",
    label: "🚏 交通費（手段を選ぶ）",
    triggers: [
      "交通費",
      "交通費申請",
      "交通費の申請",
      "交通費を申請",
      "交通費領収書なし",
      "交通費領収書無し",
      "領収書なし交通費",
      "領収書なしの交通費",
      "領収書無し交通費",
      "こうつうひ",
    ],
    start: (event, supabase, staffMembers) => handleTransitEntry(event, supabase, staffMembers),
  },
  {
    key: "receipt",
    label: "🧾 領収書を送る",
    triggers: [
      "領収書",
      "領収書を送る",
      "領収書送る",
      "領収書の送り方",
      "領収書提出",
      "領収書を提出",
      "レシート",
      "りょうしゅうしょ",
    ],
    start: async (event) => {
      await sendLineMessage(event.replyToken, event.source.userId, RECEIPT_GUIDE_TEXT)
    },
  },
  {
    key: "station",
    label: "🏠 自宅最寄り駅の登録",
    triggers: [
      "最寄り駅",
      "最寄駅",
      "駅登録",
      "駅の登録",
      "最寄り駅登録",
      "最寄駅登録",
      "最寄り駅の登録",
      "自宅最寄り駅",
      "もよりえき",
    ],
    start: (event, supabase, staffMembers) => handleHomeStationEntry(event, supabase, staffMembers),
  },
]

/** 正規化済みトリガー → 申請メニュー項目の索引（起動時に1度だけ構築） */
const MENU_TRIGGER_INDEX: Map<string, ApplicationMenuItem> = (() => {
  const index = new Map<string, ApplicationMenuItem>()
  for (const item of APPLICATION_MENU) {
    for (const t of item.triggers) {
      const key = normalizeTrigger(t)
      // 先に定義された項目を優先（例：「電車の交通費」は電車代に寄せる）
      if (!index.has(key)) index.set(key, item)
    }
  }
  return index
})()

/** 「申請」系＝申請メニュー（Quick Reply）を表示するトリガー */
const APPLICATION_MENU_TRIGGERS = new Set([
  "申請",
  "申請したい",
  "申請メニュー",
  "しんせい",
  "メニュー",
  "menu",
  "ヘルプ",
  "へるぷ",
  "help",
  "使い方",
  "つかいかた",
  "操作一覧",
  "できること",
  "コマンド",
])

/** 領収書の送り方の案内文 */
const RECEIPT_GUIDE_TEXT =
  "🧾 領収書の送り方\n" +
  "─────────────\n" +
  "領収書の写真をこのトークにそのまま送ってください。\n" +
  "内容を自動で読み取り、区分を選ぶだけで登録できます。\n\n" +
  "※ 領収書が出ない交通費は「電車代」または「交通費」と送ってください。\n" +
  "※ PDFファイルはLINEでは受け付けていません。経理担当にお渡しください。"

/** 「申請」系の開始キーワードか */
function isApplicationMenuEntry(text: string): boolean {
  return APPLICATION_MENU_TRIGGERS.has(normalizeTrigger(text))
}

/** テキストに対応する申請メニュー項目（無ければ null） */
function findMenuItemByText(text: string): ApplicationMenuItem | null {
  return MENU_TRIGGER_INDEX.get(normalizeTrigger(text)) ?? null
}

/** 申請メニュー（Quick Reply）を送る */
async function sendApplicationMenu(replyToken: string, userId: string): Promise<void> {
  const items: PostbackAction[] = APPLICATION_MENU.map((m) => ({
    type: "postback",
    label: m.label,
    data: `action=apm&k=${encodeURIComponent(m.key)}`,
    displayText: m.label,
  }))
  items.push({ type: "postback", label: "✖ 閉じる", data: "action=apx", displayText: "✖ 閉じる" })
  await sendLineQuickReply(
    replyToken,
    userId,
    "📋 申請メニュー\n下のボタンから選んでください。\n\n" +
      "💬 マニュアル検索（例「受付の手順は？」）や名刺検索（例「田中さんの連絡先」）は、そのまま質問を送ってください。",
    items
  )
}

/** 「交通費（領収書なし）」開始キーワードか判定（完全一致の語彙 or 質問文に誤反応しない3語一致） */
function isTransitEntry(text: string): boolean {
  if (findMenuItemByText(text)?.key === "transit") return true
  const t = text.replace(/[\s　]/g, "")
  return t.includes("交通費") && t.includes("領収書") && (t.includes("なし") || t.includes("無"))
}

/** 2桁ゼロ埋め */
function pad2(s: string | number): string {
  return String(s).padStart(2, "0")
}

/** 「今日」やYYYY-MM-DD / M/D / M月D日 を YYYY-MM-DD（JST）に正規化。解釈不能は null */
function parseJpDate(text: string): string | null {
  const t = text.trim()
  if (/^(今日|きょう|本日)$/.test(t)) return toJstDateString(new Date())
  let m = t.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/)
  if (!m) {
    const mm = t.match(/^(\d{1,2})[-/月](\d{1,2})日?$/)
    if (mm) {
      const year = toJstDateString(new Date()).slice(0, 4)
      m = [mm[0], year, mm[1], mm[2]] as unknown as RegExpMatchArray
    }
  }
  if (!m) return null
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${m[1]}-${pad2(month)}-${pad2(day)}`
}

/** line_user_id（無ければ30分キャッシュ）からスタッフを解決 */
function resolveStaffForUser(
  staffMembers: { id: string; name: string; line_user_id?: string | null }[],
  userId: string
): { id: string; name: string } | null {
  const byLine = staffMembers.find((s) => s.line_user_id === userId)
  if (byLine) return { id: byLine.id, name: byLine.name }
  const cached = staffNameCache.get(userId)
  if (cached && cached.expiresAt > Date.now()) return { id: cached.staffId, name: cached.staffName }
  return null
}

/** 共通のキャンセルボタン */
function transitCancelItem(): PostbackAction {
  return { type: "postback", label: "✖ キャンセル", data: "action=trx", displayText: "✖ キャンセル" }
}

/** セッション切れ案内 */
async function sendTransitExpired(replyToken: string, userId: string): Promise<void> {
  await sendLineMessage(
    replyToken,
    userId,
    "⌛ 申請の途中経過が見つかりませんでした。\n「申請」と送ると申請メニューから最初にやり直せます。"
  )
}

/** 交通手段の選択を送る */
async function sendTransitModeChoice(replyToken: string, userId: string): Promise<void> {
  await sendLineQuickReply(
    replyToken,
    userId,
    "🚃 交通費（領収書なし）の申請です。\n交通手段を選んでください。",
    [
      { type: "postback", label: "電車", data: "action=trm&m=train", displayText: "電車" },
      { type: "postback", label: "その他（バス・車など）", data: "action=trm&m=other", displayText: "その他（バス・車など）" },
      transitCancelItem(),
    ]
  )
}

/** 到着駅の県の選択を送る（一覧外はテキスト入力も可） */
async function askArrivalPref(replyToken: string, userId: string): Promise<void> {
  const items: PostbackAction[] = NEARBY_PREFECTURES.map((p) => ({
    type: "postback",
    label: p,
    data: `action=trp&p=${encodeURIComponent(p)}`,
    displayText: p,
  }))
  items.push(transitCancelItem())
  await sendLineQuickReply(
    replyToken,
    userId,
    "到着駅の県を選んでください。\n（一覧に無い場合は県名をテキストで送ってください）",
    items
  )
}

/** 片道/往復の選択を送る（電車代は基本往復のため、往復を既定＝先頭・推奨にする） */
async function askTrip(replyToken: string, userId: string): Promise<void> {
  await sendLineQuickReply(
    replyToken,
    userId,
    "片道／往復を選んでください。\n通常は往復です（往復＝片道×2）。片道のみの場合だけ「片道」を選んでください。",
    [
      { type: "postback", label: "往復（おすすめ）", data: "action=trt&t=round", displayText: "往復" },
      { type: "postback", label: "片道", data: "action=trt&t=one", displayText: "片道" },
      transitCancelItem(),
    ]
  )
}

/** 利用日の入力を促す（今日ボタン or テキスト日付） */
async function askUseDate(replyToken: string, userId: string): Promise<void> {
  await sendLineQuickReply(
    replyToken,
    userId,
    "利用日を選んでください。\n別の日は「2026-06-20」「6/20」のように送ってください。",
    [
      { type: "postback", label: "今日", data: "action=trd&d=today", displayText: "今日" },
      transitCancelItem(),
    ]
  )
}

/** その他（手動）の確認画面 */
async function sendOtherConfirm(replyToken: string, userId: string, data: TransitData): Promise<void> {
  const purpose = data.otherPurpose?.trim()
  const text =
    "以下の内容で登録します。確認してください。\n" +
    "─────────────\n" +
    "🚌 交通手段：その他（手動）\n" +
    (purpose ? `🏷 用途・支払先：${purpose}\n` : "") +
    `💰 金額：¥${formatAmount(data.amount ?? 0)}\n` +
    `📅 利用日：${data.useDate}\n` +
    "─────────────\n" +
    "区分＝交通費＝全額・給与支給で登録します。よろしいですか？"
  await sendLineQuickReply(replyToken, userId, text, [
    { type: "postback", label: "✅ OK", data: "action=trok", displayText: "✅ OK" },
    transitCancelItem(),
  ])
}

/** 電車：AIで片道運賃を推定し、確認画面（OK/金額上書き）を送る */
async function runTrainEstimate(
  supabase: ReturnType<typeof createServiceClient>,
  event: LineEvent,
  staffId: string,
  data: TransitData
): Promise<void> {
  const { replyToken, source } = event
  const est = await estimateTrainFare({
    fromStation: data.fromStation || "",
    fromPref: data.fromPref || "",
    toStation: data.toStation || "",
    toPref: data.toPref || "",
  })

  // 推定不能（fare=null / confidence=low）は手動入力にフォールバック
  if (est.fare == null || est.confidence === "low") {
    const newData: TransitData = { ...data, estimateMethod: "manual", oneWayFare: null, estimatedTotal: null }
    await setTransitSession(supabase, source.userId, staffId, "train_confirm", newData)
    await sendLineQuickReply(
      replyToken,
      source.userId,
      "🤖 電車代を自動で推定できませんでした。\n実際に支払う金額（往復ならその合計）を円で送ってください。\n例：1480",
      [transitCancelItem()]
    )
    return
  }

  const oneWay = est.fare
  const total = data.trip === "round" ? oneWay * 2 : oneWay
  const newData: TransitData = {
    ...data,
    estimateMethod: "ai",
    oneWayFare: oneWay,
    estimatedTotal: total,
    amount: total,
  }
  await setTransitSession(supabase, source.userId, staffId, "train_confirm", newData)
  const tripLabel = data.trip === "round" ? "往復" : "片道"
  await sendLineQuickReply(
    replyToken,
    source.userId,
    `🚃 電車代は ¥${formatAmount(total)}（${tripLabel}・AI推定）と推定しました。\n` +
      `（${data.fromStation} → ${data.toStation}）\n\n` +
      "よろしければ「OK」を押してください。\n違う場合は正しい金額を円で送ってください（例：1480）。",
    [
      { type: "postback", label: "✅ OK", data: "action=trok", displayText: "✅ OK" },
      transitCancelItem(),
    ]
  )
}

/** 利用日確定後の分岐（電車＝推定へ / その他＝確認へ） */
async function applyUseDate(
  supabase: ReturnType<typeof createServiceClient>,
  event: LineEvent,
  session: TransitSession,
  useDate: string
): Promise<void> {
  const { replyToken, source } = event
  const staffId = session.staffMemberId
  if (!staffId) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  const data: TransitData = { ...session.data, useDate }
  if (session.data.mode === "other") {
    await setTransitSession(supabase, source.userId, staffId, "other_confirm", data)
    await sendOtherConfirm(replyToken, source.userId, data)
  } else {
    await runTrainEstimate(supabase, event, staffId, data)
  }
}

/** 確定処理＋メッセージ＋院長通知 */
async function doTransitFinalize(
  supabase: ReturnType<typeof createServiceClient>,
  event: LineEvent,
  session: TransitSession
): Promise<void> {
  const { replyToken, source } = event
  const data = session.data
  const staffId = session.staffMemberId
  if (!staffId) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }

  const { data: staffRow } = await supabase
    .from("staff_members")
    .select("name, is_test")
    .eq("id", staffId)
    .single()
  const staffName = (staffRow as { name?: string } | null)?.name || "スタッフ"
  const isTest = !!(staffRow as { is_test?: boolean } | null)?.is_test
  const amount = data.amount || 0
  const useDate = data.useDate || toJstDateString(new Date())

  let storeName: string
  let meta: Record<string, unknown>
  if (data.mode === "train") {
    const tripLabel = data.trip === "round" ? "往復" : "片道"
    const method = data.estimateMethod === "ai" ? "AI推定" : "手動"
    storeName = `電車：${data.fromStation}→${data.toStation}（${tripLabel}・${method}）`
    meta = {
      source: "line_transit",
      transit_mode: "train",
      estimate_method: data.estimateMethod || "manual",
      trip: data.trip || "one",
      from_station: data.fromStation,
      from_pref: data.fromPref,
      to_station: data.toStation,
      to_pref: data.toPref,
      one_way_fare: data.oneWayFare ?? null,
      estimated_total: data.estimatedTotal ?? null,
    }
  } else {
    const purpose = data.otherPurpose?.trim()
    storeName = purpose ? `その他：${purpose}（手動）` : "その他：交通費（手動）"
    meta = { source: "line_transit", transit_mode: "other", estimate_method: "manual", purpose: purpose || "" }
  }

  const result = await finalizeTransitClaim(supabase, { staffId, staffName, amount, useDate, storeName, meta })
  await clearTransitSession(supabase, source.userId)

  if (result.status === "duplicate" && result.duplicate) {
    await sendLineMessage(replyToken, source.userId, buildDuplicateWarning(result.duplicate))
    return
  }
  if (result.status === "no_amount") {
    await sendLineMessage(replyToken, source.userId, "⚠️ 金額が未確定のため登録できませんでした。最初からやり直してください。")
    return
  }
  if (result.status !== "ok") {
    await sendLineMessage(replyToken, source.userId, "⚠️ 登録中にエラーが発生しました。経理にご相談ください。")
    return
  }

  await sendLineMessage(
    replyToken,
    source.userId,
    "✅ 登録しました（交通費・全額・給与支給）。\n" +
      "─────────────\n" +
      `🏷 ${storeName}\n` +
      `💰 ¥${formatAmount(amount)}\n` +
      `📅 利用日：${useDate}\n` +
      "─────────────\n" +
      "お疲れさまでした！"
  )

  // テストスタッフは院長通知から除外
  const adminId = process.env.ADMIN_LINE_USER_ID
  if (adminId && !isTest) {
    await pushMessage(
      adminId,
      `🚃 ${staffName}さんが交通費（領収書なし）¥${formatAmount(amount)} を申請。\n${storeName}\n利用日：${useDate}`
    )
  }
}

/** 開始キーワード受信 → セッション作成 → 交通手段選択 */
async function handleTransitEntry(
  event: LineEvent,
  supabase: ReturnType<typeof createServiceClient>,
  staffMembers: StaffRow[]
): Promise<void> {
  const { replyToken, source } = event
  const staff = resolveStaffForUser(staffMembers, source.userId)
  if (!staff) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "🚃 交通費（領収書なし）の申請を始めます。\nまずお名前をテキストで送って登録してください。\n例：楠葉"
    )
    return
  }
  const ok = await setTransitSession(supabase, source.userId, staff.id, "mode", {})
  if (!ok) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "⚠️ 交通費申請機能の準備が未完了です（DBの更新待ち）。管理者にご連絡ください。"
    )
    return
  }
  await sendTransitModeChoice(replyToken, source.userId)
}

/** その他（バス・車など）の金額入力を促す */
async function askOtherAmount(replyToken: string, userId: string): Promise<void> {
  await sendLineQuickReply(
    replyToken,
    userId,
    "🚌 バス・自家用車などの交通費ですね。\n金額（円）をテキストで送ってください。\n例：1200",
    [transitCancelItem()]
  )
}

/**
 * 申請メニューの「交通費（バス・車など）」→ 交通手段の選択をスキップして手動金額入力から開始する。
 */
async function startOtherTransit(
  event: LineEvent,
  supabase: ReturnType<typeof createServiceClient>,
  staffMembers: StaffRow[]
): Promise<void> {
  const { replyToken, source } = event
  const staff = resolveStaffForUser(staffMembers, source.userId)
  if (!staff) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "🚌 交通費（領収書なし）の申請を始めます。\nまずお名前をテキストで送って登録してください。\n例：楠葉"
    )
    return
  }
  const ok = await setTransitSession(supabase, source.userId, staff.id, "other_amount", { mode: "other" })
  if (!ok) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "⚠️ 交通費申請機能の準備が未完了です（DBの更新待ち）。管理者にご連絡ください。"
    )
    return
  }
  await askOtherAmount(replyToken, source.userId)
}

/**
 * 「電車代」トリガー → 交通手段の選択をスキップして電車のフローを直接開始する。
 * 自宅最寄り駅が未登録なら、その場で登録フローへ誘導し（pendingTrain）、登録完了後に自動で電車代へ戻る。
 */
async function startTrainTransit(
  event: LineEvent,
  supabase: ReturnType<typeof createServiceClient>,
  staffMembers: StaffRow[]
): Promise<void> {
  const { replyToken, source } = event
  const staff = resolveStaffForUser(staffMembers, source.userId)
  if (!staff) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "🚃 電車代（領収書なし）の申請を始めます。\nまずお名前をテキストで送って登録してください。\n例：楠葉"
    )
    return
  }

  const { data: cur } = await supabase
    .from("staff_members")
    .select("home_station, home_station_pref")
    .eq("id", staff.id)
    .single()
  const s = cur as { home_station: string | null; home_station_pref: string | null } | null

  // 出発駅（自宅最寄り駅）が無ければ、中断せずその場で登録フローへ
  if (!s?.home_station) {
    await promptHomeStationForTrain(supabase, event, staff.id)
    return
  }

  const ok = await setTransitSession(supabase, source.userId, staff.id, "train_arrival_station", {
    mode: "train",
    fromStation: s.home_station,
    fromPref: s.home_station_pref ?? "",
  })
  if (!ok) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "⚠️ 交通費申請機能の準備が未完了です（DBの更新待ち）。管理者にご連絡ください。"
    )
    return
  }
  await sendLineQuickReply(
    replyToken,
    source.userId,
    `🚃 電車代（領収書なし）の申請です。\n🏠 出発：${s.home_station}${s.home_station_pref ? `（${s.home_station_pref}）` : ""}\n\n` +
      "到着駅（会場の最寄り駅）の名前をテキストで送ってください。\n例：梅田",
    [transitCancelItem()]
  )
}

/**
 * 電車代の申請中に自宅最寄り駅が未登録だった場合の誘導。
 * pendingTrain を立てた最寄り駅登録セッションを作り、登録完了後に電車代の申請へ自動復帰させる。
 */
async function promptHomeStationForTrain(
  supabase: ReturnType<typeof createServiceClient>,
  event: LineEvent,
  staffId: string
): Promise<void> {
  const { replyToken, source } = event
  const ok = await setTransitSession(supabase, source.userId, staffId, "home_input", { pendingTrain: true })
  if (!ok) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "⚠️ 登録機能の準備が未完了です（DBの更新待ち）。管理者にご連絡ください。"
    )
    return
  }
  await sendLineQuickReply(
    replyToken,
    source.userId,
    "🏠 自宅最寄り駅がまだ登録されていません。\n" +
      "まず自宅最寄り駅を登録します。駅名を送信してください。（例：草津駅）\n\n" +
      "登録が終わると、そのまま電車代の申請に進みます。",
    [homeCancelItem()]
  )
}

/** 交通手段の選択 */
async function handleTransitModePostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const session = await getTransitSession(supabase, source.userId)
  if (!session?.staffMemberId) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  const mode = params.get("m")
  if (mode === "train") {
    const { data: staff } = await supabase
      .from("staff_members")
      .select("name, home_station, home_station_pref")
      .eq("id", session.staffMemberId)
      .single()
    const s = staff as { name: string; home_station: string | null; home_station_pref: string | null } | null
    // 未登録でも中断せず、その場で最寄り駅の登録フローへ誘導する（登録後に電車代へ自動復帰）
    if (!s?.home_station) {
      await promptHomeStationForTrain(supabase, event, session.staffMemberId)
      return
    }
    const data: TransitData = {
      ...session.data,
      mode: "train",
      fromStation: s.home_station,
      fromPref: s.home_station_pref ?? "",
    }
    await setTransitSession(supabase, source.userId, session.staffMemberId, "train_arrival_station", data)
    await sendLineQuickReply(
      replyToken,
      source.userId,
      `🏠 出発：${s.home_station}${s.home_station_pref ? `（${s.home_station_pref}）` : ""}\n\n` +
        "到着駅（会場の最寄り駅）の名前をテキストで送ってください。\n例：梅田",
      [transitCancelItem()]
    )
  } else if (mode === "other") {
    const data: TransitData = { ...session.data, mode: "other" }
    await setTransitSession(supabase, source.userId, session.staffMemberId, "other_amount", data)
    await askOtherAmount(replyToken, source.userId)
  } else {
    await sendTransitModeChoice(replyToken, source.userId)
  }
}

/** 到着駅の県の選択 */
async function handleTransitPrefPostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const session = await getTransitSession(supabase, source.userId)
  if (!session?.staffMemberId) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  const pref = params.get("p") || ""
  const data: TransitData = { ...session.data, toPref: pref }
  await setTransitSession(supabase, source.userId, session.staffMemberId, "train_trip", data)
  await askTrip(replyToken, source.userId)
}

/** 片道/往復の選択 */
async function handleTransitTripPostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const session = await getTransitSession(supabase, source.userId)
  if (!session?.staffMemberId) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  const trip = params.get("t") === "round" ? "round" : "one"
  const data: TransitData = { ...session.data, trip }
  await setTransitSession(supabase, source.userId, session.staffMemberId, "train_date", data)
  await askUseDate(replyToken, source.userId)
}

/** 利用日＝今日 */
async function handleTransitTodayPostback(event: LineEvent): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const session = await getTransitSession(supabase, source.userId)
  if (!session?.staffMemberId) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  await applyUseDate(supabase, event, session, toJstDateString(new Date()))
}

/** 確認OK → 確定 */
async function handleTransitConfirmPostback(event: LineEvent): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const session = await getTransitSession(supabase, source.userId)
  if (!session?.staffMemberId) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  if (!session.data.amount || session.data.amount <= 0) {
    await sendLineQuickReply(
      replyToken,
      source.userId,
      "⚠️ 金額が未確定です。金額を円で送ってください。例：1480",
      [transitCancelItem()]
    )
    return
  }
  await doTransitFinalize(supabase, event, session)
}

/** キャンセル */
async function handleTransitCancelPostback(event: LineEvent): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  await clearTransitSession(supabase, source.userId)
  await sendLineMessage(replyToken, source.userId, "✋ 交通費の申請を中止しました。")
}

/** 交通費フロー中のテキスト入力をステップに応じて処理 */
async function handleTransitText(
  event: LineEvent,
  supabase: ReturnType<typeof createServiceClient>,
  session: TransitSession,
  inputText: string
): Promise<void> {
  const { replyToken, source } = event
  const staffId = session.staffMemberId

  // 中止・やり直し（どのステップでも）
  if (/^(キャンセル|中止|やめる|やめます|終了)$/.test(inputText)) {
    await clearTransitSession(supabase, source.userId)
    await sendLineMessage(replyToken, source.userId, "✋ 交通費の申請を中止しました。")
    return
  }
  if (/^(最初から|やり直し|やりなおし)$/.test(inputText)) {
    if (staffId) {
      await setTransitSession(supabase, source.userId, staffId, "mode", {})
      await sendTransitModeChoice(replyToken, source.userId)
    } else {
      await sendTransitExpired(replyToken, source.userId)
    }
    return
  }
  if (!staffId) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }

  switch (session.step) {
    case "train_arrival_station": {
      const toStation = inputText.replace(/駅$/, "").trim()
      if (!toStation) {
        await sendLineMessage(replyToken, source.userId, "到着駅名をテキストで送ってください。例：梅田")
        return
      }
      const data: TransitData = { ...session.data, toStation }
      await setTransitSession(supabase, source.userId, staffId, "train_arrival_pref", data)
      await askArrivalPref(replyToken, source.userId)
      return
    }
    case "train_arrival_pref": {
      // 一覧に無い県はテキストで受け付ける
      const data: TransitData = { ...session.data, toPref: inputText.trim() }
      await setTransitSession(supabase, source.userId, staffId, "train_trip", data)
      await askTrip(replyToken, source.userId)
      return
    }
    case "train_trip": {
      await askTrip(replyToken, source.userId) // ボタンで選んでもらう
      return
    }
    case "train_date": {
      const d = parseJpDate(inputText)
      if (!d) {
        await sendLineMessage(
          replyToken,
          source.userId,
          "日付を読み取れませんでした。「今日」または「2026-06-20」「6/20」のように送ってください。"
        )
        return
      }
      await applyUseDate(supabase, event, session, d)
      return
    }
    case "train_confirm": {
      // 金額のテキスト入力＝手動で上書きして確定
      const amt = normalizeAmount(inputText)
      if (amt == null || amt <= 0) {
        await sendLineMessage(replyToken, source.userId, "金額は数字で送ってください。例：1480")
        return
      }
      const data: TransitData = { ...session.data, amount: amt, estimateMethod: "manual" }
      await setTransitSession(supabase, source.userId, staffId, "train_confirm", data)
      await doTransitFinalize(supabase, event, { ...session, data })
      return
    }
    case "other_amount": {
      const amt = normalizeAmount(inputText)
      if (amt == null || amt <= 0) {
        await sendLineMessage(replyToken, source.userId, "金額は数字で送ってください。例：1200")
        return
      }
      const data: TransitData = { ...session.data, amount: amt }
      await setTransitSession(supabase, source.userId, staffId, "other_purpose", data)
      await sendLineQuickReply(
        replyToken,
        source.userId,
        "用途・支払先があれば入力してください（例：○○バス）。\n無ければ「なし」と送ってください。",
        [transitCancelItem()]
      )
      return
    }
    case "other_purpose": {
      const purpose = /^(なし|無し|スキップ|skip)$/i.test(inputText) ? "" : inputText.trim()
      const data: TransitData = { ...session.data, otherPurpose: purpose }
      await setTransitSession(supabase, source.userId, staffId, "other_date", data)
      await askUseDate(replyToken, source.userId)
      return
    }
    case "other_date": {
      const d = parseJpDate(inputText)
      if (!d) {
        await sendLineMessage(
          replyToken,
          source.userId,
          "日付を読み取れませんでした。「今日」または「2026-06-20」「6/20」のように送ってください。"
        )
        return
      }
      await applyUseDate(supabase, event, session, d)
      return
    }
    case "other_confirm": {
      // 金額のテキスト入力で修正可
      const amt = normalizeAmount(inputText)
      if (amt != null && amt > 0) {
        const data: TransitData = { ...session.data, amount: amt }
        await setTransitSession(supabase, source.userId, staffId, "other_confirm", data)
        await sendOtherConfirm(replyToken, source.userId, data)
        return
      }
      await sendLineMessage(replyToken, source.userId, "「OK」を押すか、修正する金額を数字で送ってください。")
      return
    }
    default: {
      await sendTransitModeChoice(replyToken, source.userId)
      return
    }
  }
}

/* ========== 自宅最寄り駅の自己登録フロー（LINE。/mkadmin管理者登録と併存） ========== */

/** 「最寄り駅」「最寄駅」開始キーワードか */
function isHomeStationEntry(text: string): boolean {
  if (findMenuItemByText(text)?.key === "station") return true
  const t = text.replace(/[\s　]/g, "")
  return t.includes("最寄り駅") || t.includes("最寄駅")
}

/** 自宅最寄り駅フロー用のキャンセルボタン */
function homeCancelItem(): PostbackAction {
  return { type: "postback", label: "✖ キャンセル", data: "action=hsx", displayText: "✖ キャンセル" }
}

/** 開始キーワード → セッション作成 → 駅名入力を促す（既登録なら現在値を併記） */
async function handleHomeStationEntry(
  event: LineEvent,
  supabase: ReturnType<typeof createServiceClient>,
  staffMembers: StaffRow[]
): Promise<void> {
  const { replyToken, source } = event
  const staff = resolveStaffForUser(staffMembers, source.userId)
  if (!staff) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "🏠 自宅最寄り駅を登録します。\nまずお名前をテキストで送って登録してください。\n例：楠葉"
    )
    return
  }
  const { data: cur } = await supabase
    .from("staff_members")
    .select("home_station, home_station_pref")
    .eq("id", staff.id)
    .single()
  const c = cur as { home_station: string | null; home_station_pref: string | null } | null

  const ok = await setTransitSession(supabase, source.userId, staff.id, "home_input", {})
  if (!ok) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "⚠️ 登録機能の準備が未完了です（DBの更新待ち）。管理者にご連絡ください。"
    )
    return
  }

  const text = c?.home_station
    ? `🏠 現在の登録：${c.home_station}${c.home_station_pref ? `（${c.home_station_pref}）` : ""}\n` +
      "変更する場合は新しい駅名を送信してください。（例：草津駅）"
    : "🏠 自宅の最寄り駅を登録します。最寄り駅名を送信してください。（例：草津駅）"
  await sendLineQuickReply(replyToken, source.userId, text, [homeCancelItem()])
}

/** 駅名テキストをGeminiで判定し、確認 or 候補提示 or 再入力に分岐 */
async function runHomeStationJudge(
  supabase: ReturnType<typeof createServiceClient>,
  event: LineEvent,
  staffId: string,
  inputText: string,
  pendingTrain = false
): Promise<void> {
  const { replyToken, source } = event
  const judge = await judgeStation(inputText)
  const cands = judge.candidates.slice(0, 4)
  // 「電車代」から誘導された登録は、各ステップをまたいでも復帰フラグを保持する
  const keep = pendingTrain ? { pendingTrain: true } : {}

  if (cands.length >= 2) {
    await setTransitSession(supabase, source.userId, staffId, "home_pick", { ...keep, homeStationCandidates: cands })
    await sendHomeStationCandidates(replyToken, source.userId, cands)
    return
  }
  if (judge.station && judge.pref) {
    const pick = { station: judge.station, pref: judge.pref, line: judge.line }
    await setTransitSession(supabase, source.userId, staffId, "home_confirm", { ...keep, homeStationPick: pick })
    await sendHomeStationConfirm(replyToken, source.userId, pick)
    return
  }
  if (cands.length === 1) {
    await setTransitSession(supabase, source.userId, staffId, "home_confirm", { ...keep, homeStationPick: cands[0] })
    await sendHomeStationConfirm(replyToken, source.userId, cands[0])
    return
  }
  // 判定不能 → 県名付き再入力
  await setTransitSession(supabase, source.userId, staffId, "home_input", keep)
  await sendLineQuickReply(
    replyToken,
    source.userId,
    "🚉 駅を特定できませんでした。県名を付けてもう一度送信してください。\n例：滋賀県 草津駅",
    [homeCancelItem()]
  )
}

/** 一意判定の確認メッセージ（OK/修正） */
async function sendHomeStationConfirm(
  replyToken: string,
  userId: string,
  pick: { station: string; pref: string; line?: string | null }
): Promise<void> {
  const lineStr = pick.line ? `・${pick.line}` : ""
  await sendLineQuickReply(
    replyToken,
    userId,
    `「${pick.station}（${pick.pref}${lineStr}）」でよろしいですか？`,
    [
      { type: "postback", label: "✅ OK", data: "action=hsok", displayText: "✅ OK" },
      { type: "postback", label: "🔄 修正", data: "action=hsfix", displayText: "🔄 修正" },
      homeCancelItem(),
    ]
  )
}

/** 複数候補の選択肢 */
async function sendHomeStationCandidates(
  replyToken: string,
  userId: string,
  candidates: { station: string; pref: string; line?: string | null }[]
): Promise<void> {
  const items: PostbackAction[] = candidates.map((c, i) => ({
    type: "postback",
    label: `${c.pref}の${c.station}`,
    data: `action=hspick&n=${i}`,
    displayText: `${c.pref}の${c.station}`,
  }))
  items.push({ type: "postback", label: "入力し直す", data: "action=hsfix", displayText: "入力し直す" })
  items.push(homeCancelItem())
  await sendLineQuickReply(
    replyToken,
    userId,
    "🚉 候補が複数あります。該当するものを選んでください。\n（無ければ「入力し直す」で県名を付けて再送信してください）",
    items
  )
}

/** 確定保存（駅名は○○駅表記に正規化）＋完了メッセージ */
async function saveHomeStation(
  supabase: ReturnType<typeof createServiceClient>,
  event: LineEvent,
  staffId: string,
  station: string,
  pref: string | null,
  pendingTrain = false
): Promise<void> {
  const { replyToken, source } = event
  const normalized = toStationName(station)
  const ok = await updateStaffHomeStation(supabase, staffId, normalized, pref || null)
  if (!ok) {
    await clearTransitSession(supabase, source.userId)
    await sendLineMessage(replyToken, source.userId, "⚠️ 登録に失敗しました。お手数ですが、もう一度お試しください。")
    return
  }

  // 「電車代」から誘導された登録なら、そのまま電車代の申請（到着駅の入力）へ戻す
  if (pendingTrain) {
    const started = await setTransitSession(supabase, source.userId, staffId, "train_arrival_station", {
      mode: "train",
      fromStation: normalized,
      fromPref: pref || "",
    })
    if (started) {
      await sendLineQuickReply(
        replyToken,
        source.userId,
        `✅ 自宅最寄り駅を「${normalized}（${pref || "県未設定"}）」で登録しました。\n\n` +
          "続けて電車代の申請に進みます。\n到着駅（会場の最寄り駅）の名前をテキストで送ってください。\n例：梅田",
        [transitCancelItem()]
      )
      return
    }
  }

  await clearTransitSession(supabase, source.userId)
  await sendLineMessage(
    replyToken,
    source.userId,
    `✅ 自宅最寄り駅を「${normalized}（${pref || "県未設定"}）」で登録しました。\n` +
      "領収書なし交通費（電車）の出発駅に使われます。"
  )
}

/** 自宅最寄り駅フロー中のテキスト（どのステップでも駅名の再判定として扱う） */
async function handleHomeStationText(
  event: LineEvent,
  supabase: ReturnType<typeof createServiceClient>,
  session: TransitSession,
  inputText: string
): Promise<void> {
  const { replyToken, source } = event
  const staffId = session.staffMemberId

  if (/^(キャンセル|中止|やめる|やめます|終了)$/.test(inputText)) {
    await clearTransitSession(supabase, source.userId)
    await sendLineMessage(replyToken, source.userId, "✋ 自宅最寄り駅の登録を中止しました。")
    return
  }
  if (!staffId) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  if (/^(最初から|やり直し|やりなおし|入力し直す|入力しなおす)$/.test(inputText)) {
    await setTransitSession(
      supabase,
      source.userId,
      staffId,
      "home_input",
      session.data.pendingTrain ? { pendingTrain: true } : {}
    )
    await sendLineQuickReply(
      replyToken,
      source.userId,
      "最寄り駅名を送信してください。（例：草津駅）",
      [homeCancelItem()]
    )
    return
  }
  // home_input / home_confirm / home_pick のいずれでも、テキストは駅名（再）入力として判定し直す
  await runHomeStationJudge(supabase, event, staffId, inputText, !!session.data.pendingTrain)
}

/** 確認OK → 保存 */
async function handleHomeStationConfirmPostback(event: LineEvent): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const session = await getTransitSession(supabase, source.userId)
  if (!session?.staffMemberId) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  const pick = session.data.homeStationPick
  if (!pick?.station || !pick?.pref) {
    await setTransitSession(supabase, source.userId, session.staffMemberId, "home_input", {})
    await sendLineQuickReply(
      replyToken,
      source.userId,
      "⚠️ 登録対象が見つかりませんでした。最寄り駅名をもう一度送信してください。",
      [homeCancelItem()]
    )
    return
  }
  await saveHomeStation(
    supabase,
    event,
    session.staffMemberId,
    pick.station,
    pick.pref,
    !!session.data.pendingTrain
  )
}

/** 候補選択 → 保存 */
async function handleHomeStationPickPostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const session = await getTransitSession(supabase, source.userId)
  if (!session?.staffMemberId) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  const n = Number(params.get("n"))
  const cands = session.data.homeStationCandidates || []
  const c = Number.isInteger(n) ? cands[n] : undefined
  if (!c?.station || !c?.pref) {
    await setTransitSession(supabase, source.userId, session.staffMemberId, "home_input", {})
    await sendLineQuickReply(
      replyToken,
      source.userId,
      "⚠️ 選択を認識できませんでした。最寄り駅名をもう一度送信してください。",
      [homeCancelItem()]
    )
    return
  }
  await saveHomeStation(supabase, event, session.staffMemberId, c.station, c.pref, !!session.data.pendingTrain)
}

/** 入力し直す → 駅名入力へ戻す */
async function handleHomeStationFixPostback(event: LineEvent): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const session = await getTransitSession(supabase, source.userId)
  if (!session?.staffMemberId) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  await setTransitSession(
    supabase,
    source.userId,
    session.staffMemberId,
    "home_input",
    session.data.pendingTrain ? { pendingTrain: true } : {}
  )
  await sendLineQuickReply(
    replyToken,
    source.userId,
    "最寄り駅名をもう一度送信してください。\n同名駅がある場合は県名を付けてください（例：滋賀県 草津駅）。",
    [homeCancelItem()]
  )
}

/** 自宅最寄り駅登録のキャンセル */
async function handleHomeStationCancelPostback(event: LineEvent): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  await clearTransitSession(supabase, source.userId)
  await sendLineMessage(replyToken, source.userId, "✋ 自宅最寄り駅の登録を中止しました。")
}

/** 質問キーワードを含むかチェック */
const QUESTION_KEYWORDS = ["？", "?", "は？", "教えて", "手順", "方法", "やり方", "どうすれば", "マニュアル", "ルール", "規則", "対応", "操作", "使い方", "どうやって", "なぜ", "何"]

function isQuestionText(text: string): boolean {
  return QUESTION_KEYWORDS.some((kw) => text.includes(kw))
}

/** 名刺検索キーワード */
const BUSINESS_CARD_KEYWORDS = [
  "連絡先", "電話番号", "電番", "携帯番号", "携帯電話",
  "メールアドレス", "メアド", "名刺",
]

function isBusinessCardQuery(text: string): boolean {
  return BUSINESS_CARD_KEYWORDS.some((kw) => text.includes(kw))
}

/** クエリから人名・会社名の候補を抽出 */
function extractSearchTerms(text: string): string[] {
  // 助詞・記号・キーワードを除去
  const stopWords = [
    ...BUSINESS_CARD_KEYWORDS,
    "さん", "様", "の", "を", "は", "が", "教えて", "ください",
    "会社", "株式会社", "有限会社", "合同会社",
  ]
  let cleaned = text
  for (const sw of stopWords) {
    cleaned = cleaned.split(sw).join(" ")
  }
  return cleaned
    .replace(/[？?！!。、・\s　]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 1)
}

/** 名刺を検索してLINE返信 */
async function handleBusinessCardQuery(
  replyToken: string,
  userId: string,
  query: string
): Promise<void> {
  try {
    const supabase = createServiceClient()
    const terms = extractSearchTerms(query)
    console.log("[LINE Bot] 名刺検索クエリ:", query, "抽出語:", terms)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cards: any[] = []

    if (terms.length > 0) {
      const orConditions = terms
        .flatMap((t) => [
          `company_name.ilike.%${t}%`,
          `name.ilike.%${t}%`,
          `department.ilike.%${t}%`,
        ])
        .join(",")
      const { data } = await supabase
        .from("business_cards")
        .select("*")
        .or(orConditions)
        .limit(5)
      cards = data || []
    }

    if (cards.length === 0) {
      await sendLineMessage(
        replyToken,
        userId,
        "🪪 該当する名刺が見つかりませんでした。\n会社名や氏名を指定してもう一度お試しください。"
      )
      return
    }

    // 返信メッセージ整形
    const lines: string[] = []
    for (const c of cards.slice(0, 5)) {
      const header = [c.company_name, c.department, c.name].filter(Boolean).join(" / ")
      lines.push(`🪪 ${header || "（名称不明）"}`)
      if (c.title) lines.push(`  ${c.title}`)
      if (c.phone) lines.push(`  ☎ ${c.phone}`)
      if (c.mobile) lines.push(`  📱 ${c.mobile}`)
      if (c.email) lines.push(`  ✉️ ${c.email}`)
      if (c.address) lines.push(`  📍 ${c.address}`)
      if (c.website) lines.push(`  🌐 ${c.website}`)
      lines.push("")
    }
    const message = lines.join("\n").trim().slice(0, 4500)
    await sendLineMessage(replyToken, userId, message)
  } catch (error) {
    console.error("[LINE Bot] 名刺検索エラー:", error)
    await sendLineMessage(replyToken, userId, "⚠️ 名刺検索中にエラーが発生しました。")
  }
}

/** マニュアル検索Bot: Gemini AIがマニュアルを参照して回答 */
async function handleManualQuery(
  replyToken: string,
  userId: string,
  query: string
): Promise<void> {
  try {
    const supabase = createServiceClient()

    // キーワードで部分一致検索（助詞・記号を除去してキーワード抽出）
    const keywords = query
      .replace(/[？?！!。、・\s]+/g, " ")
      .split(/\s+/)
      .filter((kw) => kw.length >= 2)
    console.log("[LINE Bot] マニュアル検索クエリ:", query, "キーワード:", keywords)

    let manuals: { id: string; category_id: string | null; title: string; content: string }[] = []

    if (keywords.length > 0) {
      // キーワードでOR検索
      const orConditions = keywords
        .map((kw) => `title.ilike.%${kw}%,content.ilike.%${kw}%`)
        .join(",")
      const { data: rawManuals, error: searchError } = await supabase
        .from("manuals")
        .select("*")
        .or(orConditions)
        .limit(10)

      if (searchError) {
        console.error("[LINE Bot] マニュアル検索エラー:", searchError)
      }
      manuals = (rawManuals || []) as typeof manuals
      console.log("[LINE Bot] キーワード検索ヒット数:", manuals.length)
    }

    // キーワード検索で0件の場合、全件取得してGeminiに判断を委ねる
    if (manuals.length === 0) {
      console.log("[LINE Bot] キーワード検索0件 → 全件取得してGeminiに委ねます")
      const { data: allManuals } = await supabase
        .from("manuals")
        .select("*")
        .order("created_at", { ascending: true })
      manuals = (allManuals || []) as typeof manuals
      console.log("[LINE Bot] マニュアル全件数:", manuals.length)
    }

    // カテゴリ取得
    const { data: rawCategories } = await supabase.from("manual_categories").select("*")
    const categories = (rawCategories || []) as { id: string; name: string; emoji: string }[]
    const categoryMap = new Map(categories.map((c) => [c.id, c]))

    // Gemini AIで回答生成
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      if (manuals.length === 0) {
        await sendLineMessage(replyToken, userId, "📖 マニュアルが登録されていません。管理者にお問い合わせください。")
        return
      }
      const top = manuals[0]
      const cat = top.category_id ? categoryMap.get(top.category_id) : null
      await sendLineMessage(replyToken, userId, `${cat?.emoji || "📄"} ${top.title}\n\n${top.content.slice(0, 400)}`)
      return
    }

    const { GoogleGenerativeAI } = await import("@google/generative-ai")
    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({ model: DEFAULT_GEMINI_MODEL })

    // マニュアルが0件の場合は一般知識でフォールバック
    if (manuals.length === 0) {
      console.log("[LINE Bot] マニュアル0件 → 一般知識フォールバック")
      const fallbackPrompt = `あなたは皮膚科・美容皮膚科クリニック「南草津皮フ科」のAIアシスタントです。
マニュアルが登録されていないため、皮膚科・美容皮膚科クリニックの一般的な知識として回答してください。

【スタッフからの質問】
${query}

【回答ルール】
- 皮膚科クリニックの一般的な知識に基づいて回答する
- 「一般的な対応としては」と前置きして回答する
- LINEメッセージとして読みやすいように改行を入れる
- 箇条書きを活用して見やすくする
- 回答は400文字以内に収める
- 最後に「詳細は管理者にご確認ください」と付け加える`

      const result = await model.generateContent(fallbackPrompt)
      const answer = result.response.text()
      await sendLineMessage(replyToken, userId, `📖 ${answer}`)
      return
    }

    const context = manuals
      .map((m) => {
        const cat = m.category_id ? categoryMap.get(m.category_id) : null
        return `【${cat?.emoji || "📄"} ${cat?.name || "未分類"}】${m.title}\n${m.content}`
      })
      .join("\n\n---\n\n")

    const prompt = `あなたは皮膚科・美容皮膚科クリニック「南草津皮フ科」のAIアシスタントです。
スタッフからの質問に、以下のマニュアル内容を参照して簡潔に回答してください。

【マニュアル内容】
${context}

【スタッフからの質問】
${query}

【回答ルール】
- マニュアルの内容に基づいて正確に回答する
- LINEメッセージとして読みやすいように改行を入れる
- 箇条書きを活用して見やすくする
- 回答は400文字以内に収める
- マニュアルに直接の記載がなくても、関連する内容から推測して回答する
- どうしても回答できない場合のみ「該当するマニュアルが見つかりませんでした」と伝える`

    const result = await model.generateContent(prompt)
    const answer = result.response.text()

    await sendLineMessage(replyToken, userId, `📖 ${answer}`)
  } catch (error) {
    console.error("[LINE Bot] マニュアル検索エラー:", error)
    await sendLineMessage(replyToken, userId, "⚠️ マニュアル検索中にエラーが発生しました。")
  }
}

/** テキストメッセージ処理: スタッフ名照合 / マニュアル検索 / その他 */
async function handleTextMessage(event: LineEvent): Promise<void> {
  const { replyToken, source, message } = event
  const inputText = message?.text?.trim()
  if (!inputText) return

  const supabase = createServiceClient()

  // 0. 進行中の対話セッションがあれば最優先で処理（テキスト入力を取りこぼさない）
  const transitSession = await getTransitSession(supabase, source.userId)
  if (transitSession) {
    if (transitSession.step.startsWith("home_")) {
      await handleHomeStationText(event, supabase, transitSession, inputText)
    } else {
      await handleTransitText(event, supabase, transitSession, inputText)
    }
    return
  }

  const staffMembers = await fetchStaffMembers(supabase)
  if (!staffMembers) {
    await sendLineMessage(replyToken, source.userId, "⚠️ システムエラーが発生しました。管理者にご連絡ください。")
    return
  }

  // 0b. 「申請」系 → 申請メニュー（Quick Reply）を表示
  if (isApplicationMenuEntry(inputText)) {
    await sendApplicationMenu(replyToken, source.userId)
    return
  }

  // 0c. 申請メニューの各項目のトリガー（電車代／交通費／領収書／最寄り駅）→ 各フローを直接開始
  const menuItem = findMenuItemByText(inputText)
  if (menuItem) {
    await menuItem.start(event, supabase, staffMembers)
    return
  }

  // 0d. 「交通費」＋「領収書」＋「なし」を含む文（従来の部分一致）→ 交通手段の選択から
  if (isTransitEntry(inputText)) {
    await handleTransitEntry(event, supabase, staffMembers)
    return
  }

  // 0e. 「最寄り駅」「最寄駅」を含む文（従来の部分一致）→ 自宅最寄り駅の登録
  if (isHomeStationEntry(inputText)) {
    await handleHomeStationEntry(event, supabase, staffMembers)
    return
  }

  // a. スタッフ名として登録済み → 既存のスタッフ登録フロー
  const matched = findStaffByName(staffMembers, inputText)
  if (matched) {
    // line_user_idが未登録の場合、自動でDBに保存する
    if (!matched.line_user_id) {
      const { error: updateError } = await supabase
        .from("staff_members")
        .update({ line_user_id: source.userId })
        .eq("id", matched.id)

      if (updateError) {
        console.error("line_user_id更新エラー:", updateError)
      } else {
        console.log(`line_user_id登録: ${matched.name} = ${source.userId}`)
      }
    }

    staffNameCache.set(source.userId, {
      staffId: matched.id,
      staffName: matched.name,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })
    await sendLineMessage(
      replyToken,
      source.userId,
      `✅ ${matched.name}さんとして登録します。\n次に領収書の写真を送ってください`
    )
    return
  }

  // b. 名刺検索キーワードを含む → 名刺検索
  if (isBusinessCardQuery(inputText)) {
    await handleBusinessCardQuery(replyToken, source.userId, inputText)
    return
  }

  // c. 質問キーワードを含む → マニュアル検索Bot
  if (isQuestionText(inputText)) {
    await handleManualQuery(replyToken, source.userId, inputText)
    return
  }

  // d. その他 → 無反応にせず、申請メニューへ誘導する短い案内
  await sendLineMessage(
    replyToken,
    source.userId,
    "🤔 操作として認識できませんでした。\n" +
      "「申請」と送ると申請メニューが表示されます。\n\n" +
      "📎 領収書はこのトークに写真を送るだけで登録できます。"
  )
}

/* ========== 1ファイル複数領収証の分割登録（LINE） ========== */

/** ①②… の丸数字（21件以上は「n.」表記にフォールバック） */
function circled(i: number): string {
  return i < 20 ? String.fromCodePoint(0x2460 + i) : `${i + 1}.`
}

/**
 * 領収書IDから分割兄弟（自分含む）を取得する。
 * レコードが見つからない場合は null（呼び出し側で従来の単独フローに任せる）。
 */
async function fetchReceiptWithSiblings(
  supabase: ReturnType<typeof createServiceClient>,
  receiptId: string
): Promise<{
  receipt: {
    id: string
    staff_member_id: string
    dropbox_path: string | null
    amount: number | null
    store_name: string | null
    date: string | null
    created_at: string
    ai_raw: unknown
    staffName: string
    isTest: boolean
  }
  siblings: SiblingReceipt[]
} | null> {
  const { data, error } = await supabase
    .from("staff_receipts")
    .select(
      "id, staff_member_id, dropbox_path, amount, store_name, date, created_at, ai_raw, staff_members!inner(name, is_test)"
    )
    .eq("id", receiptId)
    .single()
  if (error || !data) return null
  const r = data as unknown as {
    id: string
    staff_member_id: string
    dropbox_path: string | null
    amount: number | null
    store_name: string | null
    date: string | null
    created_at: string
    ai_raw: unknown
    staff_members: { name: string; is_test?: boolean | null }
  }
  const siblings = await fetchSplitSiblings(supabase, r)
  return {
    receipt: {
      id: r.id,
      staff_member_id: r.staff_member_id,
      dropbox_path: r.dropbox_path,
      amount: r.amount,
      store_name: r.store_name,
      date: r.date,
      created_at: r.created_at,
      ai_raw: r.ai_raw,
      staffName: r.staff_members.name,
      isTest: !!r.staff_members.is_test,
    },
    siblings,
  }
}

interface MultiRegisterParams {
  supabase: ReturnType<typeof createServiceClient>
  event: LineEvent
  staffId: string
  ocrResult: OcrResult & { model_used: string }
  candidates: ReceiptCandidate[]
  fileName: string
  dropboxPath: string
  imageHash: string
  /** 日付が読み取れない件に使うフォールバック日付（書類全体の日付 or 今日） */
  fallbackDate: string
}

/**
 * 複数の領収証を件数分の staff_receipts として一括登録し、
 * 検出内訳のメッセージ＋区分選択（第1階層・1回だけ）を送る。
 * 全レコードは同一ファイルを共有し、ai_raw.split_group でグループ化する。
 */
async function registerMultiReceipts(params: MultiRegisterParams): Promise<void> {
  const { supabase, event, staffId, ocrResult, candidates, fileName, dropboxPath, imageHash, fallbackDate } = params
  const { replyToken, source } = event
  const splitGroup = crypto.randomUUID()
  const docType = ocrResult.type || "領収書"

  const rows = candidates.map((c, i) => ({
    staff_member_id: staffId,
    file_name: fileName,
    dropbox_path: dropboxPath, // 全レコードで同一ファイルを共有（コピーしない）
    document_type: docType,
    // 日付はその領収証自身の領収日・決済日（読めない場合のみ書類全体の日付で補完）
    date: c.date || fallbackDate,
    amount: c.amount,
    store_name: c.store || ocrResult.vendor_name || null,
    tax_category: ocrResult.tax_category || null,
    account_title: ocrResult.account_title || null,
    ai_raw: JSON.parse(
      JSON.stringify({
        ...ocrResult,
        vendor_name: c.store || ocrResult.vendor_name,
        amount: c.amount,
        issue_date: c.date || fallbackDate, // 会計士CSVの「支払年月日」に使われる
        description: c.note || ocrResult.description,
        payments: [],
        split_group: splitGroup,
        split_index: i + 1,
        split_total: candidates.length,
      })
    ) as Json,
  }))

  // 一括INSERT（1ステートメント＝原子的。部分登録状態を作らない）。
  // image_hash は migration 030 で追加。未適用環境でも保存を止めないようフォールバック
  let insertedIds: string[] = []
  const withHash = await supabase
    .from("staff_receipts")
    .insert(rows.map((r) => ({ ...r, image_hash: imageHash })))
    .select("id")
  if (withHash.error) {
    const e = withHash.error
    const isMissingColumn =
      e.code === "PGRST204" || e.code === "42703" || /image_hash/.test(e.message || "")
    if (isMissingColumn) {
      console.warn("[LINE Bot] image_hash カラム未適用のためハッシュなしで保存（migration 030未実行）")
      const noHash = await supabase.from("staff_receipts").insert(rows).select("id")
      if (noHash.error || !noHash.data) {
        console.error("staff_receipts一括挿入エラー:", noHash.error)
        await sendLineMessage(replyToken, source.userId, "⚠️ データベースへの保存に失敗しました。管理者にご連絡ください。")
        return
      }
      insertedIds = (noHash.data as { id: string }[]).map((r) => r.id)
    } else {
      console.error("staff_receipts一括挿入エラー:", e)
      await sendLineMessage(replyToken, source.userId, "⚠️ データベースへの保存に失敗しました。管理者にご連絡ください。")
      return
    }
  } else {
    insertedIds = ((withHash.data ?? []) as { id: string }[]).map((r) => r.id)
  }
  if (insertedIds.length === 0) {
    await sendLineMessage(replyToken, source.userId, "⚠️ データベースへの保存に失敗しました。管理者にご連絡ください。")
    return
  }
  console.log(`[LINE Bot] 複数領収書を一括登録: ${insertedIds.length}件`)

  const total = candidates.reduce((sum, c) => sum + c.amount, 0)
  const detailLines = candidates
    .map(
      (c, i) =>
        `${circled(i)} ${(c.store || "不明").slice(0, 20)} ¥${formatAmount(c.amount)}（${c.date || fallbackDate}）`
    )
    .join("\n")
  const header =
    `📸 領収書を${candidates.length}件検出しました。\n` +
    "─────────────\n" +
    `${detailLines}\n` +
    `💰 合計 ¥${formatAmount(total)}\n` +
    "─────────────\n" +
    `※選んだ区分は全${candidates.length}件に適用されます。区分が異なる領収書は、お手数ですが別々に送ってください（登録後に管理画面から個別修正もできます）。`

  await sendTier1(replyToken, source.userId, insertedIds[0], header)
  console.log("[LINE Bot] 複数件の区分質問（第1階層）送信完了")
}

/**
 * 分割兄弟の全件を同一区分で精算確定する（給与支給・LINE用）。
 * 途中で失敗したら今回登録した取引をすべて削除して巻き戻す
 * （LINEは payroll 固定＝小口残高を動かさないため、取引削除だけで完全に戻る）。
 */
async function settleMultiReceipts(
  supabase: ReturnType<typeof createServiceClient>,
  event: LineEvent,
  siblings: SiblingReceipt[],
  detail: NonNullable<ReturnType<typeof getExpenseDetail>>,
  staffName: string,
  isTest: boolean
): Promise<void> {
  const { replyToken, source } = event
  const settledIds: string[] = []
  let okCount = 0
  let alreadyCount = 0

  try {
    for (const sib of siblings) {
      const result = await settleStaffReceipt({
        staffReceiptId: sib.id,
        settlementMethod: "payroll", // LINEからは常に給与支給に一本化
        subsidyCategory: detail.subsidyCategory,
        expenseDetail: detail.fullLabel,
        client: supabase,
      })
      if (result.status === "already") {
        // 二重押し・再試行時は登録済み分をスキップして残りを確定する（冪等）
        alreadyCount++
        continue
      }
      if (result.status !== "ok") {
        throw new Error(`精算確定に失敗しました（${result.status}）`)
      }
      okCount++
      settledIds.push(sib.id)
    }
  } catch (error) {
    console.error("[LINE Bot] 複数件精算エラー。ロールバックします:", error)
    if (settledIds.length > 0) {
      try {
        await supabase
          .from("petty_cash_transactions")
          .delete()
          .in("staff_receipt_id", settledIds)
          .eq("category", "staff_refund")
      } catch (rollbackError) {
        console.error("[LINE Bot] ロールバック中にエラー:", rollbackError)
      }
    }
    await sendLineMessage(
      replyToken,
      source.userId,
      "⚠️ 登録に失敗しました。今回の登録はすべて取り消しました。\nもう一度お試しいただくか、経理にご相談ください。"
    )
    return
  }

  if (okCount === 0 && alreadyCount === siblings.length) {
    await sendLineMessage(replyToken, source.userId, "ℹ️ この領収書はすでに登録済みです。")
    return
  }

  // 「セミナー2回目以降」（弁当代含む）が確定したら記録（以降「初回ATC」を非表示）
  if (detail.key === "ach_repeat" || detail.key === "bento") {
    await markSeminarRepeatClaimed(supabase, siblings[0].id)
  }

  const totalAmount = siblings.reduce((sum, s) => sum + (s.amount ?? 0), 0)
  const totalSubsidy = siblings.reduce(
    (sum, s) => sum + calcSubsidy(s.amount ?? 0, detail.subsidyCategory),
    0
  )
  const isHalf = detail.subsidyCategory === "achievement_repeat"
  const lines = siblings
    .map((s, i) => `${circled(i)} ${(s.store_name || "不明").slice(0, 20)} ¥${formatAmount(s.amount)}（${s.date || "日付不明"}）`)
    .join("\n")

  await sendLineMessage(
    replyToken,
    source.userId,
    `✅ ${siblings.length}件登録しました。給与支給で処理されます。\n` +
      "─────────────\n" +
      `${lines}\n` +
      `💰 合計 ¥${formatAmount(totalAmount)}／💴 支給額合計 ¥${formatAmount(totalSubsidy)}（${isHalf ? "半額" : "全額"}）\n` +
      "─────────────\n" +
      "お疲れさまでした！"
  )

  // 院長へpush通知（件数と内訳を含める）。テストスタッフは通知しない
  const adminId = process.env.ADMIN_LINE_USER_ID
  if (adminId && !isTest) {
    await pushMessage(
      adminId,
      `🧾 ${staffName}さんが立替${siblings.length}件（合計 ¥${formatAmount(totalAmount)}・1ファイル）を申請。\n` +
        `${lines}\n` +
        `区分: ${detail.fullLabel}\n` +
        `支給額合計: ¥${formatAmount(totalSubsidy)}（${isHalf ? "半額" : "全額"}・給与支給）`
    )
  }
}

/** 画像メッセージ処理: Gemini解析 → Dropbox保存 → DB保存 → LINE返信 */
async function handleImageMessage(event: LineEvent): Promise<void> {
  const { replyToken, source, message } = event
  if (!message?.id) return

  const supabase = createServiceClient()
  const { data: staffMembers, error: staffError } = await supabase
    .from("staff_members")
    .select("id, name, line_user_id, is_test")

  if (staffError || !staffMembers) {
    console.error("staff_members取得エラー:", staffError)
    await sendLineMessage(replyToken, source.userId, "⚠️ システムエラーが発生しました。管理者にご連絡ください。")
    return
  }

  // スタッフ名の解決: キャッシュ → displayName → 名前入力を促す
  let matchedStaff: { id: string; name: string } | undefined

  // 1. キャッシュから検索（テキストで事前送信されたスタッフ名）
  const cached = staffNameCache.get(source.userId)
  if (cached && cached.expiresAt > Date.now()) {
    matchedStaff = { id: cached.staffId, name: cached.staffName }
  }

  // 2. キャッシュに無い場合、LINEのdisplayNameで部分一致検索
  if (!matchedStaff) {
    const profile = await getLineUserProfile(source.userId)
    if (profile) {
      matchedStaff = findStaffByName(staffMembers, profile.displayName)
    }
  }

  // 3. どちらでも見つからない場合→テキストで名前入力を促す
  if (!matchedStaff) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "⚠️ お名前をテキストで送ってください\n例：楠葉"
    )
    return
  }

  // 4以降は長時間処理になるため、全体をtry-catchで囲みエラー時もLINEに返信する
  try {
    // 4. LINEから画像バイナリを取得
    console.log(`[LINE Bot] 画像取得開始: messageId=${message.id}, staff=${matchedStaff.name}`)
    const imageBuffer = await getLineMessageContent(message.id)
    if (!imageBuffer || imageBuffer.length === 0) {
      await sendLineMessage(replyToken, source.userId, "⚠️ 画像の取得に失敗しました。もう一度送ってください。")
      return
    }
    console.log(`[LINE Bot] 画像取得完了: ${imageBuffer.length} bytes`)

    // 4.5 画像ハッシュで重複チェック（解析前。同一画像の再送をハードブロック）
    const imageHash = crypto.createHash("sha256").update(imageBuffer).digest("hex")
    const imageDup = await findImageHashDuplicate(supabase, imageHash)
    if (imageDup) {
      console.log("[LINE Bot] 画像ハッシュ重複を検知 → 登録中止")
      await sendLineMessage(replyToken, source.userId, buildDuplicateWarning(imageDup))
      return
    }

    // 5. Gemini AI解析（複数領収証の分割候補も同時に判定する）
    console.log("[LINE Bot] Gemini AI解析開始")
    const base64Data = imageBuffer.toString("base64")
    const mimeType = "image/jpeg" // LINEの画像はJPEG
    const ocrResult = await analyzeDocument(base64Data, mimeType, {
      extraHint: STAFF_RECEIPT_ANALYSIS_EXTRA_HINT,
    })
    console.log(`[LINE Bot] Gemini AI解析完了: vendor=${ocrResult.vendor_name}, amount=${ocrResult.amount}, payments=${ocrResult.payments.length}`)

    // 5.2 1ファイルに複数の領収証が含まれる場合の分割候補（2件以上・全件金額ありのときのみ）
    const splitCandidates = deriveReceiptCandidates(ocrResult)

    // 5.5 内容（店名+金額+日付）で重複チェック（同一スタッフ内。別画像での再申請をブロック）
    // 分割候補があれば各件を、なければ書類全体を1回照合する（分割兄弟同士はDB未登録なので互いにブロックしない）
    const receiptDate = ocrResult.issue_date || new Date().toISOString().split("T")[0]
    const dupTargets =
      splitCandidates.length >= 2
        ? splitCandidates.map((c) => ({
            storeName: c.store || ocrResult.vendor_name || null,
            amount: c.amount as number | null,
            date: c.date || receiptDate,
          }))
        : [{ storeName: ocrResult.vendor_name || null, amount: ocrResult.amount, date: receiptDate }]
    for (const t of dupTargets) {
      const contentDup = await findContentDuplicate(supabase, {
        staffMemberId: matchedStaff.id,
        storeName: t.storeName,
        amount: t.amount,
        date: t.date,
      })
      if (contentDup) {
        console.log("[LINE Bot] 内容重複を検知 → 登録中止")
        await sendLineMessage(replyToken, source.userId, buildDuplicateWarning(contentDup))
        return
      }
    }

    // 6. Dropboxに保存（申請日＝アップロード日のフォルダ。JSTで日付を確定）
    // テストスタッフ（is_test）は保存先をテストフォルダに分離する
    const isTestStaff = !!staffMembers.find((s) => s.id === matchedStaff!.id)?.is_test
    console.log("[LINE Bot] Dropboxアップロード開始" + (isTestStaff ? "（テスト）" : ""))
    const applicationDate = toJstDateString(new Date()) // 申請日（YYYY-MM-DD・JST）
    const timestamp = Date.now().toString().slice(-6)
    const fileName = `${matchedStaff.name}_LINE_${timestamp}.jpg`
    const dropboxPath = getStaffReceiptPath(matchedStaff.name, applicationDate, fileName, isTestStaff)

    const resultPath = await uploadFile(dropboxPath, imageBuffer)
    console.log(`[LINE Bot] Dropboxアップロード完了: ${resultPath}`)

    // 6.5 複数の領収証を検出した場合: 件数分のレコードを一括登録し、区分選択（1回）に進む
    if (splitCandidates.length >= 2) {
      await registerMultiReceipts({
        supabase,
        event,
        staffId: matchedStaff.id,
        ocrResult,
        candidates: splitCandidates,
        fileName,
        dropboxPath: resultPath,
        imageHash,
        fallbackDate: receiptDate,
      })
      return
    }

    // 7. staff_receiptsに保存（精算ボタンで使うidを取得）
    console.log("[LINE Bot] DB保存開始")
    const docType = ocrResult.type || "領収書"
    const baseReceipt = {
      staff_member_id: matchedStaff.id,
      file_name: fileName,
      dropbox_path: resultPath,
      document_type: docType,
      date: receiptDate,
      amount: ocrResult.amount,
      store_name: ocrResult.vendor_name || null,
      tax_category: ocrResult.tax_category || null,
      account_title: ocrResult.account_title || null,
      ai_raw: JSON.parse(JSON.stringify(ocrResult)) as Json,
    }

    // image_hash は migration 030 で追加。未適用環境でも保存を止めないようフォールバック
    let inserted: { id: string } | null = null
    const withHash = await supabase
      .from("staff_receipts")
      .insert({ ...baseReceipt, image_hash: imageHash })
      .select("id")
      .single()

    if (withHash.error) {
      const e = withHash.error
      const isMissingColumn =
        e.code === "PGRST204" || e.code === "42703" || /image_hash/.test(e.message || "")
      if (isMissingColumn) {
        console.warn("[LINE Bot] image_hash カラム未適用のためハッシュなしで保存（migration 030未実行）")
        const noHash = await supabase
          .from("staff_receipts")
          .insert(baseReceipt)
          .select("id")
          .single()
        if (!noHash.error && noHash.data) inserted = noHash.data as { id: string }
        else console.error("staff_receipts挿入エラー:", noHash.error)
      } else {
        console.error("staff_receipts挿入エラー:", e)
      }
    } else {
      inserted = withHash.data as { id: string }
    }

    if (!inserted) {
      await sendLineMessage(replyToken, source.userId, "⚠️ データベースへの保存に失敗しました。管理者にご連絡ください。")
      return
    }
    console.log("[LINE Bot] DB保存完了")
    const receiptId = inserted.id

    // 8. まず区分を質問する（2段階フロー1段階目）。精算方法は区分選択後に自動判定する
    const storeName = ocrResult.vendor_name || "不明"
    const amount = ocrResult.amount
    const amountStr = formatAmount(amount)
    const dateStr = ocrResult.issue_date || "日付不明"

    // 金額が読み取れない場合はボタンを出さず、手動精算を案内（誤精算防止）
    if (!amount || amount <= 0) {
      await sendLineMessage(
        replyToken,
        source.userId,
        `✅ 解析しました\n${storeName} ¥${amountStr}（${dateStr}）\nDropboxに保存しました。\n⚠️ 金額が読み取れなかったため、精算は経理側で手動登録してください。`
      )
      console.log("[LINE Bot] 処理完了（金額未読のためボタンなし）")
      return
    }

    // 第1階層の区分選択（アチーブメント関連/それ以外）をクイックリプライで質問する
    const header =
      "📸 領収書を受け取りました。\n" +
      "─────────────\n" +
      `🏪 ${storeName.slice(0, 30)}\n` +
      `💰 ¥${amountStr}\n` +
      "─────────────"
    await sendTier1(replyToken, source.userId, receiptId, header)
    console.log("[LINE Bot] 区分質問（第1階層）送信完了")
  } catch (error) {
    // 予期しないエラーが発生しても必ずLINEに返信する
    console.error("[LINE Bot] 画像処理中にエラー発生:", error)
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error("[LINE Bot] エラー詳細:", errorMsg)
    await sendLineMessage(
      replyToken,
      source.userId,
      "⚠️ 処理中にエラーが発生しました。\nもう一度送ってください。"
    )
  }
}
