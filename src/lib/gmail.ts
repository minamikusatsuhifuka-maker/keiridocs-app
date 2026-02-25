// Gmail API ラッパー
import { google } from "googleapis"

/** メール添付ファイルの型 */
export interface MailAttachment {
  fileName: string
  mimeType: string
  base64Data: string
  size: number
}

/** 取得したメール情報の型 */
export interface FetchedMail {
  messageId: string
  sender: string
  senderEmail: string
  subject: string
  receivedAt: string
  attachments: MailAttachment[]
}

/** 許可されたMIMEタイプ */
const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
]

/** 1回の取込で処理する最大件数 */
const MAX_FETCH_COUNT = 20

/**
 * Gmail OAuth2クライアントを取得する
 */
function getOAuth2Client() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  )
  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
  })
  return oauth2Client
}

/**
 * 未読かつ添付付きメールを検索し、許可送信元リストでフィルタする
 * @param allowedEmails 許可された送信元メールアドレスの配列
 * @returns 取得したメール情報の配列
 */
export async function fetchUnreadMailsWithAttachments(
  allowedEmails: string[]
): Promise<FetchedMail[]> {
  const auth = getOAuth2Client()
  const gmail = google.gmail({ version: "v1", auth })

  // 未読かつ添付付きメールを検索
  const query = "is:unread has:attachment"
  const listResponse = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: MAX_FETCH_COUNT,
  })

  const messageIds = listResponse.data.messages ?? []
  if (messageIds.length === 0) {
    return []
  }

  const results: FetchedMail[] = []

  for (const msg of messageIds) {
    if (!msg.id) continue

    // メール詳細を取得
    const detail = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
    })

    const headers = detail.data.payload?.headers ?? []
    const fromHeader = headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? ""
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? ""
    const dateHeader = headers.find((h) => h.name?.toLowerCase() === "date")?.value ?? ""

    // 送信元メールアドレスを抽出
    const senderEmail = extractEmail(fromHeader)
    const senderName = extractName(fromHeader)

    // 許可送信元リストと照合
    if (!allowedEmails.some((e) => e.toLowerCase() === senderEmail.toLowerCase())) {
      continue
    }

    // 添付ファイルを取得（PDF/画像のみ）
    const attachments = await extractAttachments(gmail, msg.id, detail.data.payload)
    if (attachments.length === 0) {
      continue
    }

    // メールを既読にする
    await gmail.users.messages.modify({
      userId: "me",
      id: msg.id,
      requestBody: {
        removeLabelIds: ["UNREAD"],
      },
    })

    results.push({
      messageId: msg.id,
      sender: senderName || senderEmail,
      senderEmail,
      subject,
      receivedAt: dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString(),
      attachments,
    })
  }

  return results
}

/**
 * メールのパートから添付ファイルを再帰的に抽出する
 */
async function extractAttachments(
  gmail: ReturnType<typeof google.gmail>,
  messageId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any
): Promise<MailAttachment[]> {
  const attachments: MailAttachment[] = []

  if (!payload) return attachments

  const parts = payload.parts ?? [payload]

  for (const part of parts) {
    // ネストされたパートを再帰的に処理
    if (part.parts) {
      const nested = await extractAttachments(gmail, messageId, part)
      attachments.push(...nested)
      continue
    }

    const mimeType = part.mimeType ?? ""
    const fileName = part.filename ?? ""
    const attachmentId = part.body?.attachmentId

    // 添付ファイルでないパートはスキップ
    if (!fileName || !attachmentId) continue

    // 許可されたMIMEタイプか確認
    if (!ALLOWED_MIME_TYPES.includes(mimeType.toLowerCase())) continue

    // 添付ファイルのデータを取得
    const attachmentResponse = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: attachmentId,
    })

    const base64Data = attachmentResponse.data.data ?? ""
    // Gmail APIはURL-safeなbase64を返すので通常のbase64に変換
    const standardBase64 = base64Data.replace(/-/g, "+").replace(/_/g, "/")
    const size = attachmentResponse.data.size ?? 0

    attachments.push({
      fileName,
      mimeType,
      base64Data: standardBase64,
      size,
    })
  }

  return attachments
}

/**
 * Fromヘッダーからメールアドレスを抽出する
 * 例: "田中太郎 <tanaka@example.com>" → "tanaka@example.com"
 */
function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/)
  return match ? match[1] : from.trim()
}

/**
 * Fromヘッダーから表示名を抽出する
 * 例: "田中太郎 <tanaka@example.com>" → "田中太郎"
 */
function extractName(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</)
  return match ? match[1].trim() : ""
}
