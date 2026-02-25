// メール送信（Resend）
import { Resend } from "resend"

// APIキーが未設定の場合はインスタンスを作成しない（ビルド時のエラー回避）
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null

// 送信元アドレス（Resendで認証済みのドメインを使用）
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "経理書類管理 <noreply@resend.dev>"

/** 共通のHTMLメールラッパー */
function wrapHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
</head>
<body style="margin:0;padding:0;font-family:'Helvetica Neue',Arial,'Hiragino Kaku Gothic ProN',sans-serif;background-color:#f4f4f5;color:#18181b;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
<tr><td style="background-color:#18181b;padding:24px 32px;">
<h1 style="margin:0;color:#ffffff;font-size:18px;font-weight:600;">経理書類管理</h1>
</td></tr>
<tr><td style="padding:32px;">
${body}
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #e4e4e7;text-align:center;">
<p style="margin:0;font-size:12px;color:#a1a1aa;">このメールは経理書類管理システムから自動送信されています。</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}

/** 金額をカンマ区切りでフォーマット */
function formatAmount(amount: number | null): string {
  if (amount === null) return "-"
  return `¥${amount.toLocaleString()}`
}

// ====================================================
// 支払期限アラートメール
// ====================================================

export interface DueDateAlertItem {
  vendor_name: string
  type: string
  amount: number | null
  due_date: string
}

/** 支払期限アラートメールのHTML */
function buildDueDateAlertHtml(items: DueDateAlertItem[]): string {
  const rows = items
    .map(
      (item) => `
<tr>
  <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;">${item.vendor_name}</td>
  <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;">${item.type}</td>
  <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;text-align:right;">${formatAmount(item.amount)}</td>
  <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;">${item.due_date}</td>
</tr>`
    )
    .join("")

  const body = `
<h2 style="margin:0 0 16px;font-size:16px;color:#18181b;">支払期限が近い書類があります</h2>
<p style="margin:0 0 16px;font-size:14px;color:#71717a;">以下の書類の支払期限が3日以内に迫っています。ご確認ください。</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e4e7;border-radius:4px;border-collapse:collapse;font-size:14px;">
<thead>
<tr style="background-color:#f4f4f5;">
  <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #e4e4e7;">取引先</th>
  <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #e4e4e7;">種別</th>
  <th style="padding:8px 12px;text-align:right;border-bottom:1px solid #e4e4e7;">金額</th>
  <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #e4e4e7;">期限</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
<p style="margin:16px 0 0;font-size:14px;color:#71717a;">合計 ${items.length} 件</p>`

  return body
}

/** 支払期限アラートメールを送信 */
export async function sendDueDateAlert(
  to: string[],
  items: DueDateAlertItem[]
): Promise<{ success: boolean; error?: string }> {
  if (items.length === 0) return { success: true }
  if (!resend) return { success: false, error: "RESEND_API_KEY が設定されていません" }

  const html = wrapHtml(
    "支払期限アラート",
    buildDueDateAlertHtml(items)
  )

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: `【経理書類管理】支払期限アラート（${items.length}件）`,
      html,
    })
    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : "メール送信に失敗しました"
    return { success: false, error: message }
  }
}

// ====================================================
// 月末まとめメール
// ====================================================

export interface MonthSummaryData {
  year: number
  month: number
  totalCount: number
  totalAmount: number
  pendingCount: number
  processedCount: number
  typeBreakdown: { type: string; count: number; amount: number }[]
}

