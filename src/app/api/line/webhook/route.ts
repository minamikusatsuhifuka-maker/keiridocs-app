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
  parseAiRawObject,
  type ReceiptCandidate,
  type SiblingReceipt,
} from "@/lib/staff-receipt-split"
import { estimateTrainFare, estimateShinkansenFare } from "@/lib/transit-fare"
import {
  getTransitSession,
  loadTransitSession,
  setTransitSession,
  clearTransitSession,
  finalizeTransitClaim,
  updateStaffHomeStation,
  NEARBY_PREFECTURES,
  SESSION_TIMEOUT_MINUTES,
  type TransitData,
  type TransitSession,
  type ResumeAction,
} from "@/lib/line-transit"
import {
  academyStartDate,
  activeCommuterPass,
  commuteMethodLabel,
  commuterPassLabel,
  familyName,
  hasPendingNameChange,
  hasPriorCourseRecord,
  isCommuteMethodUnanswered,
  isCommuterPassUnanswered,
  isLongAbsence,
  isSetupComplete,
  isSuspended,
  loadStaffLineState,
  matchStaffByFullName,
  mayHaveCommuterPass,
  normalizePersonName,
  parseLineProfile,
  stripStationSuffix,
  suspendReason,
  updateLineProfile,
  type CommuteMethod,
  type StaffLineState,
} from "@/lib/line-staff-profile"
import { decidePassDeparture, passDeductionNote } from "@/lib/commuter-pass-deduction"
import {
  COURSE_NOT_LISTED,
  OTHER_ITEMS,
  PHASE2_GROUPS,
  coursePrompt,
  courseNamePrompt,
  examAttachPrompt,
  groupPrompt,
  holdNotice,
  itemPrompt,
  rateLabel,
  sortCoursesByGuess,
  type CourseChoice,
} from "@/lib/line-phase2-flow"
import {
  DETAIL_NOTE_MAX_LENGTH,
  EXPENSE_ITEM_LABELS,
  academyTermEnd,
  availableItems,
  calcStoredSubsidy,
  type ExpenseItem,
} from "@/lib/subsidy-rules"
import { assessSubsidy } from "@/lib/subsidy-assess"
import {
  applicationConfirmCard,
  flexSizeBytes,
  FLEX_SIZE_LIMIT_BYTES,
  historyCard,
  messageAction,
  nameConfirmCard,
  nameReviewCard,
  postback as flexPostback,
  quickReply as flexQuickReply,
  receiptReceivedCard,
  settingsCard,
  stationReviewCard,
  trainConfirmCard,
  type ActionDef,
  type FlexMessage,
  type HistoryItem,
} from "@/lib/line-flex"
import { labelYearMonth, resolveStaffSubmissionMonth } from "@/lib/submission-month"
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

/** 複数のメッセージオブジェクト（テキスト・Flex）を reply→push フォールバック付きで送る（1回最大5件） */
async function sendLineMessages(replyToken: string, userId: string, messages: unknown[]): Promise<void> {
  const list = messages.slice(0, 5)
  const replied = await replyRaw(replyToken, list)
  if (!replied) {
    console.log("Reply(messages)失敗のためPushで再送:", userId)
    await pushRaw(userId, list)
  }
}

/**
 * Flexカードを送る。JSONサイズが上限（bubble 30KB）に近い場合は、届かない事故を避けるため
 * fallbackText のテキストメッセージに切り替える。before を渡すとカードの前にテキストを1通添える。
 */
async function sendFlexCard(
  replyToken: string,
  userId: string,
  card: FlexMessage,
  fallbackText: string,
  before?: string
): Promise<void> {
  const messages: unknown[] = []
  if (before) messages.push({ type: "text", text: before })
  if (flexSizeBytes(card) > FLEX_SIZE_LIMIT_BYTES) {
    console.warn("[LINE Bot] Flexカードがサイズ上限に近いためテキストで送信:", flexSizeBytes(card))
    messages.push({
      type: "text",
      text: fallbackText.slice(0, 4900),
      ...(card.quickReply ? { quickReply: card.quickReply } : {}),
    })
  } else {
    messages.push(card)
  }
  await sendLineMessages(replyToken, userId, messages)
}

/** クイックリプライ付きテキスト（message/postback を混在できる版） */
function textWithQuickReply(value: string, actions: ActionDef[]): unknown {
  return { type: "text", text: value.slice(0, 4900), quickReply: flexQuickReply(actions) }
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
    "ご不明な場合は担当にご確認ください。"
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

/** LINEの振り分けで使うスタッフ行（staff_members の必要最小限） */
type StaffRow = {
  id: string
  name: string
  /** 給与・行政上の氏名（旧姓のまま勤務している場合に入る。氏名照合はどちらでも通す） */
  legal_name?: string | null
  line_user_id?: string | null
}

/**
 * スタッフ一覧を取得する（取得できなければ null）。
 *
 * 退職者（retired_at が非NULL）は除外する。退職後に申請されると支給が発生してしまうため。
 * 過去の申請記録は staff_members に残るので、ここで除外しても履歴は壊れない。
 *
 * マイグレーション未適用の環境でも動くように、列を減らしながら順に試す。
 * - 046 未適用: legal_name が無い → 仕事上の氏名だけで照合する
 * - 043 未適用: retired_at が無い → 従来どおり全件返す
 */
async function fetchStaffMembers(
  supabase: ReturnType<typeof createServiceClient>
): Promise<StaffRow[] | null> {
  const attempts: { select: string; excludeRetired: boolean }[] = [
    { select: "id, name, legal_name, line_user_id", excludeRetired: true },
    { select: "id, name, line_user_id", excludeRetired: true },
    { select: "id, name, line_user_id", excludeRetired: false },
  ]

  let lastError: unknown = null
  for (const attempt of attempts) {
    const query = supabase.from("staff_members").select(attempt.select)
    const { data, error } = attempt.excludeRetired
      ? await query.is("retired_at", null)
      : await query
    if (!error && data) return data as unknown as StaffRow[]

    lastError = error
    const isMissingColumn =
      error?.code === "PGRST204" ||
      error?.code === "42703" ||
      /legal_name|retired_at/.test(error?.message || "")
    // 列不足以外のエラー（接続・権限など）は再試行しても同じなので即座に諦める
    if (!isMissingColumn) break
  }

  console.error("staff_members取得エラー:", lastError)
  return null
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

  // 友だち追加 → 初回オンボーディング（通常のテキストで案内）
  if (event.type === "follow") {
    await handleFollow(event)
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
 * postbackデータを振り分ける。
 *
 * 申請フロー（フェーズ2。講座ごとの上限と支給率を適用する）:
 *  - action=p2g&rid=...&g=course|other   … 何の費用か → 講座または内訳の選択へ
 *  - action=p2c&rid=...&c=<courseId>     … 講座の選択（__none__ は名称を手入力）
 *  - action=p2i&rid=...&c=...&i=<item>   … 内訳の選択 → 確認画面（OK/修正）
 *  - action=p2ok&rid=...&c=...&i=<item>  … 確定 → 給与支給で精算登録
 *  - action=fix&rid=...                  … 修正 → 最初に戻る（写真再送不要）
 *
 * 旧フロー（t1/t2/ok）は、差し替え前に送った確認カードが押された場合のためだけに残している。
 * 新しい申請は sendTier1 から p2g に入るため通らない。
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
    // フェーズ2の申請フロー（講座・内訳・確認）
    case "p2g": // 第1階層（講座・研修／それ以外）
      await handlePhase2GroupPostback(event, params)
      return
    case "p2c": // 講座の選択
      await handlePhase2CoursePostback(event, params)
      return
    case "p2i": // 内訳の選択
      await handlePhase2ItemPostback(event, params)
      return
    case "p2ok": // 確認OK → 確定
      await handlePhase2ConfirmPostback(event, params)
      return
    // 旧フロー（確認カードを送った直後の押し込みが残っている場合のみ通る）
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
    case "trs": // 新幹線の利用有無
      await handleShinkansenUsePostback(event, params)
      return
    case "trsk": // 新幹線駅の候補選択
      await handleShinkansenPickPostback(event, params)
      return
    case "trskfix": // 新幹線駅の入力し直し
      await handleShinkansenFixPostback(event)
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
    // 電車代：定期券区間の控除・金額の修正
    case "trpass":
      await handleTrainPassPostback(event, params)
      return
    case "trfix":
      await handleTransitFixPostback(event)
      return
    // 「その他」の内容が長かったときの確認
    case "dnok": {
      const rid = params.get("rid")
      const it = params.get("i") as ExpenseItem | null
      if (!rid || !it) {
        await sendLineMessage(event.replyToken, event.source.userId, "⚠️ 処理できませんでした。")
        return
      }
      await sendPhase2Confirm(event, rid, it, params.get("c"), false, false)
      return
    }
    case "dnre":
      await sendLineMessage(
        event.replyToken,
        event.source.userId,
        `何の費用ですか？\n\n${DETAIL_NOTE_MAX_LENGTH}文字以内でお願いします。`
      )
      return
    // アカデミー会員のサービス開始日（確認してから保存する）
    case "acok":
      await handleAcademyConfirmPostback(event, params)
      return
    case "acre":
      await sendLineMessage(event.replyToken, event.source.userId, ACADEMY_START_PROMPT)
      return
    // 氏名の登録（同姓対策）
    case "nmpick": // 候補から選択 → 確認カード
      await handleNamePickPostback(event, params)
      return
    case "nmok": // 確認OK → 紐づけ
      await handleNameConfirmPostback(event, params)
      return
    case "nmre": // 入力し直す
      await sendLineMessage(
        event.replyToken,
        event.source.userId,
        "お名前をフルネームで送信してください。\n（例：南 ひふ子 ／ 南ひふ子）\n※姓と名の間のスペースは、あってもなくても大丈夫です"
      )
      return
    // 初回設定（全員に1回だけ）
    case "sup":
      await handleSetupPostback(event, params)
      return
    // 設定メニュー
    case "stg":
      await handleSettingsPostback(event, params)
      return
    // 通勤手段の登録・変更
    case "cm":
      await handleCommuteMethodPostback(event, params)
      return
    // 定期券の登録・変更
    case "cp":
      await handlePassAnswerPostback(event, params)
      return
    case "cppick":
      await handlePassPickPostback(event, params)
      return
    case "cpok":
      await handlePassConfirmPostback(event)
      return
    case "cpre":
      await handlePassRetryPostback(event)
      return
    case "cpx":
      await handlePassCancelPostback(event)
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
  await sendLineQuickReply(
    replyToken,
    userId,
    groupPrompt(header),
    PHASE2_GROUPS.map((g) => ({
      type: "postback" as const,
      label: g.label,
      data: `action=p2g&rid=${receiptId}&g=${g.key}`,
      displayText: g.label,
    }))
  )
}

/* ---------- フェーズ2の申請フロー（講座・内訳・確認） ---------- */

/** 講座マスタ（選択肢に出すものだけ）。044/045 未適用なら空を返す */
async function fetchCourseChoices(
  supabase: ReturnType<typeof createServiceClient>
): Promise<CourseChoice[]> {
  try {
    const { data, error } = await supabase
      .from("courses")
      .select("id, name, kind, rule")
      .eq("is_active", true)
      .order("name", { ascending: true })
    if (error || !data) return []
    return (data as unknown as CourseChoice[]).filter((c) => c.id && c.name)
  } catch {
    return []
  }
}

/** 1件の講座を取得（確認画面・確定で分類と支給率が必要） */
async function fetchCourseById(
  supabase: ReturnType<typeof createServiceClient>,
  courseId: string
): Promise<CourseChoice | null> {
  try {
    const { data, error } = await supabase
      .from("courses")
      .select("id, name, kind, rule")
      .eq("id", courseId)
      .maybeSingle()
    if (error || !data) return null
    return data as unknown as CourseChoice
  } catch {
    return null
  }
}

/** AIが読み取った講座名の候補（領収書の摘要・店名から。無ければ null） */
function guessedCourseName(aiRaw: unknown, storeName: string | null): string | null {
  const obj = parseAiRawObject(aiRaw)
  for (const key of ["course_name", "courseName", "description", "summary"]) {
    const v = obj?.[key]
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 40)
  }
  return storeName?.trim() ? storeName.trim().slice(0, 40) : null
}

/** 第1階層（講座・研修／それ以外）の選択 */
async function handlePhase2GroupPostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const receiptId = params.get("rid")
  const group = params.get("g")
  if (!receiptId || (group !== "course" && group !== "other")) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 処理できませんでした。もう一度お試しください。")
    return
  }

  const supabase = createServiceClient()

  // それ以外: 内訳をそのまま選んでもらう
  if (group === "other") {
    await sendLineQuickReply(
      replyToken,
      source.userId,
      "何の費用ですか？\n\n" + OTHER_ITEMS.map((o) => `・${o.label} … ${o.help}`).join("\n"),
      OTHER_ITEMS.map((o) => ({
        type: "postback" as const,
        label: o.label,
        data: `action=p2i&rid=${receiptId}&i=${o.item}`,
        displayText: o.label,
      }))
    )
    return
  }

  // 講座・研修: 講座マスタから選んでもらう
  const courses = await fetchCourseChoices(supabase)
  if (courses.length === 0) {
    // 講座マスタが空のままでも申請を止めない（担当が後で割り当てる）
    await askCourseName(event, receiptId)
    return
  }

  const fetched = await fetchReceiptWithSiblings(supabase, receiptId)
  const guessed = fetched ? guessedCourseName(fetched.receipt.ai_raw, fetched.receipt.store_name) : null
  const sorted = sortCoursesByGuess(courses, guessed)

  // クイックリプライは13個まで。最後の1つは「一覧に無い」に使う
  const items: PostbackAction[] = sorted.slice(0, 12).map((c) => ({
    type: "postback",
    label: c.name,
    data: `action=p2c&rid=${receiptId}&c=${c.id}`,
    displayText: c.name,
  }))
  items.push({
    type: "postback",
    label: "一覧に無い講座",
    data: `action=p2c&rid=${receiptId}&c=${COURSE_NOT_LISTED}`,
    displayText: "一覧に無い講座",
  })

  await sendLineQuickReply(replyToken, source.userId, coursePrompt(guessed), items)
}

/** 講座の選択 → 内訳の選択へ */
async function handlePhase2CoursePostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const receiptId = params.get("rid")
  const courseId = params.get("c")
  if (!receiptId || !courseId) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 処理できませんでした。もう一度お試しください。")
    return
  }

  // 一覧に無い講座: 名称を入力してもらい、担当が講座マスタへ登録する
  if (courseId === COURSE_NOT_LISTED) {
    await askCourseName(event, receiptId)
    return
  }

  const supabase = createServiceClient()
  const course = await fetchCourseById(supabase, courseId)
  if (!course) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 講座を確認できませんでした。もう一度お試しください。")
    return
  }

  const items = availableItems(course.kind)
  await sendLineQuickReply(
    replyToken,
    source.userId,
    itemPrompt(course.name, course.kind),
    items.map((i) => ({
      type: "postback" as const,
      label: EXPENSE_ITEM_LABELS[i],
      data: `action=p2i&rid=${receiptId}&c=${courseId}&i=${i}`,
      displayText: EXPENSE_ITEM_LABELS[i],
    }))
  )
}

/** 一覧に無い講座の名称を入力してもらう */
async function askCourseName(event: LineEvent, receiptId: string): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const { data: row } = await supabase
    .from("staff_receipts")
    .select("staff_member_id")
    .eq("id", receiptId)
    .maybeSingle()
  const staffMemberId = (row as { staff_member_id?: string | null } | null)?.staff_member_id
  if (!staffMemberId) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 対象の領収書が見つかりませんでした。")
    return
  }
  const ok = await setTransitSession(supabase, source.userId, staffMemberId, "course_name", {
    noteReceiptId: receiptId,
  })
  if (!ok) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 処理中にエラーが発生しました。もう一度お試しください。")
    return
  }
  await sendLineMessage(replyToken, source.userId, courseNamePrompt())
}

/** 内訳の選択 → 確認画面へ（検定・試験は添付の確認を挟む） */
async function handlePhase2ItemPostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const receiptId = params.get("rid")
  const item = params.get("i") as ExpenseItem | null
  const courseId = params.get("c")
  if (!receiptId || !item || !(item in EXPENSE_ITEM_LABELS)) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 処理できませんでした。もう一度お試しください。")
    return
  }

  // その他: 何を立て替えたのか1行入力してもらう（買い物の立替・講座の教材費など）
  if (item === "other" && params.get("note") !== "1") {
    await askOtherDetailNote(event, receiptId, "other", courseId)
    return
  }

  // 交通費: 定期券のあるスタッフだけに、定期区間が含まれていないかを確認する。
  // ICカードは定期区間の運賃を引き落とさないので履歴の金額をそのまま申請してよいが、
  // 切符を買った場合は定期区間も含まれ、院が払う通勤手当と二重払いになる。
  if ((item === "transport" || item === "commute") && params.get("pz") === null) {
    const asked = await askCommuterPassIncluded(event, receiptId, item, courseId)
    if (asked) return
  }

  // 検定・試験: 合格通知・修了通知の写真があるかを確認する
  if (item === "exam" && params.get("at") === null) {
    await sendLineQuickReply(replyToken, source.userId, examAttachPrompt(), [
      {
        type: "postback",
        label: "送りました",
        data: `action=p2i&rid=${receiptId}&i=exam&at=1`,
        displayText: "通知の写真を送りました",
      },
      {
        type: "postback",
        label: "まだ送っていません",
        data: `action=p2i&rid=${receiptId}&i=exam&at=0`,
        displayText: "通知の写真はまだです",
      },
    ])
    return
  }

  await sendPhase2Confirm(
    event,
    receiptId,
    item,
    courseId,
    params.get("at") === "0",
    params.get("pz") === "1"
  )
}

