import { NextRequest, NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { uploadFile } from "@/lib/dropbox"
import { analyzeDocument, DEFAULT_GEMINI_MODEL } from "@/lib/gemini"
import { settleStaffReceipt } from "@/lib/staff-refund-core"
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
 * /経理書類/スタッフ領収書/{スタッフ名}/{申請日YYYY-MM-DD}/{ファイル名}
 * @param applicationDate 申請日（アップロード日）の YYYY-MM-DD 文字列（JST）
 */
function getStaffReceiptPath(
  staffName: string,
  applicationDate: string,
  originalFileName: string
): string {
  const safeName = staffName.replace(/[/\\:*?"<>|]/g, "_")
  return `/経理書類/スタッフ領収書/${safeName}/${applicationDate}/${originalFileName}`
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
  }
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

  const details = expenseDetailsByGroup(group)
  const items: PostbackAction[] = details.map((d) => ({
    type: "postback",
    label: d.buttonLabel,
    data: `action=t2&rid=${receiptId}&d=${d.key}`,
    displayText: d.buttonLabel,
  }))

  // アチーブメント関連は補足（再受講・他コース）を本文に記載（ボタンラベルは20文字制限のため）
  const text =
    group === "ach"
      ? "アチーブメント関連のどれですか？\n\n・初回ATC＋アカデミー会員費\n・セミナー2回目以降（ATC再受講、ATC以外のコース）"
      : "種類を選んでください。"

  await sendLineQuickReply(replyToken, source.userId, text, items)
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

  try {
    const supabase = createServiceClient()
    const { data: receipt, error } = await supabase
      .from("staff_receipts")
      .select("amount, store_name, created_at, staff_members!inner(name)")
      .eq("id", receiptId)
      .single()

    if (error || !receipt) {
      await sendLineMessage(replyToken, source.userId, "⚠️ 対象の領収書が見つかりませんでした。")
      return
    }

    const r = receipt as unknown as {
      amount: number | null
      store_name: string | null
      created_at: string
      staff_members: { name: string }
    }
    const amount = r.amount

    // 金額が読み取れない場合は確認に進めず手動精算を案内（誤精算防止）
    if (!amount || amount <= 0) {
      await sendLineMessage(
        replyToken,
        source.userId,
        "⚠️ 金額が読み取れていないため精算できません。経理側で手動登録してください。"
      )
      return
    }

    const staffName = r.staff_members.name
    const storeName = r.store_name || "不明"
    // 支給額（セミナー2回目以降のみ半額・端数切り捨て、他は全額）
    const subsidy = calcSubsidy(amount, detail.subsidyCategory)
    const isHalf = detail.subsidyCategory === "achievement_repeat"
    // 申請日 = アップロード日（領収書の登録日）をJSTで表示
    const applicationDate = toJstDateString(new Date(r.created_at))

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

  try {
    const result = await settleStaffReceipt({
      staffReceiptId: receiptId,
      settlementMethod: "payroll", // LINEからは常に給与支給に一本化
      subsidyCategory: detail.subsidyCategory, // 支給率（achievement_repeat=半額 / other=全額）
      expenseDetail: detail.fullLabel, // 6種類の詳細区分フル名称
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

        await sendLineMessage(
          replyToken,
          source.userId,
          "✅ 登録しました。給与支給で処理されます。\nお疲れさまでした！"
        )

        // 院長へpush通知（ADMIN_LINE_USER_ID未設定ならスキップ）
        const adminId = process.env.ADMIN_LINE_USER_ID
        if (adminId) {
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
  const { data: staffMembers, error: staffError } = await supabase
    .from("staff_members")
    .select("id, name, line_user_id")

  if (staffError || !staffMembers) {
    console.error("staff_members取得エラー:", staffError)
    await sendLineMessage(replyToken, source.userId, "⚠️ システムエラーが発生しました。管理者にご連絡ください。")
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

  // d. その他 → ガイドメッセージ
  await sendLineMessage(
    replyToken,
    source.userId,
    "📎 領収書の写真を送るか、質問をどうぞ\n\n💡 例:\n・領収書の写真を送信 → 自動登録\n・「受付の手順は？」→ マニュアル検索\n・「田中さんの連絡先」→ 名刺検索\n・スタッフ名を送信 → 名前登録"
  )
}

/** 画像メッセージ処理: Gemini解析 → Dropbox保存 → DB保存 → LINE返信 */
async function handleImageMessage(event: LineEvent): Promise<void> {
  const { replyToken, source, message } = event
  if (!message?.id) return

  const supabase = createServiceClient()
  const { data: staffMembers, error: staffError } = await supabase
    .from("staff_members")
    .select("id, name, line_user_id")

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

    // 5. Gemini AI解析
    console.log("[LINE Bot] Gemini AI解析開始")
    const base64Data = imageBuffer.toString("base64")
    const mimeType = "image/jpeg" // LINEの画像はJPEG
    const ocrResult = await analyzeDocument(base64Data, mimeType)
    console.log(`[LINE Bot] Gemini AI解析完了: vendor=${ocrResult.vendor_name}, amount=${ocrResult.amount}`)

    // 5.5 内容（店名+金額+日付）で重複チェック（同一スタッフ内。別画像での再申請をブロック）
    const receiptDate = ocrResult.issue_date || new Date().toISOString().split("T")[0]
    const contentDup = await findContentDuplicate(supabase, {
      staffMemberId: matchedStaff.id,
      storeName: ocrResult.vendor_name || null,
      amount: ocrResult.amount,
      date: receiptDate,
    })
    if (contentDup) {
      console.log("[LINE Bot] 内容重複を検知 → 登録中止")
      await sendLineMessage(replyToken, source.userId, buildDuplicateWarning(contentDup))
      return
    }

    // 6. Dropboxに保存（申請日＝アップロード日のフォルダ。JSTで日付を確定）
    console.log("[LINE Bot] Dropboxアップロード開始")
    const applicationDate = toJstDateString(new Date()) // 申請日（YYYY-MM-DD・JST）
    const timestamp = Date.now().toString().slice(-6)
    const fileName = `${matchedStaff.name}_LINE_${timestamp}.jpg`
    const dropboxPath = getStaffReceiptPath(matchedStaff.name, applicationDate, fileName)

    const resultPath = await uploadFile(dropboxPath, imageBuffer)
    console.log(`[LINE Bot] Dropboxアップロード完了: ${resultPath}`)

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