/** 月末まとめメールのHTML */
function buildMonthSummaryHtml(data: MonthSummaryData): string {
  const typeRows = data.typeBreakdown
    .map(
      (item) => `
<tr>
  <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;">${item.type}</td>
  <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;text-align:right;">${item.count}件</td>
  <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;text-align:right;">${formatAmount(item.amount)}</td>
</tr>`
    )
    .join("")

  const body = `
<h2 style="margin:0 0 16px;font-size:16px;color:#18181b;">${data.year}年${data.month}月の書類まとめ</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;font-size:14px;">
<tr>
  <td style="padding:12px;background-color:#f4f4f5;border-radius:4px;text-align:center;width:25%;">
    <div style="font-size:24px;font-weight:700;color:#18181b;">${data.totalCount}</div>
    <div style="font-size:12px;color:#71717a;margin-top:4px;">登録数</div>
  </td>
  <td style="width:8px;"></td>
  <td style="padding:12px;background-color:#f4f4f5;border-radius:4px;text-align:center;width:25%;">
    <div style="font-size:24px;font-weight:700;color:#18181b;">${formatAmount(data.totalAmount)}</div>
    <div style="font-size:12px;color:#71717a;margin-top:4px;">合計金額</div>
  </td>
  <td style="width:8px;"></td>
  <td style="padding:12px;background-color:#fef2f2;border-radius:4px;text-align:center;width:25%;">
    <div style="font-size:24px;font-weight:700;color:#dc2626;">${data.pendingCount}</div>
    <div style="font-size:12px;color:#71717a;margin-top:4px;">未処理</div>
  </td>
  <td style="width:8px;"></td>
  <td style="padding:12px;background-color:#f0fdf4;border-radius:4px;text-align:center;width:25%;">
    <div style="font-size:24px;font-weight:700;color:#16a34a;">${data.processedCount}</div>
    <div style="font-size:12px;color:#71717a;margin-top:4px;">処理済み</div>
  </td>
</tr>
</table>
${
  typeRows
    ? `<h3 style="margin:0 0 8px;font-size:14px;color:#18181b;">種別内訳</h3>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e4e7;border-radius:4px;border-collapse:collapse;font-size:14px;">
<thead>
<tr style="background-color:#f4f4f5;">
  <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #e4e4e7;">種別</th>
  <th style="padding:8px 12px;text-align:right;border-bottom:1px solid #e4e4e7;">件数</th>
  <th style="padding:8px 12px;text-align:right;border-bottom:1px solid #e4e4e7;">金額</th>
</tr>
</thead>
<tbody>
${typeRows}
</tbody>
</table>`
    : ""
}`

  return body
}

/** 月末まとめメールを送信 */
export async function sendMonthSummary(
  to: string[],
  data: MonthSummaryData
): Promise<{ success: boolean; error?: string }> {
  if (!resend) return { success: false, error: "RESEND_API_KEY が設定されていません" }

  const html = wrapHtml(
    `${data.year}年${data.month}月 書類まとめ`,
    buildMonthSummaryHtml(data)
  )

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: `【経理書類管理】${data.year}年${data.month}月の書類まとめ`,
      html,
    })
    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : "メール送信に失敗しました"
    return { success: false, error: message }
  }
}

// ====================================================
// 未承認メール通知
// ====================================================

export interface UnapprovedMailItem {
  file_name: string
  sender: string
  received_at: string | null
  ai_type: string | null
}

/** 未承認メール通知のHTML */
function buildUnapprovedMailHtml(items: UnapprovedMailItem[]): string {
  const rows = items
    .map(
      (item) => `
<tr>
  <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;">${item.file_name}</td>
  <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;">${item.sender}</td>
  <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;">${item.ai_type ?? "-"}</td>
  <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;">${item.received_at ? new Date(item.received_at).toLocaleDateString("ja-JP") : "-"}</td>
</tr>`
    )
    .join("")

  const body = `
<h2 style="margin:0 0 16px;font-size:16px;color:#18181b;">未承認の添付ファイルがあります</h2>
<p style="margin:0 0 16px;font-size:14px;color:#71717a;">メールから取り込んだ以下のファイルが承認待ちです。管理画面から確認してください。</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e4e7;border-radius:4px;border-collapse:collapse;font-size:14px;">
<thead>
<tr style="background-color:#f4f4f5;">
  <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #e4e4e7;">ファイル名</th>
  <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #e4e4e7;">差出人</th>
  <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #e4e4e7;">AI判定</th>
  <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #e4e4e7;">受信日</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
<p style="margin:16px 0 0;font-size:14px;color:#71717a;">合計 ${items.length} 件が承認待ちです。</p>`

  return body
}

/** 未承認メール通知を送信 */
export async function sendUnapprovedMailNotify(
  to: string[],
  items: UnapprovedMailItem[]
): Promise<{ success: boolean; error?: string }> {
  if (items.length === 0) return { success: true }
  if (!resend) return { success: false, error: "RESEND_API_KEY が設定されていません" }

  const html = wrapHtml(
    "未承認メール通知",
    buildUnapprovedMailHtml(items)
  )

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: `【経理書類管理】未承認の添付ファイル（${items.length}件）`,
      html,
    })
    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : "メール送信に失敗しました"
    return { success: false, error: message }
  }
}