/**
 * 定期券区間が金額に含まれていないかを確認する。
 *
 * 定期券が未登録の方には聞かない（聞いても答えようがないため）。
 * 戻り値 true＝質問を送った（呼び出し元はここで止める）。
 */
async function askCommuterPassIncluded(
  event: LineEvent,
  receiptId: string,
  item: ExpenseItem,
  courseId: string | null
): Promise<boolean> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("staff_receipts")
    .select("staff_members!inner(line_profile)")
    .eq("id", receiptId)
    .maybeSingle()
  const profile = parseLineProfile(
    (data as unknown as { staff_members?: { line_profile?: unknown } } | null)?.staff_members?.line_profile
  )
  const pass = activeCommuterPass(profile)
  if (!pass) return false // 定期券なし・未登録の方には聞かない

  const base = `action=p2i&rid=${receiptId}&i=${item}` + (courseId ? `&c=${courseId}` : "")
  await sendLineQuickReply(
    replyToken,
    source.userId,
    `定期券（${pass.from} ⇄ ${pass.to}）の区間について確認させてください。\n\n` +
      "この金額に、定期券区間の運賃は含まれていますか？\n\n" +
      "・ICカードで乗った場合は、定期券区間は引き落とされないため「含まれていない」です\n" +
      "・切符を買った場合は「含まれている」ことがあります",
    [
      {
        type: "postback",
        label: "含まれていない",
        data: `${base}&pz=0`,
        displayText: "定期券区間は含まれていません",
      },
      {
        type: "postback",
        label: "含まれている",
        data: `${base}&pz=1`,
        displayText: "定期券区間が含まれています",
      },
      {
        type: "postback",
        label: "わからない",
        data: `${base}&pz=1`,
        displayText: "わかりません",
      },
    ]
  )
  return true
}

/** 確認カードを送る（支給額・上限・保留の理由をここで見せる） */
async function sendPhase2Confirm(
  event: LineEvent,
  receiptId: string,
  item: ExpenseItem,
  courseId: string | null,
  awaitingAttachment: boolean,
  commuterPassIncluded = false
): Promise<void> {
  const { replyToken, source } = event
  try {
    const supabase = createServiceClient()
    const fetched = await fetchReceiptWithSiblings(supabase, receiptId)
    if (!fetched) {
      await sendLineMessage(replyToken, source.userId, "⚠️ 対象の領収書が見つかりませんでした。")
      return
    }
    const { receipt, siblings } = fetched
    const amount = siblings.length >= 2
      ? siblings.reduce((sum, sb) => sum + (sb.amount ?? 0), 0)
      : receipt.amount

    // 金額が読み取れない場合は確認に進めず担当へ回す（誤精算防止）
    if (!amount || amount <= 0) {
      await sendLineMessage(
        replyToken,
        source.userId,
        "⚠️ 金額が読み取れていないため申請できません。担当にご相談ください。"
      )
      return
    }

    const course = courseId ? await fetchCourseById(supabase, courseId) : null
    const pendingCourseName = course ? null : readPendingCourseName(receipt.ai_raw)

    // 支給額の判定は subsidy-assess に任せる（確定時と同じ計算）
    const assessed = await assessSubsidy({
      supabase,
      staffMemberId: receipt.staff_member_id,
      amount,
      item,
      courseId: course?.id ?? null,
      courseKind: course?.kind ?? null,
      courseRule: course?.rule ?? null,
      pendingCourseName,
      awaitingAttachment,
      commuterPassIncluded,
      // アカデミー会員の有効期間は領収書の日付で判定する（申請日ではない）
      judgeDate: receipt.date,
      submittedAt: new Date(receipt.created_at),
    })

    const applicationDate = toJstDateString(new Date(receipt.created_at))
    const month = resolveStaffSubmissionMonth(receipt.ai_raw, applicationDate).month
    const targetMonth = month ? `${labelYearMonth(month)}分` : "不明"

    const okData =
      `action=p2ok&rid=${receiptId}&i=${item}` +
      (course ? `&c=${course.id}` : "") +
      (awaitingAttachment ? "&at=0" : "") +
      (commuterPassIncluded ? "&pz=1" : "")
    const fixData = `action=fix&rid=${receiptId}`

    const card = applicationConfirmCard({
      applicant: receipt.staffName,
      course: course?.name ?? pendingCourseName ?? undefined,
      category: EXPENSE_ITEM_LABELS[item],
      purpose: readExpensePurpose(receipt.ai_raw) || undefined,
      breakdown:
        siblings.length >= 2
          ? siblings.map((sb, i) => ({
              label: `${i + 1}件目`,
              amount: sb.amount,
              sub: `${(sb.store_name || "不明").slice(0, 20)}（${sb.date || "日付不明"}）`,
            }))
          : [{ label: "支払先", amount, sub: (receipt.store_name || "不明").slice(0, 30) }],
      receiptTotal: amount,
      subsidy: assessed.subsidy,
      subsidyRateLabel: rateLabel(assessed.rate, item),
      targetMonth,
      overLimit: assessed.excess > 0 ? { category: EXPENSE_ITEM_LABELS[item], exceeded: assessed.excess } : undefined,
      okData,
      fixData,
    })

    const holdLine = assessed.holdReason ? `\n${holdNotice(assessed.holdReason)}` : ""
    const fallback =
      "この内容で申請します。\n" +
      `申請者：${receipt.staffName}\n` +
      (course ? `講座：${course.name}\n` : pendingCourseName ? `講座：${pendingCourseName}\n` : "") +
      `区分：${EXPENSE_ITEM_LABELS[item]}\n` +
      `領収書の金額：¥${formatAmount(amount)}\n` +
      `支給額：¥${formatAmount(assessed.subsidy)}（${rateLabel(assessed.rate, item)}）\n` +
      `対象月：${targetMonth}${holdLine}`
    await sendFlexCard(replyToken, source.userId, card, fallback)
  } catch (error) {
    console.error("[LINE Bot] 確認画面生成エラー:", error)
    await sendLineMessage(replyToken, source.userId, "⚠️ 処理中にエラーが発生しました。担当にご相談ください。")
  }
}

/** 一覧に無い講座として入力された講座名（ai_raw に保存している） */
function readPendingCourseName(aiRaw: unknown): string | null {
  const v = parseAiRawObject(aiRaw)?.pending_course_name
  return typeof v === "string" && v.trim() ? v.trim() : null
}

/** 入力された講座名を領収書に保存する（担当が講座マスタへ割り当てるまでの受け皿） */
async function savePendingCourseName(
  supabase: ReturnType<typeof createServiceClient>,
  receiptId: string,
  name: string
): Promise<void> {
  const { data } = await supabase.from("staff_receipts").select("ai_raw").eq("id", receiptId).maybeSingle()
  const current = parseAiRawObject((data as { ai_raw?: unknown } | null)?.ai_raw) ?? {}
  await supabase
    .from("staff_receipts")
    .update({ ai_raw: JSON.parse(JSON.stringify({ ...current, pending_course_name: name })) })
    .eq("id", receiptId)
}

/** 「OK」→ 精算を確定する（フェーズ2の区分を渡し、上限と支給率を適用する） */
async function handlePhase2ConfirmPostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const receiptId = params.get("rid")
  const item = params.get("i") as ExpenseItem | null
  const courseId = params.get("c")
  const awaitingAttachment = params.get("at") === "0"
  const commuterPassIncluded = params.get("pz") === "1"
  if (!receiptId || !item || !(item in EXPENSE_ITEM_LABELS)) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 処理できませんでした。もう一度お試しください。")
    return
  }

  const supabase = createServiceClient()
  try {
    const fetched = await fetchReceiptWithSiblings(supabase, receiptId)
    const course = courseId ? await fetchCourseById(supabase, courseId) : null
    const pendingCourseName = course
      ? null
      : fetched
        ? readPendingCourseName(fetched.receipt.ai_raw)
        : null

    const phase2 = {
      item,
      courseId: course?.id ?? null,
      courseKind: course?.kind ?? null,
      courseRule: course?.rule ?? null,
      pendingCourseName,
      awaitingAttachment,
      commuterPassIncluded,
    }

    // 分割（1ファイル複数領収証）は全件を同じ区分で確定する
    const targets = fetched && fetched.siblings.length >= 2 ? fetched.siblings.map((sb) => sb.id) : [receiptId]
    let settledAmount = 0
    let settledSubsidy = 0
    let already = 0
    for (const id of targets) {
      const result = await settleStaffReceipt({
        staffReceiptId: id,
        settlementMethod: "payroll", // LINEからは常に給与支給に一本化
        expenseDetail: EXPENSE_ITEM_LABELS[item],
        client: supabase,
        phase2,
      })
      if (result.status === "already") {
        already++
        continue
      }
      if (result.status === "not_found") {
        await sendLineMessage(replyToken, source.userId, "⚠️ 対象の領収書が見つかりませんでした。")
        return
      }
      if (result.status === "no_amount") {
        await sendLineMessage(
          replyToken,
          source.userId,
          "⚠️ 金額が読み取れていないため精算できません。担当にご相談ください。"
        )
        return
      }
      settledAmount += result.amount ?? 0
    }

    // 支給額は確定した明細から読む（確認画面と同じ計算結果になる）
    settledSubsidy = await sumSettledSubsidy(supabase, targets)

    if (already > 0 && settledAmount === 0) {
      await sendLineMessage(replyToken, source.userId, "ℹ️ この領収書はすでに登録済みです。")
      return
    }

    // 保留の理由は確定後の明細から読む（確認画面と同じ判定結果になる）
    const holdReason = await readHoldReason(supabase, receiptId)
    const subject =
      `${EXPENSE_ITEM_LABELS[item]} ¥${formatAmount(settledAmount)}（支給 ¥${formatAmount(settledSubsidy)}）を\n` +
      (holdReason ? `${holdNotice(holdReason)}\n` : "")

    await sendLineMessages(replyToken, source.userId, [
      registeredMessage(
        submissionMonthLabel(
          fetched?.receipt.ai_raw ?? null,
          fetched?.receipt.created_at ?? new Date().toISOString()
        ),
        subject
      ),
    ])
  } catch (error) {
    console.error("[LINE Bot] 精算確定エラー:", error)
    await sendLineMessage(replyToken, source.userId, "⚠️ 処理中にエラーが発生しました。担当にご相談ください。")
  }
}

/** 確定した明細の支給額の合計（保存済みの区分・超過額から計算する） */
async function sumSettledSubsidy(
  supabase: ReturnType<typeof createServiceClient>,
  staffReceiptIds: string[]
): Promise<number> {
  try {
    const { data, error } = await supabase
      .from("petty_cash_transactions")
      .select("amount, subsidy_category, expense_item, excess_amount, approved_excess")
      .in("staff_receipt_id", staffReceiptIds)
    if (error || !data) return 0
    return (data as unknown as Parameters<typeof calcStoredSubsidy>[0][]).reduce(
      (sum, row) => sum + calcStoredSubsidy(row),
      0
    )
  } catch {
    return 0
  }
}

/** 確定した明細の保留理由（無ければ null） */
async function readHoldReason(
  supabase: ReturnType<typeof createServiceClient>,
  receiptId: string
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("petty_cash_transactions")
      .select("hold_reason")
      .eq("staff_receipt_id", receiptId)
      .maybeSingle()
    if (error || !data) return null
    return (data as { hold_reason?: string | null }).hold_reason ?? null
  } catch {
    return null
  }
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
  // 既受講の登録（line_profile.prior_courses）も判定に使う。
  // 担当が登録した受講回数が1回以上なら、その人は初受講を終えているので
  // 「初回ATC＋アカデミー会員費」は出さない（初回の全額支給を二重に受けないようにする）。
  const { data, error } = await supabase
    .from("staff_receipts")
    .select("staff_members!inner(seminar_repeat_claimed_at, line_profile)")
    .eq("id", receiptId)
    .single()
  if (error) {
    console.warn("[LINE Bot] 初回ATC表示判定スキップ（migration 032未実行?）:", error.message)
    return false
  }
  const member = (
    data as unknown as {
      staff_members: { seminar_repeat_claimed_at: string | null; line_profile?: unknown }
    } | null
  )?.staff_members
  if (member?.seminar_repeat_claimed_at) return true
  return hasPriorCourseRecord(member?.line_profile)
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
    text = "種類を選んでください。\n\n※買い物の立替（事務用品など）は「その他（買い物など）」を選び、内容を入力してください。"
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

  // 「その他」は何を立て替えたのか分からないため、内容を1行入力してもらう。
  // 買い物の立替（事務用品など）が担当・会計士さんの側で判別できるようにする。
  if (detail.key === "other" && params.get("note") !== "1") {
    await askOtherDetailNote(event, receiptId, detail.key)
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
    // 「その他」で入力された内容（ai_raw に保存している）
    const expensePurpose = readExpensePurpose(receipt.ai_raw)
    const isHalf = detail.subsidyCategory === "achievement_repeat"
    // 申請日 = アップロード日（領収書の登録日）をJSTで表示
    const applicationDate = toJstDateString(new Date(receipt.created_at))

    // 対象月（提出月）＝申請日の20日締め（手動指定があればそれ）。既存の判定関数をそのまま使う
    const month = resolveStaffSubmissionMonth(receipt.ai_raw, applicationDate).month
    const targetMonth = month ? `${labelYearMonth(month)}分` : "不明"
    const rateLabel = isHalf ? "半額支給" : "全額支給"
    const okData = `action=ok&rid=${receiptId}&d=${detail.key}`
    // 「修正」からやり直したときは内容を再入力してもらうため、fixData には note を付けない
    const fixData = `action=fix&rid=${receiptId}`

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
      const card = applicationConfirmCard({
        applicant: staffName,
        category: detail.fullLabel,
        purpose: expensePurpose,
        breakdown: siblings.map((s, i) => ({
          label: `${i + 1}件目`,
          amount: s.amount,
          sub: `${(s.store_name || "不明").slice(0, 20)}（${s.date || "日付不明"}）`,
        })),
        receiptTotal: totalAmount,
        subsidy: totalSubsidy,
        subsidyRateLabel: `${rateLabel}・${siblings.length}件すべてに適用`,
        targetMonth,
        okData,
        fixData,
      })
      const fallback =
        "この内容で申請します。\n" +
        `申請者：${staffName}\n${lines}\n区分：${detail.fullLabel}\n` +
        `領収書の金額：¥${formatAmount(totalAmount)}\n支給額：¥${formatAmount(totalSubsidy)}（${rateLabel}）\n対象月：${targetMonth}`
      await sendFlexCard(replyToken, source.userId, card, fallback)
      return
    }

    const amount = receipt.amount

    // 金額が読み取れない場合は確認に進めず手動精算を案内（誤精算防止）
    if (!amount || amount <= 0) {
      await sendLineMessage(
        replyToken,
        source.userId,
        "⚠️ 金額が読み取れていないため申請できません。担当にご相談ください。"
      )
      return
    }

    const storeName = receipt.store_name || "不明"
    // 支給額（セミナー2回目以降のみ半額・端数切り捨て、他は全額）
    const subsidy = calcSubsidy(amount, detail.subsidyCategory)

    const card = applicationConfirmCard({
      applicant: staffName,
      category: detail.fullLabel,
      purpose: expensePurpose,
      breakdown: [{ label: "支払先", amount, sub: storeName.slice(0, 30) }],
      receiptTotal: amount,
      subsidy,
      subsidyRateLabel: rateLabel,
      targetMonth,
      okData,
      fixData,
    })
    const fallback =
      "この内容で申請します。\n" +
      `申請者：${staffName}\n支払先：${storeName}\n区分：${detail.fullLabel}\n` +
      `領収書の金額：¥${formatAmount(amount)}\n支給額：¥${formatAmount(subsidy)}（${rateLabel}）\n対象月：${targetMonth}`
    await sendFlexCard(replyToken, source.userId, card, fallback)
  } catch (error) {
    console.error("[LINE Bot] 確認画面生成エラー:", error)
    await sendLineMessage(replyToken, source.userId, "⚠️ 処理中にエラーが発生しました。経理にご相談ください。")
  }
}

/* ---------- 「その他」の立替の内容（買い物など） ---------- */

/** ai_raw に保存した「内容」を読み出す（未入力なら空文字） */
function readExpensePurpose(aiRaw: unknown): string {
  const obj = parseAiRawObject(aiRaw)
  const v = obj?.expense_purpose
  return typeof v === "string" ? v.trim() : ""
}

