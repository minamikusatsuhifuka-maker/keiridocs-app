import { NextRequest, NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { uploadFile } from "@/lib/dropbox"
import { analyzeDocument } from "@/lib/gemini"
import type { Database } from "@/types/database"
import type { Json } from "@/types/database"
import crypto from "crypto"

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
    contentProvider?: {
      type: string
    }
  }
}

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

/** LINE返信メッセージ送信 */
async function replyMessage(replyToken: string, text: string): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) return

  await fetch("https://api.line.me/v2/bot/message/reply", {
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

/** イベント振り分け */
async function handleEvent(event: LineEvent): Promise<void> {
  if (event.type !== "message") return

  const messageType = event.message?.type
  if (messageType === "image") {
    await handleImageMessage(event)
  } else if (messageType === "text") {
    await replyMessage(event.replyToken, "📎 領収書の写真を送ってください")
  }
}

/** 画像メッセージ処理: Gemini解析 → Dropbox保存 → DB保存 → LINE返信 */
async function handleImageMessage(event: LineEvent): Promise<void> {
  const { replyToken, source, message } = event
  if (!message?.id) return

  // 1. LINEユーザーのdisplayNameを取得
  const profile = await getLineUserProfile(source.userId)
  if (!profile) {
    await replyMessage(replyToken, "⚠️ プロフィール情報を取得できませんでした。")
    return
  }

  const displayName = profile.displayName

  // 2. staff_membersテーブルから名前で部分一致検索
  const supabase = createServiceClient()
  const { data: staffMembers, error: staffError } = await supabase
    .from("staff_members")
    .select("id, name")

  if (staffError) {
    console.error("staff_members取得エラー:", staffError)
    await replyMessage(replyToken, "⚠️ システムエラーが発生しました。管理者にご連絡ください。")
    return
  }

  // displayNameに含まれるスタッフ名、またはスタッフ名に含まれるdisplayNameで検索
  const matchedStaff = (staffMembers || []).find(
    (s) => displayName.includes(s.name) || s.name.includes(displayName)
  )

  if (!matchedStaff) {
    await replyMessage(
      replyToken,
      "⚠️ スタッフ名が登録されていません。\n管理者にご連絡ください。"
    )
    return
  }

  // 3. LINEから画像バイナリを取得
  const imageBuffer = await getLineMessageContent(message.id)
  if (!imageBuffer || imageBuffer.length === 0) {
    await replyMessage(replyToken, "⚠️ 画像の取得に失敗しました。もう一度送ってください。")
    return
  }

  // 4. Gemini AI解析
  const base64Data = imageBuffer.toString("base64")
  const mimeType = "image/jpeg" // LINEの画像はJPEG
  const ocrResult = await analyzeDocument(base64Data, mimeType)

  // 5. Dropboxに保存
  const dateObj = ocrResult.issue_date ? new Date(ocrResult.issue_date) : new Date()
  const timestamp = Date.now().toString().slice(-6)
  const fileName = `${matchedStaff.name}_LINE_${timestamp}.jpg`
  const dropboxPath = getStaffReceiptPath(matchedStaff.name, dateObj, fileName)

  const resultPath = await uploadFile(dropboxPath, imageBuffer)

  // 6. staff_receiptsに保存
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
    await replyMessage(replyToken, "⚠️ データベースへの保存に失敗しました。管理者にご連絡ください。")
    return
  }

  // 7. 完了メッセージをLINEに返信
  const storeName = ocrResult.vendor_name || "不明"
  const amountStr = formatAmount(ocrResult.amount)
  const dateStr = ocrResult.issue_date || "日付不明"

  await replyMessage(
    replyToken,
    `✅ 登録完了！\n${storeName} ¥${amountStr}\n${dateStr}\nDropboxに保存しました`
  )
}
