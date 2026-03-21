import { NextRequest, NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { uploadFile } from "@/lib/dropbox"
import { analyzeDocument } from "@/lib/gemini"
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

/**
 * スタッフ領収書用のDropboxパスを生成する
 * /経理書類/スタッフ領収書/{スタッフ名}/{YYYY年MM月}/{ファイル名}
 */
function getStaffReceiptPath(
  staffName: string,
  date: Date,
  originalFileName: string
): string {
  const year = `${date.getFullYear()}年`
  const month = `${String(date.getMonth() + 1).padStart(2, "0")}月`
  const safeName = staffName.replace(/[/\\:*?"<>|]/g, "_")

  return `/経理書類/スタッフ領収書/${safeName}/${year}${month}/${originalFileName}`
}

/** 金額をフォーマット（3桁区切り） */
function formatAmount(amount: number | null): string {
  if (amount === null || amount === undefined) return "不明"
  return amount.toLocaleString("ja-JP")
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
  staffMembers: { id: string; name: string }[],
  searchName: string
): { id: string; name: string } | undefined {
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
  if (event.type !== "message") return

  const messageType = event.message?.type
  if (messageType === "image") {
    await handleImageMessage(event)
  } else if (messageType === "text") {
    await handleTextMessage(event)
  }
}

/** テキストメッセージ処理: スタッフ名の照合・登録 */
async function handleTextMessage(event: LineEvent): Promise<void> {
  const { replyToken, source, message } = event
  const inputText = message?.text?.trim()
  if (!inputText) return

  const supabase = createServiceClient()
  const { data: staffMembers, error: staffError } = await supabase
    .from("staff_members")
    .select("id, name")

  if (staffError || !staffMembers) {
    console.error("staff_members取得エラー:", staffError)
    await sendLineMessage(replyToken, source.userId, "⚠️ システムエラーが発生しました。管理者にご連絡ください。")
    return
  }

  const matched = findStaffByName(staffMembers, inputText)

  if (matched) {
    // キャッシュにスタッフ名を保存
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
  } else {
    const nameList = getStaffNameList(staffMembers)
    await sendLineMessage(
      replyToken,
      source.userId,
      `⚠️ スタッフ名が見つかりません\n登録名：${nameList}`
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
    .select("id, name")

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

    // 5. Gemini AI解析
    console.log("[LINE Bot] Gemini AI解析開始")
    const base64Data = imageBuffer.toString("base64")
    const mimeType = "image/jpeg" // LINEの画像はJPEG
    const ocrResult = await analyzeDocument(base64Data, mimeType)
    console.log(`[LINE Bot] Gemini AI解析完了: vendor=${ocrResult.vendor_name}, amount=${ocrResult.amount}`)

    // 6. Dropboxに保存
    console.log("[LINE Bot] Dropboxアップロード開始")
    const dateObj = ocrResult.issue_date ? new Date(ocrResult.issue_date) : new Date()
    const timestamp = Date.now().toString().slice(-6)
    const fileName = `${matchedStaff.name}_LINE_${timestamp}.jpg`
    const dropboxPath = getStaffReceiptPath(matchedStaff.name, dateObj, fileName)

    const resultPath = await uploadFile(dropboxPath, imageBuffer)
    console.log(`[LINE Bot] Dropboxアップロード完了: ${resultPath}`)

    // 7. staff_receiptsに保存
    console.log("[LINE Bot] DB保存開始")
    const docType = ocrResult.type || "領収書"
    const { error: insertError } = await supabase
      .from("staff_receipts")
      .insert({
        staff_member_id: matchedStaff.id,
        file_name: fileName,
        dropbox_path: resultPath,
        document_type: docType,
        date: ocrResult.issue_date || new Date().toISOString().split("T")[0],
        amount: ocrResult.amount,
        store_name: ocrResult.vendor_name || null,
        tax_category: ocrResult.tax_category || null,
        account_title: ocrResult.account_title || null,
        ai_raw: JSON.parse(JSON.stringify(ocrResult)) as Json,
      })

    if (insertError) {
      console.error("staff_receipts挿入エラー:", insertError)
      await sendLineMessage(replyToken, source.userId, "⚠️ データベースへの保存に失敗しました。管理者にご連絡ください。")
      return
    }
    console.log("[LINE Bot] DB保存完了")

    // 8. 完了メッセージをLINEに返信
    const storeName = ocrResult.vendor_name || "不明"
    const amountStr = formatAmount(ocrResult.amount)
    const dateStr = ocrResult.issue_date || "日付不明"

    await sendLineMessage(
      replyToken,
      source.userId,
      `✅ 登録完了！\n${storeName} ¥${amountStr}\n${dateStr}\nDropboxに保存しました`
    )
    console.log("[LINE Bot] 処理完了")
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