/**
 * 「その他」を選んだときに、何を立て替えたのかを1行入力してもらう。
 *
 * 「その他」のままでは担当も会計士さんも内容が分からず、問い合わせが発生する。
 * 買い物の立替（事務用品など）があるため、支払先だけでは足りない。
 */
async function askOtherDetailNote(
  event: LineEvent,
  receiptId: string,
  detailKey: string,
  courseId: string | null = null
): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  // セッションに紐づけるスタッフは領収書の持ち主（LINEの紐づけを再照合する必要がない）
  const { data: row } = await supabase
    .from("staff_receipts")
    .select("staff_member_id")
    .eq("id", receiptId)
    .maybeSingle()
  const staffMemberId = (row as { staff_member_id?: string | null } | null)?.staff_member_id
  if (!staffMemberId) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 対象の領収書が見つかりませんでした。")
    return
  }
  const ok = await setTransitSession(supabase, source.userId, staffMemberId, "detail_note", {
    noteReceiptId: receiptId,
    noteDetailKey: detailKey,
    noteCourseId: courseId ?? undefined,
  })
  if (!ok) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 処理中にエラーが発生しました。もう一度お試しください。")
    return
  }
  await sendLineMessage(
    replyToken,
    source.userId,
    "何の費用ですか？\n\n" +
      (courseId
        ? "（例）教材費\n（例）認定料\n（例）会場までのバス代\n\n"
        : "（例）事務用品の買い物\n（例）院内で使う文房具\n（例）スタッフ用の備品\n\n") +
      `${DETAIL_NOTE_MAX_LENGTH}文字以内でお願いします。\n` +
      "※担当が内容を確認してから支給額が決まります。"
  )
}

/** 入力された内容を領収書に保存する（ai_raw にマージ。列の追加は不要） */
async function saveExpensePurpose(
  supabase: ReturnType<typeof createServiceClient>,
  receiptId: string,
  purpose: string
): Promise<void> {
  const { data } = await supabase.from("staff_receipts").select("ai_raw").eq("id", receiptId).maybeSingle()
  const current = parseAiRawObject((data as { ai_raw?: unknown } | null)?.ai_raw) ?? {}
  const next = { ...current, expense_purpose: purpose }
  await supabase
    .from("staff_receipts")
    .update({ ai_raw: JSON.parse(JSON.stringify(next)) })
    .eq("id", receiptId)
}

/** 提出月の表示（例「2026年11月」）。申請日（JST）の20日締めの既存判定をそのまま使う */
function submissionMonthLabel(aiRaw: unknown, createdAtIso: string): string {
  const month = resolveStaffSubmissionMonth(aiRaw, toJstDateString(new Date(createdAtIso))).month
  return month ? labelYearMonth(month) : "今月"
}

/**
 * 確定後のメッセージ（テキスト＋クイックリプライ）。
 * ※ 本人による「取り消す」は今回未実装のため、誤りは担当へ連絡する案内にしている。
 */
function registeredMessage(monthLabel: string, subject = ""): unknown {
  return textWithQuickReply(
    `${subject}登録しました。\n` +
      `${monthLabel}分として提出されます。\n` +
      "間違いがあれば、メニューの「問い合わせ」から担当にご連絡ください。",
    [messageAction("続けて申請する", "申請"), messageAction("申請履歴を見る", "申請履歴")]
  )
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

        await sendLineMessages(replyToken, source.userId, [
          registeredMessage(
            submissionMonthLabel(fetched?.receipt.ai_raw ?? null, fetched?.receipt.created_at ?? new Date().toISOString())
          ),
        ])

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

/** 入力待ちメッセージに添える自動リセットの注意（値は line-transit.ts の定数1箇所で決まる） */
const TIMEOUT_NOTE = `\n\n⏳ ${SESSION_TIMEOUT_MINUTES}分操作がないとリセットされます。`

/** セッションが失効していた場合の案内 */
const SESSION_EXPIRED_TEXT =
  "⌛ 前回の申請は時間が経過したためリセットされました。\nもう一度「申請」と送ってください。"

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
    // 交通費はすべてここに集約する。
    // 電車・地下鉄・バス・飛行機を区別せず「交通費」1つにまとめ、
    // ICカードの履歴・切符・領収書の写真から申請してもらう。
    // 金額を推定する方式はやめた（記録が残らず、定期券区間の扱いも曖昧になるため）。
    key: "transit",
    label: "🚃 交通費（電車・地下鉄・飛行機）",
    triggers: [
      "交通費",
      "交通費申請",
      "交通費の申請",
      "交通費を申請",
      "こうつうひ",
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
      "交通費その他",
      "その他の交通費",
      "バス代",
      "バス代申請",
      "ガソリン代",
      "駐車場代",
      "地下鉄",
      "飛行機",
      "航空券",
      "新幹線",
    ],
    start: async (event) => {
      await sendLineMessage(event.replyToken, event.source.userId, TRANSIT_GUIDE_TEXT)
    },
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

/**
 * 「申請」系＝申請メニュー（Quick Reply）を表示するトリガー。
 * リッチメニューの「申請する」ボタンは「申請」を送る。「経費」「立替」「精算」「メニュー」は手で打った人への保険。
 */
const APPLICATION_MENU_TRIGGERS = new Set([
  "申請",
  "申請する",
  "申請したい",
  "申請メニュー",
  "しんせい",
  "メニュー",
  "menu",
  "経費",
  "経費申請",
  "立替",
  "立て替え",
  "立替申請",
  "精算",
  "操作一覧",
  "できること",
  "コマンド",
])

/** リッチメニューの残りのボタン（申請・電車代以外）。値はリッチメニューが送るテキストと表記ゆれ */
type RichMenuCommand = "settings" | "history" | "usage" | "contact"
const RICH_MENU_COMMANDS: Record<RichMenuCommand, string[]> = {
  settings: ["設定", "設定変更", "登録内容", "せってい"],
  history: ["申請履歴", "履歴", "申請一覧", "りれき"],
  usage: ["使い方", "つかいかた", "ヘルプ", "へるぷ", "help"],
  contact: ["問い合わせ", "問合せ", "お問い合わせ", "といあわせ"],
}
const RICH_MENU_COMMAND_INDEX: Map<string, RichMenuCommand> = (() => {
  const index = new Map<string, RichMenuCommand>()
  for (const [cmd, words] of Object.entries(RICH_MENU_COMMANDS) as [RichMenuCommand, string[]][]) {
    for (const w of words) index.set(normalizeTrigger(w), cmd)
  }
  return index
})()

/** テキストに対応するリッチメニューのコマンド（無ければ null） */
function findRichMenuCommand(text: string): RichMenuCommand | null {
  return RICH_MENU_COMMAND_INDEX.get(normalizeTrigger(text)) ?? null
}

/** 使い方（リッチメニュー「使い方」） */
const USAGE_TEXT =
  "📖 使い方\n" +
  "─────────────\n" +
  "① 領収書があるとき\n写真をこのトークに送るだけです。読み取った内容を確認し、ボタンで区分を選びます。\n\n" +
  "② 電車代（領収書なし）\n下のメニューの「電車代」を押し、行き先の駅名を送ります。運賃は自動で計算します。\n\n" +
  "③ 申請した内容は、メニューの「申請履歴」で確認できます。\n\n" +
  "写真はまとめて送っても、1枚ずつ送ってもどちらでも大丈夫です。\n" +
  "最寄り駅・定期券の変更はメニューの「設定」からできます。"

/** 問い合わせ（リッチメニュー「問い合わせ」） */
const CONTACT_TEXT =
  "💬 問い合わせ\n" +
  "申請内容の間違いや、分からないことがあれば担当に直接お声がけください。\n" +
  "間違いを伝えるときは「日付・支払先・金額」を添えていただくとスムーズです。\n\n" +
  "仕事の手順の質問（例「受付の手順は？」）は、このトークに送るとマニュアルから自動で回答します。"

/** 氏名登録が終わったあとの案内（3行） */
const ONBOARDING_DONE_TEXT =
  "登録が完了しました。\n" +
  "・領収書は写真を送るだけで申請できます\n" +
  "・電車代はメニューの「電車代」から申請できます\n" +
  "・申請した内容は「申請履歴」で確認できます\n" +
  "下のメニューからいつでも申請できます。"

/** 友だち追加時の案内（通常のテキスト） */
const FOLLOW_TEXT =
  "はじめまして。経費申請の受付窓口です。\n" +
  "最初に2つだけ登録をお願いします（1分で終わります）。\n\n" +
  "① お名前の登録\n" +
  "② 自宅の最寄り駅の登録（電車代の計算に使います）\n\n" +
  "まず、お名前をフルネームで送信してください。\n" +
  "（例：南 ひふ子 ／ 南ひふ子）\n※姓と名の間のスペースは、あってもなくても大丈夫です"

/** 領収書の送り方の案内文 */
/**
 * 交通費の案内（リッチメニューの「交通費」・「電車代」などで表示）。
 *
 * 記録が残る写真を必ず送ってもらう。
 * ICカードは定期券区間の運賃を引き落とさないため、履歴の写真があれば
 * 二重払いにならない。切符の場合だけ、あとで1タップ確認する。
 */
const TRANSIT_GUIDE_TEXT =
  "🚃 交通費の申請\n" +
  "─────────────\n" +
  "次のどれかの写真を、このトークに送ってください。\n\n" +
  "・ICカード（ICOCA・PiTaPaなど）の利用履歴の画面\n" +
  "・切符や領収書\n" +
  "・新幹線や飛行機のチケット・予約画面\n\n" +
  "電車・地下鉄・バス・飛行機は、どれも「交通費」で申請できます。\n" +
  "写真を送ると、区分を選ぶボタンが出ます。\n\n" +
  "※ICカードで定期券区間を通ったときは、その分はもともと引き落とされません。\n" +
  "　履歴の金額をそのまま申請してください。\n" +
  "※切符を買って定期券区間が含まれるときは、申請のときにお尋ねします。\n" +
  "※金額が読み取りにくいときは、金額の部分がはっきり写るように撮ってください。"

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
async function sendApplicationMenu(replyToken: string, userId: string, lead = ""): Promise<void> {
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
    lead +
      "📋 申請メニュー\n下のボタンから選んでください。\n" +
      "領収書がある場合は、写真をこのトークに送るだけで申請できます。\n\n" +
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
    SESSION_EXPIRED_TEXT
  )
}

/** 交通手段の選択を送る */
async function sendTransitModeChoice(replyToken: string, userId: string, lead = ""): Promise<void> {
  await sendLineQuickReply(
    replyToken,
    userId,
    lead + "🚃 交通費（領収書なし）の申請です。\n交通手段を選んでください。" + TIMEOUT_NOTE,
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

/* ---------- 新幹線の利用（電車フローの拡張。区間を①自宅→乗車駅／②新幹線／③降車駅→会場に3分割して算定） ---------- */

/** 駅名が同一か（「○○駅」表記に正規化して比較。①③が0円になるケースの判定） */
function isSameStation(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false
  return toStationName(a.trim()) === toStationName(b.trim())
}

/** 新幹線の利用有無を尋ねる */
async function askShinkansen(replyToken: string, userId: string, prefix = ""): Promise<void> {
  await sendLineQuickReply(
    replyToken,
    userId,
    prefix + "🚄 新幹線を利用しましたか？\n（利用した場合は、新幹線の区間を分けて計算します）",
    [
      { type: "postback", label: "🚄 新幹線を利用した", data: "action=trs&s=1", displayText: "新幹線を利用した" },
      { type: "postback", label: "利用していない", data: "action=trs&s=0", displayText: "利用していない" },
      transitCancelItem(),
    ]
  )
}

/** 新幹線の乗車駅／降車駅の入力を促す */
async function askShinkansenStation(
  replyToken: string,
  userId: string,
  which: "from" | "to",
  prefix = ""
): Promise<void> {
  const text =
    which === "from"
      ? "🚄 新幹線に乗った駅（乗車駅）の名前をテキストで送ってください。\n例：京都駅"
      : "🚄 新幹線を降りた駅（降車駅）の名前をテキストで送ってください。\n例：東京駅"
  await sendLineQuickReply(replyToken, userId, prefix + text, [transitCancelItem()])
}

/** 新幹線駅の候補選択を送る */
async function sendShinkansenCandidates(
  replyToken: string,
  userId: string,
  which: "from" | "to",
  candidates: { station: string; pref: string; line?: string | null }[]
): Promise<void> {
  const items: PostbackAction[] = candidates.map((c, i) => ({
    type: "postback",
    label: `${c.pref}の${c.station}`,
    data: `action=trsk&n=${i}`,
    displayText: `${c.pref}の${c.station}`,
  }))
  items.push({ type: "postback", label: "入力し直す", data: "action=trskfix", displayText: "入力し直す" })
  items.push(transitCancelItem())
  await sendLineQuickReply(
    replyToken,
    userId,
    `🚉 ${which === "from" ? "乗車駅" : "降車駅"}の候補が複数あります。該当するものを選んでください。\n` +
      "（無ければ「入力し直す」で県名を付けて再送信してください）",
    items
  )
}

/** 新幹線駅を確定し、次のステップへ進める */
async function applyShinkansenStation(
  supabase: ReturnType<typeof createServiceClient>,
  event: LineEvent,
  staffId: string,
  data: TransitData,
  which: "from" | "to",
  pick: { station: string; pref: string }
): Promise<void> {
  const { replyToken, source } = event
  if (which === "from") {
    const next: TransitData = {
      ...data,
      skFromStation: pick.station,
      skFromPref: pick.pref,
      skCandidates: undefined,
    }
    await setTransitSession(supabase, source.userId, staffId, "train_sk_to", next)
    await askShinkansenStation(
      replyToken,
      source.userId,
      "to",
      `🚄 乗車駅：${pick.station}（${pick.pref}）\n\n`
    )
    return
  }
  const next: TransitData = {
    ...data,
    skToStation: pick.station,
    skToPref: pick.pref,
    skCandidates: undefined,
  }
  await setTransitSession(supabase, source.userId, staffId, "train_trip", next)
  await askTrip(replyToken, source.userId, `🚄 降車駅：${pick.station}（${pick.pref}）\n\n`)
}

/** 新幹線駅のテキストを既存の駅判定で解決する（曖昧なら候補提示／県名付き再入力へ） */
async function runShinkansenStationJudge(
  supabase: ReturnType<typeof createServiceClient>,
  event: LineEvent,
  staffId: string,
  data: TransitData,
  which: "from" | "to",
  inputText: string
): Promise<void> {
  const { replyToken, source } = event
  const judge = await judgeStation(inputText)
  const cands = judge.candidates.slice(0, 4)

  if (cands.length >= 2) {
    const pickStep = which === "from" ? "train_sk_from_pick" : "train_sk_to_pick"
    await setTransitSession(supabase, source.userId, staffId, pickStep, { ...data, skCandidates: cands })
    await sendShinkansenCandidates(replyToken, source.userId, which, cands)
    return
  }

  const pick =
    judge.station && judge.pref
      ? { station: judge.station, pref: judge.pref }
      : cands.length === 1
        ? { station: cands[0].station, pref: cands[0].pref }
        : null

  if (!pick) {
    const inputStep = which === "from" ? "train_sk_from" : "train_sk_to"
    await setTransitSession(supabase, source.userId, staffId, inputStep, data)
    await sendLineQuickReply(
      replyToken,
      source.userId,
      "🚉 駅を特定できませんでした。県名を付けてもう一度送信してください。\n例：京都府 京都駅",
      [transitCancelItem()]
    )
    return
  }

  await applyShinkansenStation(supabase, event, staffId, data, which, pick)
}

/** 新幹線の利用有無の選択 */
async function handleShinkansenUsePostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const session = await getTransitSession(supabase, source.userId)
  if (!session?.staffMemberId) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  const use = params.get("s") === "1"
  const data: TransitData = { ...session.data, useShinkansen: use }
  if (use) {
    await setTransitSession(supabase, source.userId, session.staffMemberId, "train_sk_from", data)
    await askShinkansenStation(replyToken, source.userId, "from")
    return
  }
  await setTransitSession(supabase, source.userId, session.staffMemberId, "train_trip", data)
  await askTrip(replyToken, source.userId)
}

/** 新幹線駅の候補選択 */
async function handleShinkansenPickPostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const session = await getTransitSession(supabase, source.userId)
  if (!session?.staffMemberId) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  const which =
    session.step === "train_sk_from_pick" ? "from" : session.step === "train_sk_to_pick" ? "to" : null
  if (!which) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  const n = Number(params.get("n"))
  const c = Number.isInteger(n) ? session.data.skCandidates?.[n] : undefined
  if (!c?.station || !c?.pref) {
    const inputStep = which === "from" ? "train_sk_from" : "train_sk_to"
    await setTransitSession(supabase, source.userId, session.staffMemberId, inputStep, session.data)
    await askShinkansenStation(replyToken, source.userId, which, "⚠️ 選択を認識できませんでした。\n\n")
    return
  }
  await applyShinkansenStation(supabase, event, session.staffMemberId, session.data, which, {
    station: c.station,
    pref: c.pref,
  })
}

/** 新幹線駅の入力し直し */
async function handleShinkansenFixPostback(event: LineEvent): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const session = await getTransitSession(supabase, source.userId)
  if (!session?.staffMemberId) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  const which = session.step === "train_sk_to_pick" || session.step === "train_sk_to" ? "to" : "from"
  const inputStep = which === "from" ? "train_sk_from" : "train_sk_to"
  await setTransitSession(supabase, source.userId, session.staffMemberId, inputStep, session.data)
  await askShinkansenStation(
    replyToken,
    source.userId,
    which,
    "同名駅がある場合は県名を付けてください（例：京都府 京都駅）。\n\n"
  )
}

/** 片道/往復の選択を送る（電車代は基本往復のため、往復を既定＝先頭・推奨にする） */
async function askTrip(replyToken: string, userId: string, prefix = ""): Promise<void> {
  await sendLineQuickReply(
    replyToken,
    userId,
    prefix +
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

  // 新幹線を利用した場合は3区間に分けて算定する
  if (data.useShinkansen) {
    await runShinkansenEstimate(supabase, event, staffId, data)
    return
  }

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
  await sendTrainConfirmCard(
    replyToken,
    source.userId,
    newData,
    oneWay,
    total,
    undefined,
    `🚃 電車代は ¥${formatAmount(total)}（${tripLabel}・AI推定）と推定しました。\n` +
      `（${data.fromStation} → ${data.toStation}）\n\n` +
      "よろしければ「この内容で申請する」を押してください。\n違う場合は正しい金額を円で送ってください（例：1480）。"
  )
}

/** 内訳1行の金額表示（推定できなかった区間は空欄扱い、同一駅は0円と明示） */
function formatLegAmount(value: number | null | undefined, sameStation: boolean): string {
  if (value == null) return "（推定できず）"
  if (sameStation && value === 0) return "¥0（同じ駅）"
  return `¥${formatAmount(value)}`
}

/**
 * 新幹線利用時の推定（片道を①②③に分けて算定し、往復なら全体を2倍する）。
 *
 * ① 自宅最寄り駅 → 新幹線乗車駅：在来線の普通運賃（既存の推定を再利用。同一駅なら0円）
 * ② 新幹線乗車駅 → 新幹線降車駅：運賃＋普通車指定席の特急料金
 * ③ 新幹線降車駅 → 会場最寄り駅：在来線の普通運賃（同一駅なら0円）
 *
 * 推定はあくまで提案値。指定席特急料金は時期・列車で変動するため、
 * 最終額はスタッフが内訳を確認・修正した後の値になる。
 * 1区間でも推定できなければ合計は出さず、その区間を空欄にして手動入力にフォールバックする
 * （全体が失敗して申請できなくなることを避ける）。
 */
async function runShinkansenEstimate(
  supabase: ReturnType<typeof createServiceClient>,
  event: LineEvent,
  staffId: string,
  data: TransitData
): Promise<void> {
  const { replyToken, source } = event
  const home = data.fromStation || ""
  const skFrom = data.skFromStation || ""
  const skTo = data.skToStation || ""
  const dest = data.toStation || ""
  const sameHead = isSameStation(home, skFrom)
  const sameTail = isSameStation(skTo, dest)

  // 3区間を並列で推定（confidence が low の区間は採用せず手動入力に回す）
  const [legLocalFrom, legShinkansen, legLocalTo] = await Promise.all([
    sameHead
      ? Promise.resolve<number | null>(0)
      : estimateTrainFare({
          fromStation: home,
          fromPref: data.fromPref || "",
          toStation: skFrom,
          toPref: data.skFromPref || "",
        }).then((r) => (r.fare != null && r.confidence === "high" ? r.fare : null)),
    estimateShinkansenFare({
      fromStation: skFrom,
      fromPref: data.skFromPref || "",
      toStation: skTo,
      toPref: data.skToPref || "",
    }).then((r) => (r.fare != null && r.confidence === "high" ? r.fare : null)),
    sameTail
      ? Promise.resolve<number | null>(0)
      : estimateTrainFare({
          fromStation: skTo,
          fromPref: data.skToPref || "",
          toStation: dest,
          toPref: data.toPref || "",
        }).then((r) => (r.fare != null && r.confidence === "high" ? r.fare : null)),
  ])

  const tripLabel = data.trip === "round" ? "往復" : "片道"
  // 見出しは推定できたときだけ「AI推定」と書く（失敗時に推定済みと誤解させない）
  const rows =
    "─────────────\n" +
    `① ${home} → ${skFrom}　${formatLegAmount(legLocalFrom, sameHead)}\n` +
    `② ${skFrom} → ${skTo}（新幹線・普通車指定席）　${formatLegAmount(legShinkansen, false)}\n` +
    `③ ${skTo} → ${dest}　${formatLegAmount(legLocalTo, sameTail)}\n` +
    "─────────────\n"
  const breakdown = `🚃 交通費（${tripLabel}・AI推定）\n` + rows

  const legs = { legLocalFrom, legShinkansen, legLocalTo }

  // 推定できない区間があれば合計を出さず、手動入力で確定してもらう
  if (legLocalFrom == null || legShinkansen == null || legLocalTo == null) {
    const newData: TransitData = {
      ...data,
      ...legs,
      estimateMethod: "manual",
      oneWayFare: null,
      estimatedTotal: null,
      amount: undefined,
    }
    await setTransitSession(supabase, source.userId, staffId, "train_confirm", newData)
    await sendLineQuickReply(
      replyToken,
      source.userId,
      `🚃 交通費（${tripLabel}）の内訳\n` +
        rows +
        "🤖 一部の区間を自動で推定できませんでした。\n" +
        `実際に支払った金額（${tripLabel}ならその合計）を円で送ってください。\n例：29180`,
      [transitCancelItem()]
    )
    return
  }

  const oneWay = legLocalFrom + legShinkansen + legLocalTo
  const total = data.trip === "round" ? oneWay * 2 : oneWay
  const newData: TransitData = {
    ...data,
    ...legs,
    estimateMethod: "ai",
    oneWayFare: oneWay,
    estimatedTotal: total,
    amount: total,
  }
  await setTransitSession(supabase, source.userId, staffId, "train_confirm", newData)
  await sendTrainConfirmCard(
    replyToken,
    source.userId,
    newData,
    oneWay,
    total,
    [
      { label: `① ${stripStationSuffix(home)}→${stripStationSuffix(skFrom)}`, amount: legLocalFrom },
      { label: `② 新幹線（指定席）`, amount: legShinkansen },
      { label: `③ ${stripStationSuffix(skTo)}→${stripStationSuffix(dest)}`, amount: legLocalTo },
    ],
    breakdown +
      (data.trip === "round"
        ? `片道合計 ¥${formatAmount(oneWay)} / 往復 ¥${formatAmount(total)}\n\n`
        : `合計 ¥${formatAmount(total)}\n\n`) +
      "よろしければ「OK」を押してください。\n" +
      `違う場合は正しい金額（${tripLabel}の合計）を円で送ってください。\n` +
      "※ 指定席特急料金は時期・列車により変動します。実額と違う場合は金額を送って上書きしてください。"
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
    // 新幹線利用時は経由（乗車駅→降車駅）も摘要に入れ、税理士提出リスト・会計士CSVで内容が読めるようにする
    const useSk = !!data.useShinkansen && !!data.skFromStation && !!data.skToStation
    const route = useSk
      ? `${data.fromStation}→${data.skFromStation}→${data.skToStation}→${data.toStation}`
      : `${data.fromStation}→${data.toStation}`
    // 定期券区間を控除した場合は摘要に明記する（出発駅＝定期券区間の端）
    const passMark = data.passDeducted ? "定期券区間控除・" : ""
    storeName = `電車：${route}（${passMark}${useSk ? "新幹線指定席・" : ""}${tripLabel}・${method}）`
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
      shinkansen: useSk,
      sk_from_station: data.skFromStation ?? null,
      sk_from_pref: data.skFromPref ?? null,
      sk_to_station: data.skToStation ?? null,
      sk_to_pref: data.skToPref ?? null,
      // 片道の内訳（①自宅→乗車駅 ②新幹線 ③降車駅→会場）。推定できなかった区間は null
      legs: useSk
        ? {
            local_from: data.legLocalFrom ?? null,
            shinkansen: data.legShinkansen ?? null,
            local_to: data.legLocalTo ?? null,
          }
        : null,
      // 定期券区間の控除（二重払い防止）。出発駅＝定期券区間の端
      commuter_pass_deducted: !!data.passDeducted,
      commuter_pass_segment: data.passSegment ?? null,
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

  await sendLineMessages(replyToken, source.userId, [
    registeredMessage(submissionMonthLabel(null, new Date().toISOString()), `交通費 ¥${formatAmount(amount)}（利用日 ${useDate}）を`),
  ])

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
  staffMembers: StaffRow[],
  lead = ""
): Promise<void> {
  const { replyToken, source } = event
  const staff = resolveStaffForUser(staffMembers, source.userId)
  if (!staff) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "🚃 交通費（領収書なし）の申請を始めます。\nまずお名前をフルネームで送信して登録してください。\n（例：南 ひふ子 ／ 南ひふ子）\n※姓と名の間のスペースは、あってもなくても大丈夫です"
    )
    return
  }
  const gate = await beginApplication(event, supabase, staff.id, { kind: "transit" })
  if (!gate.proceed) return
  const ok = await setTransitSession(supabase, source.userId, staff.id, "mode", {})
  if (!ok) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "⚠️ 交通費申請機能の準備が未完了です（DBの更新待ち）。管理者にご連絡ください。"
    )
    return
  }
  await sendTransitModeChoice(replyToken, source.userId, lead + gate.greeting)
}

/** その他（バス・車など）の金額入力を促す */
async function askOtherAmount(replyToken: string, userId: string, lead = ""): Promise<void> {
  await sendLineQuickReply(
    replyToken,
    userId,
    lead + "🚌 バス・自家用車などの交通費ですね。\n金額（円）をテキストで送ってください。\n例：1200" + TIMEOUT_NOTE,
    [transitCancelItem()]
  )
}

/**
 * 申請メニューの「交通費（バス・車など）」→ 交通手段の選択をスキップして手動金額入力から開始する。
 */
async function startOtherTransit(
  event: LineEvent,
  supabase: ReturnType<typeof createServiceClient>,
  staffMembers: StaffRow[],
  lead = ""
): Promise<void> {
  const { replyToken, source } = event
  const staff = resolveStaffForUser(staffMembers, source.userId)
  if (!staff) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "🚌 交通費（領収書なし）の申請を始めます。\nまずお名前をフルネームで送信して登録してください。\n（例：南 ひふ子 ／ 南ひふ子）\n※姓と名の間のスペースは、あってもなくても大丈夫です"
    )
    return
  }
  const gate = await beginApplication(event, supabase, staff.id, { kind: "other" })
  if (!gate.proceed) return
  const ok = await setTransitSession(supabase, source.userId, staff.id, "other_amount", { mode: "other" })
  if (!ok) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "⚠️ 交通費申請機能の準備が未完了です（DBの更新待ち）。管理者にご連絡ください。"
    )
    return
  }
  await askOtherAmount(replyToken, source.userId, lead + gate.greeting + `${familyName(staff.name)}さんとして申請します。\n\n`)
}

/**
 * 「電車代」トリガー → 交通手段の選択をスキップして電車のフローを直接開始する。
 * 自宅最寄り駅が未登録なら、その場で登録フローへ誘導し（pendingTrain）、登録完了後に自動で電車代へ戻る。
 */
async function startTrainTransit(
  event: LineEvent,
  supabase: ReturnType<typeof createServiceClient>,
  staffMembers: StaffRow[],
  lead = ""
): Promise<void> {
  const { replyToken, source } = event
  const staff = resolveStaffForUser(staffMembers, source.userId)
  if (!staff) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "🚃 電車代（領収書なし）の申請を始めます。\nまずお名前をフルネームで送信して登録してください。\n（例：南 ひふ子 ／ 南ひふ子）\n※姓と名の間のスペースは、あってもなくても大丈夫です"
    )
    return
  }

  // 初回設定（氏名確認・最寄り駅・定期券）が未完了なら1回だけ挟む（完了後に電車代へ戻る）
  const gate = await beginApplication(event, supabase, staff.id, { kind: "train" })
  if (!gate.proceed) return

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
    lead +
      gate.greeting +
      `🚃 電車代（領収書なし）の申請です。\n${familyName(staff.name)}さんとして申請します。\n🏠 出発：${s.home_station}${s.home_station_pref ? `（${s.home_station_pref}）` : ""}\n\n` +
      "到着駅（会場の最寄り駅）の名前をテキストで送ってください。\n例：梅田" +
      TIMEOUT_NOTE,
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
      "登録が終わると、そのまま電車代の申請に進みます。" +
      TIMEOUT_NOTE,
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
  await afterArrivalPref(supabase, event, session.staffMemberId, data)
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
      await afterArrivalPref(supabase, event, staffId, data)
      return
    }
    case "train_shinkansen": {
      await askShinkansen(replyToken, source.userId) // ボタンで選んでもらう
      return
    }
    case "train_sk_from":
    case "train_sk_from_pick": {
      await runShinkansenStationJudge(supabase, event, staffId, session.data, "from", inputText)
      return
    }
    case "train_sk_to":
    case "train_sk_to_pick": {
      await runShinkansenStationJudge(supabase, event, staffId, session.data, "to", inputText)
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
    case "academy_start": {
      // アカデミー会員のサービス開始日。再受講「3年で6回」の起算日になる
      const date = parseJpDate(inputText)
      if (!date) {
        await sendLineMessage(
          replyToken,
          source.userId,
          "日付を読み取れませんでした。\n「2025-12-01」「2025年12月1日」のように送ってください。"
        )
        return
      }
      const end = academyTermEnd(date)
      // あとから本人が直せないため、保存の前に必ず確認する
      await sendLineQuickReply(
        replyToken,
        source.userId,
        "この内容で登録します。間違いありませんか？\n\n" +
          `　サービス開始日：${jpDate(date)}\n` +
          (end ? `　再受講の期限：${jpDate(end)}\n` : "") +
          "\n※登録後はご自身で変更できません。\n" +
          "　間違えた場合は担当が修正しますので、「問い合わせ」からご連絡ください。",
        [
          {
            type: "postback",
            label: "この内容で登録",
            data: `action=acok&d=${date}`,
            displayText: "この内容で登録します",
          },
          {
            type: "postback",
            label: "入力し直す",
            data: "action=acre",
            displayText: "入力し直します",
          },
        ]
      )
      return
    }
    case "course_name": {
      // 一覧に無い講座の名称。担当が講座マスタへ登録するまで保留になる
      const receiptId = session.data.noteReceiptId
      if (!receiptId) {
        await sendTransitExpired(replyToken, source.userId)
        return
      }
      const name = inputText.trim().slice(0, 60)
      if (!name) {
        await sendLineMessage(replyToken, source.userId, courseNamePrompt())
        return
      }
      await savePendingCourseName(supabase, receiptId, name)
      await clearTransitSession(supabase, source.userId)
      // 講座の分類が決まっていないので、内訳は共通のものだけ出す
      await sendLineQuickReply(
        replyToken,
        source.userId,
        `「${name}」として申請します。\n何の費用ですか？`,
        (["tuition", "transport", "lodging"] as ExpenseItem[]).map((i) => ({
          type: "postback" as const,
          label: EXPENSE_ITEM_LABELS[i],
          data: `action=p2i&rid=${receiptId}&i=${i}`,
          displayText: EXPENSE_ITEM_LABELS[i],
        }))
      )
      return
    }
    case "detail_note": {
      // 「その他」の立替の内容。担当・会計士さんが見るので空のままにはしない
      const receiptId = session.data.noteReceiptId
      const detailKey = session.data.noteDetailKey || "other"
      if (!receiptId) {
        await sendTransitExpired(replyToken, source.userId)
        return
      }
      const purpose = inputText.trim()
      if (!purpose) {
        await sendLineMessage(replyToken, source.userId, "何の費用か、短くご入力ください。")
        return
      }
      // LINEのトーク入力はアプリ側で文字数を制限できないため、
      // 超えた分はここで切り、その内容でよいかを確認してもらう。
      if (purpose.length > DETAIL_NOTE_MAX_LENGTH) {
        const trimmed = purpose.slice(0, DETAIL_NOTE_MAX_LENGTH)
        await sendLineQuickReply(
          replyToken,
          source.userId,
          `${DETAIL_NOTE_MAX_LENGTH}文字を超えているため、ここまでで登録します。\n\n` +
            `「${trimmed}」\n\n` +
            "この内容でよろしいですか？\n" +
            "詳しい事情は「問い合わせ」から担当にお伝えいただけます。",
          [
            {
              type: "postback",
              label: "この内容でよい",
              data: `action=dnok&rid=${receiptId}&i=${detailKey || "other"}` +
                (session.data.noteCourseId ? `&c=${session.data.noteCourseId}` : ""),
              displayText: "この内容で登録します",
            },
            {
              type: "postback",
              label: "書き直す",
              data: "action=dnre",
              displayText: "書き直します",
            },
          ]
        )
        // 切り詰めた内容を保存しておき、「この内容でよい」で確定できるようにする
        await saveExpensePurpose(supabase, receiptId, trimmed)
        return
      }
      await saveExpensePurpose(supabase, receiptId, purpose)
      await clearTransitSession(supabase, source.userId)
      // 内容の入力は済んだので、そのまま確認画面へ進む（再度聞かない）
      await sendPhase2Confirm(
        event,
        receiptId,
        (detailKey || "other") as ExpenseItem,
        session.data.noteCourseId ?? null,
        false,
        false
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

/**
 * 最寄り駅の登録フローをまたいで引き継ぐ印（電車代への復帰・初回設定・変更前の駅）。
 * 候補や確認対象など、そのステップ限りの値は引き継がない。
 */
function carryHomeFlags(data: TransitData): TransitData {
  const keep: TransitData = {}
  if (data.pendingTrain) keep.pendingTrain = true
  if (data.setupFlow) keep.setupFlow = true
  if (data.resume) keep.resume = data.resume
  if (data.homeBefore) keep.homeBefore = data.homeBefore
  return keep
}

/** 「南草津駅（滋賀県）」形式 */
function stationWithPref(station: string | null | undefined, pref: string | null | undefined): string {
  if (!station) return "未登録"
  return `${station}${pref ? `（${pref}）` : ""}`
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
      "🏠 自宅最寄り駅を登録します。\nまずお名前をフルネームで送信して登録してください。\n（例：南 ひふ子 ／ 南ひふ子）\n※姓と名の間のスペースは、あってもなくても大丈夫です"
    )
    return
  }
  await startHomeStationChange(event, supabase, staff.id, {})
}

/** 最寄り駅の登録・変更を始める（設定メニュー・初回設定からも使う） */
async function startHomeStationChange(
  event: LineEvent,
  supabase: ReturnType<typeof createServiceClient>,
  staffId: string,
  base: TransitData,
  lead = ""
): Promise<void> {
  const { replyToken, source } = event
  const { data: cur } = await supabase
    .from("staff_members")
    .select("home_station, home_station_pref")
    .eq("id", staffId)
    .single()
  const c = cur as { home_station: string | null; home_station_pref: string | null } | null
  const homeBefore = c?.home_station ? stationWithPref(c.home_station, c.home_station_pref) : undefined

  const ok = await setTransitSession(supabase, source.userId, staffId, "home_input", {
    ...carryHomeFlags(base),
    ...(homeBefore ? { homeBefore } : {}),
  })
  if (!ok) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "⚠️ 登録機能の準備が未完了です（DBの更新待ち）。管理者にご連絡ください。"
    )
    return
  }

  const text = homeBefore
    ? `🏠 現在の登録：${homeBefore}\n` + "変更する場合は新しい駅名を送信してください。（例：草津駅）"
    : "🏠 自宅の最寄り駅を登録します。最寄り駅名を送信してください。（例：南草津駅）"
  await sendLineQuickReply(replyToken, source.userId, lead + text + TIMEOUT_NOTE, [homeCancelItem()])
}

/** 駅名テキストをGeminiで判定し、確認 or 候補提示 or 再入力に分岐 */
async function runHomeStationJudge(
  supabase: ReturnType<typeof createServiceClient>,
  event: LineEvent,
  staffId: string,
  inputText: string,
  current: TransitData
): Promise<void> {
  const { replyToken, source } = event
  const judge = await judgeStation(inputText)
  const cands = judge.candidates.slice(0, 4)
  // 電車代への復帰・初回設定・変更前の駅は、各ステップをまたいでも保持する
  const keep = carryHomeFlags(current)

  if (cands.length >= 2) {
    await setTransitSession(supabase, source.userId, staffId, "home_pick", { ...keep, homeStationCandidates: cands })
    await sendHomeStationCandidates(replyToken, source.userId, cands)
    return
  }
  const pick =
    judge.station && judge.pref
      ? { station: judge.station, pref: judge.pref, line: judge.line }
      : cands.length === 1
        ? cands[0]
        : null
  if (pick) {
    await setTransitSession(supabase, source.userId, staffId, "home_confirm", { ...keep, homeStationPick: pick })
    await sendHomeStationConfirm(replyToken, source.userId, pick, keep.homeBefore)
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

/** 一意判定の確認メッセージ（OK/修正）。変更時は「変更前 → 変更後」を1行で示す */
async function sendHomeStationConfirm(
  replyToken: string,
  userId: string,
  pick: { station: string; pref: string; line?: string | null },
  before?: string
): Promise<void> {
  const lineStr = pick.line ? `・${pick.line}` : ""
  const after = toStationName(pick.station)
  const text = before
    ? `${before} → ${after}（${pick.pref}${lineStr}） に変更します。\nよろしいですか？`
    : `「${after}（${pick.pref}${lineStr}）」でよろしいですか？`
  await sendLineQuickReply(replyToken, userId, text, [
    { type: "postback", label: "✅ OK", data: "action=hsok", displayText: "✅ OK" },
    { type: "postback", label: "🔄 修正", data: "action=hsfix", displayText: "🔄 修正" },
    homeCancelItem(),
  ])
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
  current: TransitData
): Promise<void> {
  const { replyToken, source } = event
  const normalized = toStationName(station)
  const ok = await updateStaffHomeStation(supabase, staffId, normalized, pref || null)
  if (!ok) {
    await clearTransitSession(supabase, source.userId)
    await sendLineMessage(replyToken, source.userId, "⚠️ 登録に失敗しました。お手数ですが、もう一度お試しください。")
    return
  }
  const afterLabel = stationWithPref(normalized, pref || "県未設定")
  const doneText = current.homeBefore
    ? `✅ ${current.homeBefore} → ${afterLabel} に変更しました。`
    : `✅ 自宅最寄り駅を「${afterLabel}」で登録しました。`

  // 初回設定の途中なら、次の設定（定期券）へ進む
  if (current.setupFlow) {
    await continueSetup(event, supabase, staffId, { ...carryHomeFlags(current), stationReviewed: true }, doneText)
    return
  }

  // 「電車代」から誘導された登録なら、そのまま電車代の申請（到着駅の入力）へ戻す
  if (current.pendingTrain) {
    const started = await setTransitSession(supabase, source.userId, staffId, "train_arrival_station", {
      mode: "train",
      fromStation: normalized,
      fromPref: pref || "",
    })
    if (started) {
      await sendLineQuickReply(
        replyToken,
        source.userId,
        `${doneText}\n\n` +
          "続けて電車代の申請に進みます。\n到着駅（会場の最寄り駅）の名前をテキストで送ってください。\n例：梅田",
        [transitCancelItem()]
      )
      return
    }
  }

  await clearTransitSession(supabase, source.userId)
  await sendLineMessage(replyToken, source.userId, `${doneText}\n電車代（領収書なし）の出発駅に使われます。`)
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
    await setTransitSession(supabase, source.userId, staffId, "home_input", carryHomeFlags(session.data))
    await sendLineQuickReply(
      replyToken,
      source.userId,
      "最寄り駅名を送信してください。（例：草津駅）",
      [homeCancelItem()]
    )
    return
  }
  // home_input / home_confirm / home_pick のいずれでも、テキストは駅名（再）入力として判定し直す
  await runHomeStationJudge(supabase, event, staffId, inputText, session.data)
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
    await setTransitSession(supabase, source.userId, session.staffMemberId, "home_input", carryHomeFlags(session.data))
    await sendLineQuickReply(
      replyToken,
      source.userId,
      "⚠️ 登録対象が見つかりませんでした。最寄り駅名をもう一度送信してください。",
      [homeCancelItem()]
    )
    return
  }
  await saveHomeStation(supabase, event, session.staffMemberId, pick.station, pick.pref, session.data)
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
    await setTransitSession(supabase, source.userId, session.staffMemberId, "home_input", carryHomeFlags(session.data))
    await sendLineQuickReply(
      replyToken,
      source.userId,
      "⚠️ 選択を認識できませんでした。最寄り駅名をもう一度送信してください。",
      [homeCancelItem()]
    )
    return
  }
  await saveHomeStation(supabase, event, session.staffMemberId, c.station, c.pref, session.data)
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
  await setTransitSession(supabase, source.userId, session.staffMemberId, "home_input", carryHomeFlags(session.data))
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

/** テキストメッセージ処理: リッチメニュー / 申請 / 氏名登録 / マニュアル検索 / その他 */
async function handleTextMessage(event: LineEvent): Promise<void> {
  const { replyToken, source, message } = event
  const inputText = message?.text?.trim()
  if (!inputText) return

  const supabase = createServiceClient()

  // 「使い方」「問い合わせ」は読むだけの案内なので、進行中の操作を中断せずに答える
  const infoCommand = findRichMenuCommand(inputText)
  if (infoCommand === "usage" || infoCommand === "contact") {
    await sendLineMessage(replyToken, source.userId, infoCommand === "usage" ? USAGE_TEXT : CONTACT_TEXT)
    return
  }

  // リッチメニュー・申請メニューのトリガー（進行中の操作より優先して切り替える）
  const isSwitchTrigger =
    isApplicationMenuEntry(inputText) || !!findMenuItemByText(inputText) || !!findRichMenuCommand(inputText)

  // 0. 進行中の対話セッションがあれば最優先で処理（テキスト入力を取りこぼさない）
  //    ただし最終操作から SESSION_TIMEOUT_MINUTES 分を過ぎたセッションは失効させ、続きとしては扱わない。
  const { session: transitSession, expired } = await loadTransitSession(supabase, source.userId)
  if (expired && !isSwitchTrigger) {
    await sendLineMessage(replyToken, source.userId, SESSION_EXPIRED_TEXT)
    return
  }
  if (transitSession) {
    // 途中でも「申請」「電車代」「設定」等のメニュー操作が来たら、前の操作を破棄して切り替える
    // （「キャンセル」「最初から」は各フロー側で従来どおり処理する）
    if (isSwitchTrigger) {
      await clearTransitSession(supabase, source.userId)
      // replyToken は新しいフローの案内に使うため、切り替えの一言は push で先に送る
      await pushMessage(source.userId, "✋ 前の操作を中止して、新しく開始します。")
    } else if (transitSession.step.startsWith("home_")) {
      await handleHomeStationText(event, supabase, transitSession, inputText)
      return
    } else if (transitSession.step.startsWith("pass_")) {
      await handlePassText(event, supabase, transitSession, inputText)
      return
    } else if (transitSession.step.startsWith("setup_")) {
      await handleSetupText(event, supabase, transitSession, inputText)
      return
    } else if (transitSession.step === "train_pass") {
      await handleTrainPassText(event, supabase, transitSession, inputText)
      return
    } else {
      await handleTransitText(event, supabase, transitSession, inputText)
      return
    }
  }

  const staffMembers = await fetchStaffMembers(supabase)
  if (!staffMembers) {
    await sendLineMessage(replyToken, source.userId, "⚠️ システムエラーが発生しました。管理者にご連絡ください。")
    return
  }
  const linked = resolveStaffForUser(staffMembers, source.userId)

  // 0a. リッチメニュー（設定／申請履歴／使い方／問い合わせ）
  const command = findRichMenuCommand(inputText)
  if (command && !linked) {
    await sendLineMessage(replyToken, source.userId, NOT_REGISTERED_TEXT)
    return
  }
  if (command === "settings" && linked) {
    await sendSettings(event, supabase, linked.id)
    return
  }
  if (command === "history" && linked) {
    await sendHistory(event, supabase, linked.id)
    return
  }

  // 0b. 「申請」系 → 申請メニュー（Quick Reply）を表示（初回設定が未完了なら1回だけ挟む）
  if (isApplicationMenuEntry(inputText)) {
    if (!linked) {
      await sendLineMessage(replyToken, source.userId, NOT_REGISTERED_TEXT)
      return
    }
    const gate = await beginApplication(event, supabase, linked.id, { kind: "menu" })
    if (!gate.proceed) return
    await sendApplicationMenu(replyToken, source.userId, gate.greeting)
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

  // a. 氏名の登録（このLINEがまだ誰にも紐づいていない場合のみ）
  //    同姓が複数なら候補を選ばせる。曖昧なまま先頭1件に紐づけない。新規スタッフは作らない。
  if (!linked) {
    if (!isBusinessCardQuery(inputText) && !isQuestionText(inputText)) {
      await handleNameRegistrationText(event, staffMembers, inputText)
      return
    }
  } else {
    // 既に紐づいているLINEから氏名が送られても上書きしない
    const sameName = staffMembers.find((s) => normalizePersonName(s.name) === normalizePersonName(inputText))
    if (sameName) {
      await sendLineMessage(
        replyToken,
        source.userId,
        sameName.id === linked.id
          ? `${linked.name}さんとして登録済みです。\n領収書の写真を送るか、下のメニューから申請してください。`
          : `このLINEは${linked.name}さんとして登録されています。\nお名前の変更は、メニューの「設定」から申請してください。`
      )
      return
    }
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
      "下のメニューの「申請する」から申請できます。\n\n" +
      "📎 領収書はこのトークに写真を送るだけで登録できます。"
  )
}

/* ========== 氏名登録・初回設定・設定メニュー・申請履歴・定期券（フェーズ1） ========== */

type ServiceClient = ReturnType<typeof createServiceClient>

/** 未登録のLINEからメニュー操作が来たときの案内 */
const NOT_REGISTERED_TEXT =
  "まだお名前が登録されていません。\n" + "お名前をフルネームで送信してください。\n（例：南 ひふ子 ／ 南ひふ子）\n※姓と名の間のスペースは、あってもなくても大丈夫です"

/** 友だち追加（follow）→ 初回オンボーディング */
async function handleFollow(event: LineEvent): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const staffMembers = await fetchStaffMembers(supabase)
  const linked = staffMembers?.find((s) => s.line_user_id === source.userId)
  if (linked) {
    // ブロック解除などで再度友だち追加された場合（既に紐づいている）
    await sendLineMessage(
      replyToken,
      source.userId,
      `おかえりなさい。${linked.name}さんとして登録されています。\n下のメニューからいつでも申請できます。`
    )
    return
  }
  await sendLineMessage(replyToken, source.userId, FOLLOW_TEXT)
}

/**
 * 未登録のLINEから届いたテキストを氏名として照合する。
 *
 * **候補は一切提示しない。** 複数の候補を出すと申請者に他のスタッフの氏名が見えてしまうため、
 * フルネームの完全一致だけを本人と判定する（スペースの有無・全角半角は問わない）。
 * 一致しなければ担当への確認を案内する（勝手に新規スタッフを作らない）。
 */
async function handleNameRegistrationText(event: LineEvent, staffMembers: StaffRow[], inputText: string): Promise<void> {
  const { replyToken, source } = event
  const matches = matchStaffByFullName(staffMembers, inputText)

  if (matches.length === 1) {
    const c = matches[0]
    await sendFlexCard(
      replyToken,
      source.userId,
      nameConfirmCard({ name: c.name, okData: `action=nmok&sid=${c.id}`, retryData: "action=nmre" }),
      `${c.name}さんとして登録します。よろしいですか？`
    )
    return
  }

  if (matches.length === 0) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "お名前を確認できませんでした。\n" +
        "姓と名の両方を続けて送ってください。\n\n" +
        "（例）南 ひふ子\n" +
        "※姓と名の間のスペースは、あってもなくても大丈夫です\n\n" +
        "何度か試してもうまくいかない場合は、担当にご連絡ください。"
    )
    return
  }

  // 同姓同名が複数登録されている場合。氏名だけでは本人を特定できないが、
  // 候補を出すと他のスタッフの氏名が見えてしまうため、担当に引き取ってもらう。
  await sendLineMessage(
    replyToken,
    source.userId,
    "恐れ入りますが、お名前の確認が必要です。\n担当にご連絡ください。"
  )
  const adminId = process.env.ADMIN_LINE_USER_ID
  if (adminId) {
    await pushMessage(
      adminId,
      `⚠️ 氏名の照合ができませんでした（同姓同名が複数登録されています）\n` +
        `入力：${inputText.slice(0, 20)}\n` +
        `/mkadmin の「LINEスタッフ管理」で、区別できる氏名に修正してください。`
    )
  }
}

/** 候補から選択 → 確認カード */
async function handleNamePickPostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const sid = params.get("sid")
  const supabase = createServiceClient()
  const staffMembers = await fetchStaffMembers(supabase)
  const target = staffMembers?.find((s) => s.id === sid)
  if (!target) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 選択を認識できませんでした。お名前をもう一度送信してください。")
    return
  }
  await sendFlexCard(
    replyToken,
    source.userId,
    nameConfirmCard({ name: target.name, okData: `action=nmok&sid=${target.id}`, retryData: "action=nmre" }),
    `${target.name}さんとして登録します。よろしいですか？`
  )
}

/**
 * 氏名の確認OK → このLINEとスタッフを紐づける。
 * - このLINEが既に別のスタッフに紐づいていれば上書きしない。
 * - 対象スタッフが別のLINEに紐づいていれば紐づけない（担当へ確認）。
 * - 紐づけは line_user_id が空の行に限って更新する（同時操作での取り違えを防ぐ）。
 */
async function handleNameConfirmPostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const sid = params.get("sid")
  const supabase = createServiceClient()
  const staffMembers = await fetchStaffMembers(supabase)
  if (!staffMembers || !sid) {
    await sendLineMessage(replyToken, source.userId, "⚠️ システムエラーが発生しました。もう一度お試しください。")
    return
  }
  const me = staffMembers.find((s) => s.line_user_id === source.userId)
  if (me && me.id !== sid) {
    await sendLineMessage(
      replyToken,
      source.userId,
      `このLINEは${me.name}さんとして登録されています。\nお名前の変更は、メニューの「設定」から申請してください。`
    )
    return
  }
  const target = staffMembers.find((s) => s.id === sid)
  if (!target) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 対象のお名前が見つかりませんでした。担当に確認してください。")
    return
  }
  const takenByOther = "このお名前は別のLINEアカウントで登録済みです。\n担当に確認してください。"
  if (target.line_user_id && target.line_user_id !== source.userId) {
    await sendLineMessage(replyToken, source.userId, takenByOther)
    return
  }
  if (!target.line_user_id) {
    const { data: updated, error } = await supabase
      .from("staff_members")
      .update({ line_user_id: source.userId })
      .eq("id", target.id)
      .is("line_user_id", null)
      .select("id")
    if (error) {
      console.error("line_user_id更新エラー:", error)
      await sendLineMessage(replyToken, source.userId, "⚠️ 登録に失敗しました。もう一度お試しください。")
      return
    }
    if (!updated || updated.length === 0) {
      await sendLineMessage(replyToken, source.userId, takenByOther)
      return
    }
    console.log(`line_user_id登録: ${target.name} = ${source.userId}`)
    // 担当に知らせる。氏名を知っていれば他人でも先に登録できてしまうため、
    // 「身に覚えのない登録」にその場で気づけるようにする。
    const adminId = process.env.ADMIN_LINE_USER_ID
    if (adminId) {
      await pushMessage(
        adminId,
        "【LINE登録のお知らせ】\n" +
          `${target.name}さんがLINEの登録を完了しました。\n\n` +
          "身に覚えのない登録の場合は、管理画面の「スタッフ」タブで\n" +
          "そのスタッフの行を確認してください。"
      ).catch(() => {})
    }
  }
  // DB更新が反映されるまでの保険（30分）
  staffNameCache.set(source.userId, { staffId: target.id, staffName: target.name, expiresAt: Date.now() + CACHE_TTL_MS })
  await updateLineProfile(supabase, target.id, { name_confirmed_at: new Date().toISOString() })

  const state = await loadStaffLineState(supabase, target.id)
  if (state && !isSetupComplete(state)) {
    // 続けて最寄り駅（＋定期券）の登録へ誘導する
    await setTransitSession(supabase, source.userId, target.id, "setup_offer", { setupFlow: true, resume: { kind: "none" } })
    await sendLineMessages(replyToken, source.userId, [
      textWithQuickReply(`✅ ${target.name}さんとして登録しました。\n\n続けて、自宅の最寄り駅を登録しますか？`, [
        flexPostback("登録する", "action=sup&s=start", "登録する"),
        flexPostback("あとで", "action=sup&s=later", "あとで"),
      ]),
    ])
    return
  }
  await sendLineMessage(replyToken, source.userId, `✅ ${target.name}さんとして登録しました。\n\n${ONBOARDING_DONE_TEXT}`)
}

/** 申請開始時の共通処理の結果 */
interface ApplicationGate {
  /** false なら初回設定を挟んだため、呼び出し側は何もしない（設定完了後に resume で戻る） */
  proceed: boolean
  /** 久しぶりの申請に添える一言（空文字可） */
  greeting: string
}

/**
 * 申請を始めるときの共通処理（【3】全員に1回だけ設定を通す／【4】3か月以上空いたら一言添える）。
 * 列（migration 041）が未適用の環境では何もしない（従来動作）。
 */
async function beginApplication(
  event: LineEvent,
  supabase: ServiceClient,
  staffId: string,
  resume: ResumeAction
): Promise<ApplicationGate> {
  const state = await loadStaffLineState(supabase, staffId)
  if (!state || !state.available) return { proceed: true, greeting: "" }

  // 一時休止中（産休・育休・休職など）は申請を受け付けない。
  // 退職と違い在籍したままなので、再開すればそのまま使える。
  if (isSuspended(state.profile)) {
    const reason = suspendReason(state.profile)
    await sendLineMessage(
      event.replyToken,
      event.source.userId,
      "現在、経費申請のご利用を停止しています。\n" +
        (reason ? `（${reason}）\n` : "") +
        "\n再開のご希望は、メニューの「問い合わせ」から担当にご連絡ください。\n" +
        "これまでの申請記録は残っていますので、再開後はそのままお使いいただけます。"
    )
    return { proceed: false, greeting: "" }
  }

  if (!isSetupComplete(state)) {
    await continueSetup(
      event,
      supabase,
      staffId,
      { setupFlow: true, resume },
      "最初に1回だけ、登録内容の確認をお願いします（1分で終わります）。\n終わったら、そのまま申請に戻ります。"
    )
    return { proceed: false, greeting: "" }
  }
  const greeting = isLongAbsence(state.profile)
    ? "久しぶりの申請ですね。写真を送っていただければ、あとは選ぶだけです。\n\n"
    : ""
  await updateLineProfile(supabase, staffId, { last_applied_at: new Date().toISOString() })
  return { proceed: true, greeting }
}

/**
 * 初回設定の次のステップへ進める（氏名確認 → 最寄り駅 → 定期券 → 完了）。
 * 各ステップは状態から判定するので、どこから呼んでも未完了の最初のステップを出す。
 * @param lead 先頭に添えるテキスト（直前の操作の完了報告など）
 */
async function continueSetup(
  event: LineEvent,
  supabase: ServiceClient,
  staffId: string,
  data: TransitData,
  lead?: string
): Promise<void> {
  const { replyToken, source } = event
  const state = await loadStaffLineState(supabase, staffId)
  if (!state) {
    await sendLineMessage(replyToken, source.userId, "⚠️ システムエラーが発生しました。管理者にご連絡ください。")
    return
  }
  const pre: unknown[] = lead ? [{ type: "text", text: lead }] : []
  const flowData: TransitData = { setupFlow: true, resume: data.resume, stationReviewed: data.stationReviewed }

  // 1. 氏名の確認
  if (!state.profile.name_confirmed_at) {
    await setTransitSession(supabase, source.userId, staffId, "setup_name", flowData)
    await sendLineMessages(replyToken, source.userId, [
      ...pre,
      nameReviewCard({ name: state.name, okData: "action=sup&s=name_ok", changeData: "action=sup&s=name_req" }),
    ])
    return
  }

  // 2. 最寄り駅（登録済みなら確認、未登録なら登録）
  if (!flowData.stationReviewed) {
    if (state.homeStation) {
      await setTransitSession(supabase, source.userId, staffId, "setup_station", flowData)
      await sendLineMessages(replyToken, source.userId, [
        ...pre,
        stationReviewCard({
          station: stationWithPref(state.homeStation, state.homeStationPref),
          okData: "action=sup&s=st_ok",
          changeData: "action=sup&s=st_change",
        }),
      ])
      return
    }
    await setTransitSession(supabase, source.userId, staffId, "home_input", flowData)
    await sendLineMessages(replyToken, source.userId, [
      ...pre,
      textWithQuickReply(
        "🏠 自宅の最寄り駅を登録します。\n最寄り駅の名前を送信してください。（例：南草津駅）\n電車代の計算の出発駅に使います。",
        [homeCancelItem()]
      ),
    ])
    return
  }

  // 3. 通勤手段（未回答なら聞く）
  if (isCommuteMethodUnanswered(state.profile)) {
    await askCommuteMethod(event, supabase, staffId, flowData, state, pre)
    return
  }

  // 4. 定期券（通勤手段が電車・その他で、かつ未回答なら聞く）
  //    車・自転車・徒歩の方は通勤手段の回答時に「定期券なし」で確定済みなので聞かない
  if (mayHaveCommuterPass(state.profile.commute_method ?? "other") && isCommuterPassUnanswered(state.profile)) {
    await askPass(event, supabase, staffId, flowData, state, pre)
    return
  }

  // 5. 完了 → 本来の申請に戻る
  await updateLineProfile(supabase, staffId, {
    setup_completed_at: new Date().toISOString(),
    last_applied_at: new Date().toISOString(),
  })
  await clearTransitSession(supabase, source.userId)
  await resumeAfterSetup(event, supabase, staffId, data.resume, (lead ? `${lead}\n\n` : "") + "✅ 設定が完了しました。次回からは聞きません。\n\n")
}

/** 初回設定の完了後、元の申請に戻る（追加のプッシュ送信はせず、返信1回にまとめる） */
async function resumeAfterSetup(
  event: LineEvent,
  supabase: ServiceClient,
  staffId: string,
  resume: ResumeAction | undefined,
  lead: string
): Promise<void> {
  const { replyToken, source } = event
  const kind = resume?.kind ?? "none"
  if (kind === "none") {
    await sendLineMessage(replyToken, source.userId, lead + ONBOARDING_DONE_TEXT)
    return
  }
  if (resume?.kind === "receipt") {
    await sendReceiptCard(event, supabase, resume.rid, lead.trim())
    return
  }
  if (kind === "menu") {
    await sendApplicationMenu(replyToken, source.userId, lead)
    return
  }
  const staffMembers = await fetchStaffMembers(supabase)
  if (!staffMembers) {
    await sendLineMessage(replyToken, source.userId, lead + "下のメニューからもう一度申請してください。")
    return
  }
  if (kind === "train") await startTrainTransit(event, supabase, staffMembers, lead)
  else if (kind === "other") await startOtherTransit(event, supabase, staffMembers, lead)
  else await handleTransitEntry(event, supabase, staffMembers, lead)
}

/** 初回設定のボタン操作（action=sup&s=...） */
async function handleSetupPostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const step = params.get("s")

  // 氏名登録直後の「登録する／あとで」はセッション切れでも受け付ける（紐づけから本人を特定）
  if (step === "start" || step === "later") {
    const staffMembers = await fetchStaffMembers(supabase)
    const staff = staffMembers ? resolveStaffForUser(staffMembers, source.userId) : null
    if (!staff) {
      await sendLineMessage(replyToken, source.userId, NOT_REGISTERED_TEXT)
      return
    }
    if (step === "later") {
      await clearTransitSession(supabase, source.userId)
      await sendLineMessage(
        replyToken,
        source.userId,
        "承知しました。次に申請するときに、最寄り駅と定期券の登録をお願いします。\n下のメニューからいつでも申請できます。"
      )
      return
    }
    await continueSetup(event, supabase, staff.id, { setupFlow: true, resume: { kind: "none" } })
    return
  }

  const session = await getTransitSession(supabase, source.userId)
  if (!session?.staffMemberId || !session.step.startsWith("setup_")) {
    await sendLineMessage(replyToken, source.userId, SESSION_EXPIRED_TEXT)
    return
  }
  const staffId = session.staffMemberId
  switch (step) {
    case "name_ok":
      await updateLineProfile(supabase, staffId, { name_confirmed_at: new Date().toISOString() })
      await continueSetup(event, supabase, staffId, session.data)
      return
    case "name_req": {
      await requestNameChange(supabase, staffId)
      await updateLineProfile(supabase, staffId, { name_confirmed_at: new Date().toISOString() })
      await continueSetup(
        event,
        supabase,
        staffId,
        session.data,
        "担当にお名前の変更を依頼しました。変更されるまでは今のお名前のまま申請できます。"
      )
      return
    }
    case "st_ok":
      await continueSetup(event, supabase, staffId, { ...session.data, stationReviewed: true })
      return
    case "st_change":
      await startHomeStationChange(event, supabase, staffId, { setupFlow: true, resume: session.data.resume })
      return
    default:
      await continueSetup(event, supabase, staffId, session.data)
  }
}

/** 初回設定中のテキスト（ボタンで選んでもらうため、現在のステップを出し直す） */
async function handleSetupText(
  event: LineEvent,
  supabase: ServiceClient,
  session: TransitSession,
  inputText: string
): Promise<void> {
  const { replyToken, source } = event
  if (/^(キャンセル|中止|やめる|やめます|終了|あとで)$/.test(inputText)) {
    await clearTransitSession(supabase, source.userId)
    await sendLineMessage(replyToken, source.userId, "設定を中断しました。次に申請するときにもう一度確認します。")
    return
  }
  if (!session.staffMemberId) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  await continueSetup(event, supabase, session.staffMemberId, session.data, "下のボタンから選んでください。")
}

/**
 * 氏名の変更を申請する（本人は直接書き換えられない。担当が /mkadmin で変更する）。
 * 申請は line_profile に記録し、担当へLINEで通知する（テストスタッフは通知しない＝既存の方針どおり）。
 */
async function requestNameChange(supabase: ServiceClient, staffId: string): Promise<void> {
  const state = await loadStaffLineState(supabase, staffId)
  if (!state) return
  if (state.available) {
    const requests = [...(state.profile.name_change_requests ?? []), { requested_at: new Date().toISOString() }]
    await updateLineProfile(supabase, staffId, { name_change_requests: requests.slice(-10) })
  }
  const adminId = process.env.ADMIN_LINE_USER_ID
  if (adminId && !state.isTest) {
    await pushMessage(
      adminId,
      `📝 ${state.name}さんからお名前の変更依頼がありました。\n/mkadmin の「LINEスタッフ管理」で変更してください（LINEの紐づけ・過去の申請はそのまま残ります）。`
    )
  }
}

/* ---------- 設定メニュー ---------- */

/** 「設定」→ 現在の登録内容を先に表示し、変更ボタンを出す */
async function sendSettings(event: LineEvent, supabase: ServiceClient, staffId: string): Promise<void> {
  const { replyToken, source } = event
  const state = await loadStaffLineState(supabase, staffId)
  if (!state) {
    await sendLineMessage(replyToken, source.userId, "⚠️ システムエラーが発生しました。管理者にご連絡ください。")
    return
  }
  const home = stationWithPref(state.homeStation, state.homeStationPref)
  if (!state.available) {
    // 列（migration 041）未適用：定期券は扱えないため最寄り駅だけ案内する
    await sendLineMessages(replyToken, source.userId, [
      textWithQuickReply(`⚙️ 設定\n現在の登録\n　お名前：${state.name}\n　最寄り駅：${home}`, [
        flexPostback("最寄り駅を変更", "action=stg&k=hs", "最寄り駅を変更"),
        flexPostback("お名前の変更を申請", "action=stg&k=nm", "お名前の変更を申請"),
      ]),
    ])
    return
  }
  const passLabel = commuterPassLabel(state.profile)
  await sendFlexCard(
    replyToken,
    source.userId,
    settingsCard({
      name: state.name,
      homeStation: home,
      commuteMethod: commuteMethodLabel(state.profile),
      commuterPass: passLabel,
      stationData: "action=stg&k=hs",
      commuteData: "action=stg&k=cm",
      passData: "action=stg&k=cp",
      nameData: "action=stg&k=nm",
      academy: academyLabel(state.profile),
      academyData: "action=stg&k=ac",
      pendingNameChange: hasPendingNameChange(state.profile),
      // 車・自転車・徒歩の方には定期券の行とボタンを出さない（関係がなく迷うため）
      showPass: mayHaveCommuterPass(state.profile.commute_method ?? "other"),
    }),
    `⚙️ 設定\n現在の登録\n　お名前：${state.name}\n　最寄り駅：${home}\n　通勤手段：${commuteMethodLabel(state.profile)}\n　定期券：${passLabel}`
  )
}

/** 設定メニューのボタン（action=stg&k=hs|cp|nm） */
async function handleSettingsPostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const staffMembers = await fetchStaffMembers(supabase)
  const staff = staffMembers ? resolveStaffForUser(staffMembers, source.userId) : null
  if (!staff) {
    await sendLineMessage(replyToken, source.userId, NOT_REGISTERED_TEXT)
    return
  }
  switch (params.get("k")) {
    case "hs":
      await startHomeStationChange(event, supabase, staff.id, {})
      return
    case "cm": {
      const state = await loadStaffLineState(supabase, staff.id)
      if (!state?.available) {
        await sendLineMessage(replyToken, source.userId, "通勤手段の登録は準備中です。担当にお知らせください。")
        return
      }
      await askCommuteMethod(event, supabase, staff.id, {}, state)
      return
    }
    case "ac": {
      // アカデミー会員のサービス開始日。本人が登録するのは1回だけ。
      // 登録後の変更は担当が行う（支給額の判定に使う日付のため、本人が後から
      // 書き換えられると期限切れの申請を通せてしまう）。
      const state = await loadStaffLineState(supabase, staff.id)
      const already = state ? academyStartDate(state.profile) : null
      if (already) {
        const end = academyTermEnd(already)
        await sendLineMessage(
          replyToken,
          source.userId,
          "アカデミー会員は登録済みです。\n\n" +
            `　サービス開始日：${jpDate(already)}\n` +
            (end ? `　再受講の期限：${jpDate(end)}\n` : "") +
            "\n内容が違う場合は、メニューの「問い合わせ」から担当にご連絡ください。\n" +
            "担当が確認して修正します。"
        )
        return
      }
      const ok = await setTransitSession(supabase, source.userId, staff.id, "academy_start", {})
      if (!ok) {
        await sendLineMessage(replyToken, source.userId, "⚠️ 処理中にエラーが発生しました。もう一度お試しください。")
        return
      }
      await sendLineMessage(replyToken, source.userId, ACADEMY_START_PROMPT)
      return
    }
    case "cp": {
      const state = await loadStaffLineState(supabase, staff.id)
      if (!state?.available) {
        await sendLineMessage(replyToken, source.userId, "定期券の登録は準備中です。担当にお知らせください。")
        return
      }
      await askPass(event, supabase, staff.id, {}, state)
      return
    }
    case "nm":
      await requestNameChange(supabase, staff.id)
      await sendLineMessage(
        replyToken,
        source.userId,
        "担当にお名前の変更を依頼しました。\n変更されるまでは今のお名前のまま申請できます（これまでの申請はそのまま引き継がれます）。"
      )
      return
    default:
      await sendSettings(event, supabase, staff.id)
  }
}

/* ---------- アカデミー会員（再受講は3年で6回） ---------- */

/**
 * アカデミー会員の表示（設定カード）。
 * 例「2025年12月1日 ～ 2028年11月30日」。未登録なら「未登録」。
 */
function academyLabel(profile: unknown): string {
  const start = academyStartDate(profile)
  if (!start) return "未登録"
  const end = academyTermEnd(start)
  return end ? `${jpDate(start)} ～ ${jpDate(end)}` : jpDate(start)
}

/** YYYY-MM-DD を「2025年12月1日」にする */
function jpDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`
}

const ACADEMY_START_PROMPT =
  "アチーブメントアカデミーの\n【サービス開始日】を送ってください。\n\n" +
  "（例）2025-12-01 ／ 2025年12月1日 ／ 2025/12/1\n\n" +
  "会費を支払って会員になった日です。\n" +
  "入会のご案内や会員証に書かれている日付をご確認ください。\n\n" +
  "※再受講は開始日から3年間です。\n" +
  "　例：2025年12月1日に開始 → 2028年11月30日まで"

/** 「この内容で登録」→ サービス開始日を保存する */
async function handleAcademyConfirmPostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const date = params.get("d")
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 処理できませんでした。もう一度お試しください。")
    return
  }
  const supabase = createServiceClient()
  const staffMembers = await fetchStaffMembers(supabase)
  const staff = staffMembers ? resolveStaffForUser(staffMembers, source.userId) : null
  if (!staff) {
    await sendLineMessage(replyToken, source.userId, NOT_REGISTERED_TEXT)
    return
  }

  // 二重登録の防止（確認カードを2回押した場合など）
  const state = await loadStaffLineState(supabase, staff.id)
  if (state && academyStartDate(state.profile)) {
    await sendLineMessage(replyToken, source.userId, "すでに登録済みです。変更は担当にご連絡ください。")
    return
  }

  await updateLineProfile(supabase, staff.id, {
    academy: { start_date: date, updated_at: new Date().toISOString(), updated_by: "self" },
  })
  await clearTransitSession(supabase, source.userId)

  const end = academyTermEnd(date)
  await sendLineMessage(
    replyToken,
    source.userId,
    "アカデミー会員の登録が完了しました。\n\n" +
      `　サービス開始日：${jpDate(date)}\n` +
      (end ? `　再受講の期限：${jpDate(end)}\n` : "") +
      "\n受講料を申請すると、初回か再受講かを自動で判定します。\n" +
      "期限を過ぎたあとの申請は、担当が確認してからの確定になります。\n\n" +
      "内容が違う場合は「問い合わせ」から担当にご連絡ください。"
  )
}

/* ---------- 申請履歴 ---------- */

/** 「申請履歴」→ 自分の直近5件をカードで返す */
async function sendHistory(event: LineEvent, supabase: ServiceClient, staffId: string): Promise<void> {
  const { replyToken, source } = event
  const { data: staffRow } = await supabase.from("staff_members").select("name").eq("id", staffId).single()
  const staffName = (staffRow as { name?: string } | null)?.name || ""

  const { data: rows, error } = await supabase
    .from("staff_receipts")
    .select("id, store_name, amount, created_at, ai_raw")
    .eq("staff_member_id", staffId)
    .order("created_at", { ascending: false })
    .limit(5)
  if (error) {
    console.error("[LINE Bot] 申請履歴の取得エラー:", error)
    await sendLineMessage(replyToken, source.userId, "⚠️ 申請履歴を取得できませんでした。")
    return
  }
  const receipts = (rows ?? []) as {
    id: string
    store_name: string | null
    amount: number | null
    created_at: string
    ai_raw: unknown
  }[]
  const ids = receipts.map((r) => r.id)
  const txByReceipt = new Map<string, { amount: number; subsidy_category: string | null; expense_detail: string | null }>()
  if (ids.length > 0) {
    const { data: txs } = await supabase
      .from("petty_cash_transactions")
      .select("staff_receipt_id, amount, subsidy_category, expense_detail")
      .in("staff_receipt_id", ids)
    for (const t of (txs ?? []) as {
      staff_receipt_id: string | null
      amount: number
      subsidy_category: string | null
      expense_detail: string | null
    }[]) {
      if (t.staff_receipt_id) txByReceipt.set(t.staff_receipt_id, t)
    }
  }

  // 現在の締め月（これより前の月は提出済みとみなし、末尾の案内には含めない）
  const today = toJstDateString(new Date())
  const currentMonth = resolveStaffSubmissionMonth(null, today).month
  const upcomingMonths = new Set<string>()

  const items: HistoryItem[] = receipts.map((r) => {
    const raw = parseAiRawObject(r.ai_raw) ?? {}
    const tx = txByReceipt.get(r.id)
    // 状態は後から増やせるよう STATUS_BADGES のキーで表す（承認・差戻などはフェーズ2で追加）
    const status: HistoryItem["status"] = raw.cancelled_at ? "cancelled" : tx ? "registered" : "category_pending"
    const createdJst = toJstDateString(new Date(r.created_at))
    if (status === "registered") {
      const m = resolveStaffSubmissionMonth(r.ai_raw, createdJst).month
      if (m && currentMonth && m.year * 12 + m.month >= currentMonth.year * 12 + currentMonth.month) {
        upcomingMonths.add(labelYearMonth(m))
      }
    }
    const amount = tx?.amount ?? r.amount
    return {
      date: `${Number(createdJst.slice(5, 7))}/${Number(createdJst.slice(8, 10))}`,
      status,
      store: (r.store_name || "不明").slice(0, 40),
      category: tx?.expense_detail || (status === "category_pending" ? "区分を選ぶ前の領収書" : "—"),
      amount,
      subsidy: tx ? calcSubsidy(tx.amount, tx.subsidy_category) : null,
    }
  })
  const footer =
    upcomingMonths.size > 0 ? `登録済みの分は ${[...upcomingMonths].map((m) => `${m}分`).join("・")} として提出されます。` : null

  const card = historyCard({ staffFamilyName: familyName(staffName), items, footer })
  const fallback =
    `📋 ${familyName(staffName)}さんの申請（直近${items.length}件）\n` +
    items
      .map((i) => `${i.date} ${i.store} ¥${formatAmount(i.amount)}${i.subsidy != null ? ` → 支給 ¥${formatAmount(i.subsidy)}` : ""}`)
      .join("\n") +
    (footer ? `\n\n${footer}` : "")
  await sendFlexCard(replyToken, source.userId, card, fallback)
}

/* ---------- 領収書の読み取り結果カード ---------- */

/** 区分の第1階層（クイックリプライ） */
function tier1Actions(receiptId: string): ActionDef[] {
  return (["ach", "other"] as const).map((g) =>
    flexPostback(EXPENSE_GROUP_LABELS[g], `action=t1&rid=${receiptId}&g=${g}`, EXPENSE_GROUP_LABELS[g])
  )
}

/** ③ 領収書の読み取り結果カード＋区分選択（クイックリプライ）を送る */
async function sendReceiptCard(event: LineEvent, supabase: ServiceClient, receiptId: string, lead = ""): Promise<void> {
  const { replyToken, source } = event
  const fetched = await fetchReceiptWithSiblings(supabase, receiptId)
  if (!fetched) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 対象の領収書が見つかりませんでした。もう一度写真を送ってください。")
    return
  }
  const { receipt, siblings } = fetched
  const items =
    siblings.length >= 2
      ? siblings.map((s) => ({ store: s.store_name || "不明", amount: s.amount, date: s.date }))
      : [{ store: receipt.store_name || "不明", amount: receipt.amount, date: receipt.date }]
  const card = receiptReceivedCard({
    items,
    staffFamilyName: familyName(receipt.staffName),
    categoryActions: tier1Actions(receiptId),
  })
  const fallback =
    `📸 領収書を${items.length}件 受け取りました。\n` +
    items.map((i) => `${i.store} ¥${formatAmount(i.amount)}（${i.date || "日付不明"}）`).join("\n") +
    `\n${familyName(receipt.staffName)}さんとして申請します。\n\n何の費用ですか？\n下のボタンから選んでください。`
  await sendFlexCard(replyToken, source.userId, card, fallback, lead || undefined)
}

/* ---------- 定期券の登録・変更 ---------- */

/** 定期券フロー用のキャンセル */
function passCancelAction(): ActionDef {
  return flexPostback("キャンセル", "action=cpx", "キャンセル")
}

/**
 * 通勤手段を聞く。
 *
 * 定期券の有無を直接聞くより、通勤手段から入ったほうがスタッフの実感に合う。
 * 車・自転車・徒歩を選んだ方には定期券をいっさい聞かない（質問が1つ減る）。
 */
async function askCommuteMethod(
  event: LineEvent,
  supabase: ServiceClient,
  staffId: string,
  data: TransitData,
  state: StaffLineState,
  pre: unknown[] = []
): Promise<void> {
  const { replyToken, source } = event
  await setTransitSession(supabase, source.userId, staffId, "pass_cm", {
    setupFlow: data.setupFlow,
    resume: data.resume,
    stationReviewed: data.stationReviewed,
  })
  const current = state.profile.commute_method
    ? `現在の登録：${commuteMethodLabel(state.profile)}\n\n`
    : ""
  await sendLineMessages(replyToken, source.userId, [
    ...pre,
    textWithQuickReply(
      current +
        "🚶 普段の通勤手段を選んでください。\n\n" +
        "電車代の計算に使います。通勤手段が変わったら、設定からすぐに変更してください。",
      [
        flexPostback("電車", "action=cm&v=train", "電車"),
        flexPostback("車", "action=cm&v=car", "車"),
        flexPostback("自転車・徒歩", "action=cm&v=bicycle_walk", "自転車・徒歩"),
        flexPostback("その他", "action=cm&v=other", "その他"),
        passCancelAction(),
      ]
    ),
  ])
}

/** 通勤手段の回答 */
async function handleCommuteMethodPostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const session = await getPassSession(event, supabase)
  if (!session?.staffMemberId) return
  const staffId = session.staffMemberId

  const raw = params.get("v")
  const valid: CommuteMethod[] = ["train", "car", "bicycle_walk", "other"]
  const method = valid.find((v) => v === raw)
  if (!method) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 選択を読み取れませんでした。もう一度お試しください。")
    return
  }

  const now = new Date().toISOString()
  // 定期券を持ちえない手段なら、定期券を「なし」で確定して質問を省く
  const patch = mayHaveCommuterPass(method)
    ? { commute_method: method, commute_method_updated_at: now }
    : {
        commute_method: method,
        commute_method_updated_at: now,
        commuter_pass: { has: false, updated_at: now },
      }

  const ok = await updateLineProfile(supabase, staffId, patch)
  if (!ok) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 登録に失敗しました。もう一度お試しください。")
    return
  }

  const label = COMMUTE_METHOD_TEXT[method]
  if (session.data.setupFlow) {
    await continueSetup(event, supabase, staffId, session.data, `🚶 通勤手段を「${label}」で登録しました。`)
    return
  }

  // 設定メニューからの変更。電車・その他なら続けて定期券を聞く
  if (mayHaveCommuterPass(method)) {
    const state = await loadStaffLineState(supabase, staffId)
    if (!state) {
      await sendLineMessage(replyToken, source.userId, "⚠️ システムエラーが発生しました。担当にご連絡ください。")
      return
    }
    await askPass(event, supabase, staffId, carryPassFlags(session.data), state, [
      { type: "text", text: `🚶 通勤手段を「${label}」で登録しました。` },
    ])
    return
  }

  await clearTransitSession(supabase, source.userId)
  await sendLineMessage(
    replyToken,
    source.userId,
    `🚶 通勤手段を「${label}」で登録しました。\n定期券は「なし」として扱います。\n電車代は自宅の最寄り駅からの運賃で計算します。`
  )
}

/** 通勤手段の表示名（メッセージ本文用） */
const COMMUTE_METHOD_TEXT: Record<CommuteMethod, string> = {
  train: "電車",
  car: "車",
  bicycle_walk: "自転車・徒歩",
  other: "その他",
}

/** 定期券の有無を聞く */
async function askPass(
  event: LineEvent,
  supabase: ServiceClient,
  staffId: string,
  data: TransitData,
  state: StaffLineState,
  pre: unknown[] = []
): Promise<void> {
  const { replyToken, source } = event
  await setTransitSession(supabase, source.userId, staffId, "pass_ask", {
    setupFlow: data.setupFlow,
    resume: data.resume,
    stationReviewed: data.stationReviewed,
  })
  const current = state.profile.commuter_pass ? `現在の登録：${commuterPassLabel(state.profile)}\n\n` : ""
  await sendLineMessages(replyToken, source.userId, [
    ...pre,
    textWithQuickReply(
      current +
        "🎫 通勤の定期券をお持ちですか？\n\n" +
        "定期券の区間は、すでに定期代が支給されているため、電車代の支給の対象外になります。そのため区間を登録していただいています。",
      [
        flexPostback("定期券あり", "action=cp&v=1", "定期券あり"),
        flexPostback("定期券なし", "action=cp&v=0", "定期券なし"),
        passCancelAction(),
      ]
    ),
  ])
}

/** 定期券フローのセッションを取り出す（無ければ失効案内） */
async function getPassSession(event: LineEvent, supabase: ServiceClient): Promise<TransitSession | null> {
  const session = await getTransitSession(supabase, event.source.userId)
  if (!session?.staffMemberId || !session.step.startsWith("pass_")) {
    await sendLineMessage(event.replyToken, event.source.userId, SESSION_EXPIRED_TEXT)
    return null
  }
  return session
}

/** 定期券フローの共通の引き継ぎ（初回設定の途中かどうか等） */
function carryPassFlags(data: TransitData): TransitData {
  return { setupFlow: data.setupFlow, resume: data.resume, stationReviewed: data.stationReviewed }
}

/** 定期券あり／なし */
async function handlePassAnswerPostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const session = await getPassSession(event, supabase)
  if (!session?.staffMemberId) return
  const staffId = session.staffMemberId

  if (params.get("v") === "0") {
    const ok = await updateLineProfile(supabase, staffId, {
      commuter_pass: { has: false, updated_at: new Date().toISOString() },
    })
    if (!ok) {
      await sendLineMessage(replyToken, source.userId, "⚠️ 登録に失敗しました。もう一度お試しください。")
      return
    }
    if (session.data.setupFlow) {
      await continueSetup(event, supabase, staffId, session.data, "🎫 定期券「なし」で登録しました。")
      return
    }
    await clearTransitSession(supabase, source.userId)
    await sendLineMessage(
      replyToken,
      source.userId,
      "🎫 定期券「なし」で登録しました。\n電車代は自宅の最寄り駅からの運賃で計算します。"
    )
    return
  }

  await setTransitSession(supabase, source.userId, staffId, "pass_from", carryPassFlags(session.data))
  await sendLineMessages(replyToken, source.userId, [
    textWithQuickReply(
      "🎫 定期券の区間を、駅を1つずつ伺います。\nまず、区間の片方の端の駅名を送信してください。（例：南草津）",
      [passCancelAction()]
    ),
  ])
}

/** 定期券フロー中のテキスト（駅名の入力） */
async function handlePassText(
  event: LineEvent,
  supabase: ServiceClient,
  session: TransitSession,
  inputText: string
): Promise<void> {
  const { replyToken, source } = event
  if (/^(キャンセル|中止|やめる|やめます|終了)$/.test(inputText)) {
    await clearTransitSession(supabase, source.userId)
    await sendLineMessage(replyToken, source.userId, "✋ 定期券の登録を中止しました。")
    return
  }
  const staffId = session.staffMemberId
  if (!staffId) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  const step = session.step
  if (step === "pass_ask" || step === "pass_confirm") {
    await sendLineMessage(replyToken, source.userId, "下のボタンから選んでください。")
    return
  }
  const which: "from" | "to" = step === "pass_from" || step === "pass_from_pick" ? "from" : "to"
  const judge = await judgeStation(inputText)
  const cands = judge.candidates.slice(0, 4)
  if (cands.length >= 2) {
    await setTransitSession(supabase, source.userId, staffId, which === "from" ? "pass_from_pick" : "pass_to_pick", {
      ...session.data,
      passCandidates: cands,
    })
    const actions: ActionDef[] = cands.map((c, i) =>
      flexPostback(`${c.pref}の${c.station}`, `action=cppick&n=${i}`, `${c.pref}の${c.station}`)
    )
    actions.push(passCancelAction())
    await sendLineMessages(replyToken, source.userId, [
      textWithQuickReply("🚉 候補が複数あります。該当する駅を選んでください。\n（無ければ県名を付けて送り直してください）", actions),
    ])
    return
  }
  const pick =
    judge.station && judge.pref
      ? { station: judge.station, pref: judge.pref }
      : cands.length === 1
        ? { station: cands[0].station, pref: cands[0].pref }
        : null
  if (!pick) {
    await sendLineMessages(replyToken, source.userId, [
      textWithQuickReply("🚉 駅を特定できませんでした。県名を付けてもう一度送信してください。\n例：滋賀県 南草津", [
        passCancelAction(),
      ]),
    ])
    return
  }
  await applyPassStation(event, supabase, staffId, session.data, which, pick)
}

/** 候補から選択 */
async function handlePassPickPostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const supabase = createServiceClient()
  const session = await getPassSession(event, supabase)
  if (!session?.staffMemberId) return
  const which = session.step === "pass_to_pick" || session.step === "pass_to" ? "to" : "from"
  const n = Number(params.get("n"))
  const c = Number.isInteger(n) ? session.data.passCandidates?.[n] : undefined
  if (!c) {
    await sendLineMessage(event.replyToken, event.source.userId, "⚠️ 選択を認識できませんでした。駅名をもう一度送信してください。")
    return
  }
  await applyPassStation(event, supabase, session.staffMemberId, session.data, which, { station: c.station, pref: c.pref })
}

/** 区間の駅を1つ確定し、次へ進める */
async function applyPassStation(
  event: LineEvent,
  supabase: ServiceClient,
  staffId: string,
  data: TransitData,
  which: "from" | "to",
  pick: { station: string; pref: string }
): Promise<void> {
  const { replyToken, source } = event
  const station = { station: toStationName(pick.station), pref: pick.pref }
  if (which === "from") {
    await setTransitSession(supabase, source.userId, staffId, "pass_to", {
      ...carryPassFlags(data),
      passFrom: station,
    })
    await sendLineMessages(replyToken, source.userId, [
      textWithQuickReply(
        `🎫 1つ目：${station.station}（${station.pref}）\n\nもう片方の端の駅名を送信してください。（例：京都）`,
        [passCancelAction()]
      ),
    ])
    return
  }
  if (data.passFrom && toStationName(data.passFrom.station) === station.station) {
    await sendLineMessages(replyToken, source.userId, [
      textWithQuickReply("1つ目と同じ駅です。もう片方の端の駅名を送信してください。", [passCancelAction()]),
    ])
    return
  }
  const next: TransitData = { ...carryPassFlags(data), passFrom: data.passFrom, passTo: station }
  await setTransitSession(supabase, source.userId, staffId, "pass_confirm", next)
  const state = await loadStaffLineState(supabase, staffId)
  const before =
    state?.profile.commuter_pass?.has && state.profile.commuter_pass.from
      ? `${commuterPassLabel(state.profile)} → `
      : ""
  const a = stripStationSuffix(data.passFrom?.station || "")
  const b = stripStationSuffix(station.station)
  await sendLineMessages(replyToken, source.userId, [
    textWithQuickReply(`🎫 ${before}定期券：${a} ⇄ ${b} で登録します。\nよろしいですか？`, [
      flexPostback("登録する", "action=cpok", "登録する"),
      flexPostback("入力し直す", "action=cpre", "入力し直す"),
      passCancelAction(),
    ]),
  ])
}

/** 定期券区間の確定 → 保存 */
async function handlePassConfirmPostback(event: LineEvent): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const session = await getPassSession(event, supabase)
  if (!session?.staffMemberId) return
  const { passFrom, passTo } = session.data
  if (!passFrom || !passTo) {
    await setTransitSession(supabase, source.userId, session.staffMemberId, "pass_from", carryPassFlags(session.data))
    await sendLineMessage(replyToken, source.userId, "⚠️ 区間が揃っていません。片方の端の駅名から送り直してください。")
    return
  }
  const ok = await updateLineProfile(supabase, session.staffMemberId, {
    commuter_pass: {
      has: true,
      from: passFrom.station,
      from_pref: passFrom.pref,
      to: passTo.station,
      to_pref: passTo.pref,
      updated_at: new Date().toISOString(),
    },
  })
  if (!ok) {
    await sendLineMessage(replyToken, source.userId, "⚠️ 登録に失敗しました。もう一度お試しください。")
    return
  }
  const label = `${stripStationSuffix(passFrom.station)} ⇄ ${stripStationSuffix(passTo.station)}`
  if (session.data.setupFlow) {
    await continueSetup(event, supabase, session.staffMemberId, session.data, `✅ 定期券を「${label}」で登録しました。`)
    return
  }
  await clearTransitSession(supabase, source.userId)
  await sendLineMessage(
    replyToken,
    source.userId,
    `✅ 定期券を「${label}」で登録しました。\n電車代の申請のときに、定期券の区間を通るかを確認します。`
  )
}

/** 入力し直す */
async function handlePassRetryPostback(event: LineEvent): Promise<void> {
  const supabase = createServiceClient()
  const session = await getPassSession(event, supabase)
  if (!session?.staffMemberId) return
  await setTransitSession(supabase, event.source.userId, session.staffMemberId, "pass_from", carryPassFlags(session.data))
  await sendLineMessages(event.replyToken, event.source.userId, [
    textWithQuickReply("区間の片方の端の駅名を送信してください。（例：南草津）", [passCancelAction()]),
  ])
}

/** 定期券の登録を中止 */
async function handlePassCancelPostback(event: LineEvent): Promise<void> {
  const supabase = createServiceClient()
  const session = await getTransitSession(supabase, event.source.userId)
  await clearTransitSession(supabase, event.source.userId)
  await sendLineMessage(
    event.replyToken,
    event.source.userId,
    session?.data.setupFlow
      ? "✋ 定期券の登録を中止しました。次に申請するときにもう一度確認します。"
      : "✋ 定期券の登録を中止しました。"
  )
}

/* ---------- 電車代：定期券区間の控除 ---------- */

/** 到着駅の県が決まった後：定期券ありなら「定期券区間を通るか」を1問だけ挟む */
async function afterArrivalPref(
  supabase: ServiceClient,
  event: LineEvent,
  staffId: string,
  data: TransitData
): Promise<void> {
  const { replyToken, source } = event
  const state = await loadStaffLineState(supabase, staffId)
  const pass = state ? activeCommuterPass(state.profile) : null
  if (!pass) {
    // 定期券なし（または未登録）のスタッフには何も聞かない
    await setTransitSession(supabase, source.userId, staffId, "train_shinkansen", data)
    await askShinkansen(replyToken, source.userId)
    return
  }
  await setTransitSession(supabase, source.userId, staffId, "train_pass", data)
  await sendTrainPassQuestion(replyToken, source.userId, pass.from, pass.to)
}

/** 「定期券の区間を通りますか？」（テキスト＋クイックリプライ） */
async function sendTrainPassQuestion(replyToken: string, userId: string, from: string, to: string): Promise<void> {
  await sendLineMessages(replyToken, userId, [
    textWithQuickReply(
      "定期券の区間を通りますか？\n" +
        `お持ちの定期券：${stripStationSuffix(from)} ⇄ ${stripStationSuffix(to)}\n\n` +
        "定期券の区間はすでに定期代が支給されているため、支給の対象外になります。",
      [
        flexPostback("定期券区間を通る", "action=trpass&v=1", "定期券区間を通る"),
        flexPostback("通らない", "action=trpass&v=0", "通らない"),
        flexPostback("✖ キャンセル", "action=trx", "✖ キャンセル"),
      ]
    ),
  ])
}

/** 定期券区間を出る駅（区間の端）を本人に選んでもらう */
async function askPassExit(replyToken: string, userId: string, from: string, to: string, lead = ""): Promise<void> {
  await sendLineMessages(replyToken, userId, [
    textWithQuickReply(lead + "定期券の区間を出る駅（目的地に近い方の端）を選んでください。", [
      flexPostback(stripStationSuffix(from), "action=trpass&v=end&e=from", stripStationSuffix(from)),
      flexPostback(stripStationSuffix(to), "action=trpass&v=end&e=to", stripStationSuffix(to)),
      flexPostback("✖ キャンセル", "action=trx", "✖ キャンセル"),
    ]),
  ])
}

/** 定期券区間の選択（action=trpass&v=1|0|out|end&e=from|to） */
async function handleTrainPassPostback(event: LineEvent, params: URLSearchParams): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const session = await getTransitSession(supabase, source.userId)
  if (!session?.staffMemberId || session.step !== "train_pass") {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  const staffId = session.staffMemberId
  const data = session.data
  const v = params.get("v")

  if (v === "0") {
    // 通らない → 自宅最寄り駅から全額
    await setTransitSession(supabase, source.userId, staffId, "train_shinkansen", { ...data, passDeducted: false })
    await askShinkansen(replyToken, source.userId)
    return
  }

  const state = await loadStaffLineState(supabase, staffId)
  const pass = state ? activeCommuterPass(state.profile) : null
  if (!pass) {
    await setTransitSession(supabase, source.userId, staffId, "train_shinkansen", data)
    await askShinkansen(replyToken, source.userId)
    return
  }

  const applyEnd = async (end: { station: string; pref: string }) => {
    const next: TransitData = {
      ...data,
      fromStation: toStationName(end.station),
      fromPref: end.pref,
      passDeducted: true,
      passSegment: { from: pass.from, to: pass.to },
    }
    await setTransitSession(supabase, source.userId, staffId, "train_shinkansen", next)
    await askShinkansen(
      replyToken,
      source.userId,
      `🎫 定期券区間の端の ${toStationName(end.station)} を出発駅として計算します。\n\n`
    )
  }

  if (v === "end") {
    const e = params.get("e") === "to" ? "to" : "from"
    await applyEnd(e === "from" ? { station: pass.from, pref: pass.from_pref || "" } : { station: pass.to, pref: pass.to_pref || "" })
    return
  }
  if (v === "out") {
    // 「区間の外です」→ 端の駅を本人に選んでもらう
    await askPassExit(replyToken, source.userId, pass.from, pass.to)
    return
  }

  // 通る → 区間内か／どちらの端から出るかを判定（ロジックは lib/commuter-pass-deduction.ts に集約）
  const decision = await decidePassDeparture(
    { from: pass.from, fromPref: pass.from_pref, to: pass.to, toPref: pass.to_pref },
    { station: toStationName(data.toStation || ""), pref: data.toPref || "" }
  )
  if (decision.kind === "inside") {
    // 目的地が定期券区間内 → 支給なし（カードは出さずテキストで終える。判定違いは「区間の外です」で覆せる）
    await sendLineMessages(replyToken, source.userId, [
      textWithQuickReply("目的地が定期券の区間内のため、支給はありません。", [
        flexPostback("区間の外です", "action=trpass&v=out", "区間の外です"),
        flexPostback("閉じる", "action=trx", "閉じる"),
      ]),
    ])
    return
  }
  if (decision.kind === "unknown") {
    await askPassExit(replyToken, source.userId, pass.from, pass.to, "自動で判定できませんでした。\n")
    return
  }
  await applyEnd({ station: decision.station, pref: decision.pref })
}

/** 定期券区間の質問中のテキスト（ボタンで選んでもらう） */
async function handleTrainPassText(
  event: LineEvent,
  supabase: ServiceClient,
  session: TransitSession,
  inputText: string
): Promise<void> {
  const { replyToken, source } = event
  if (/^(キャンセル|中止|やめる|やめます|終了)$/.test(inputText)) {
    await clearTransitSession(supabase, source.userId)
    await sendLineMessage(replyToken, source.userId, "✋ 交通費の申請を中止しました。")
    return
  }
  const state = session.staffMemberId ? await loadStaffLineState(supabase, session.staffMemberId) : null
  const pass = state ? activeCommuterPass(state.profile) : null
  if (!pass) {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  await sendTrainPassQuestion(replyToken, source.userId, pass.from, pass.to)
}

/** ⑧ 電車代の確認カード（推定できたときのみ） */
async function sendTrainConfirmCard(
  replyToken: string,
  userId: string,
  data: TransitData,
  oneWay: number,
  total: number,
  legs: { label: string; amount: number }[] | undefined,
  fallbackText: string
): Promise<void> {
  const card = trainConfirmCard({
    fromStation: toStationName(data.fromStation || ""),
    fromIsPassEnd: !!data.passDeducted,
    toStation: toStationName(data.toStation || ""),
    shinkansenLegs: legs,
    oneWay,
    trip: data.trip === "round" ? "round" : "one",
    total,
    passNote: data.passDeducted && data.passSegment ? passDeductionNote(data.passSegment) : undefined,
    estimateNote: "運賃は自動計算です。実際と違う場合は「修正する」を押してください。",
    okData: "action=trok",
    fixData: "action=trfix",
  })
  const passLine =
    data.passDeducted && data.passSegment ? `\n${passDeductionNote(data.passSegment)}` : ""
  await sendFlexCard(replyToken, userId, card, fallbackText + passLine)
}

/** 電車代の「修正する」→ 正しい金額の入力を促す（金額を送れば上書きして確定） */
async function handleTransitFixPostback(event: LineEvent): Promise<void> {
  const { replyToken, source } = event
  const supabase = createServiceClient()
  const session = await getTransitSession(supabase, source.userId)
  if (!session?.staffMemberId || session.step !== "train_confirm") {
    await sendTransitExpired(replyToken, source.userId)
    return
  }
  await sendLineQuickReply(
    replyToken,
    source.userId,
    `正しい金額（${session.data.trip === "round" ? "往復の合計" : "片道"}）を数字で送ってください。\n例：1480`,
    [transitCancelItem()]
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

  // 初回設定が未完了なら1回だけ挟み、完了後にこの領収書の区分選択へ戻る
  const gate = await beginApplication(event, supabase, staffId, { kind: "receipt", rid: insertedIds[0] })
  if (!gate.proceed) return
  await sendReceiptCard(event, supabase, insertedIds[0], gate.greeting)
  console.log("[LINE Bot] 複数件の区分質問（カード）送信完了")
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
    // 「その他」の内容は代表の領収書に保存されているため、兄弟（同一ファイルの複数領収証）にも写す。
    // こうしないと2件目以降の摘要に内容が入らず、会計士さん側で何の支出か分からなくなる。
    const first = siblings[0]
    const { data: firstRow } = first
      ? await supabase.from("staff_receipts").select("ai_raw").eq("id", first.id).maybeSingle()
      : { data: null }
    const sharedPurpose = readExpensePurpose((firstRow as { ai_raw?: unknown } | null)?.ai_raw)
    if (sharedPurpose) {
      for (const sib of siblings.slice(1)) {
        await saveExpensePurpose(supabase, sib.id, sharedPurpose)
      }
    }

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

  await sendLineMessages(replyToken, source.userId, [
    registeredMessage(
      submissionMonthLabel(null, siblings[0].created_at),
      `${siblings.length}件（合計 ¥${formatAmount(totalAmount)}／支給額 ¥${formatAmount(totalSubsidy)}）を`
    ),
  ])

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

  // スタッフの解決: line_user_id の紐づけ（DB）→ 30分キャッシュ（DB更新に失敗した場合の保険）。
  // LINEの表示名による部分一致は、同姓のスタッフを取り違えるため使わない。
  const matchedStaff = resolveStaffForUser(staffMembers as StaffRow[], source.userId) ?? undefined
  if (!matchedStaff) {
    await sendLineMessage(
      replyToken,
      source.userId,
      "まだお名前が登録されていません。\n" +
        "お名前をフルネームで送信してください。\n（例：南 ひふ子 ／ 南ひふ子）\n※姓と名の間のスペースは、あってもなくても大丈夫です\n\n" +
        "登録が終わったら、もう一度写真を送ってください。"
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
        `✅ 解析しました\n${storeName} ¥${amountStr}（${dateStr}）\nDropboxに保存しました。\n⚠️ 金額が読み取れなかったため、担当が手動で登録します。`
      )
      console.log("[LINE Bot] 処理完了（金額未読のためボタンなし）")
      return
    }

    // 初回設定が未完了なら1回だけ挟み、完了後にこの領収書の区分選択へ戻る
    const gate = await beginApplication(event, supabase, matchedStaff.id, { kind: "receipt", rid: receiptId })
    if (!gate.proceed) return
    // 読み取り結果のカード＋区分選択（クイックリプライ）
    await sendReceiptCard(event, supabase, receiptId, gate.greeting)
    console.log("[LINE Bot] 区分質問（カード）送信完了")
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
