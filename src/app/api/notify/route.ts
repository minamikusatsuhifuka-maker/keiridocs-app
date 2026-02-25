import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  sendDueDateAlert,
  sendMonthSummary,
  sendUnapprovedMailNotify,
  type DueDateAlertItem,
  type MonthSummaryData,
  type UnapprovedMailItem,
} from "@/lib/resend"
import { format, addDays, getDaysInMonth } from "date-fns"

// 通知チェック＆送信
export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  // 通知フラグを取得
  const { data: flagsRow } = await supabase
    .from("settings")
    .select("value")
    .eq("user_id", user.id)
    .eq("key", "notification_flags")
    .maybeSingle()

  const flags = (flagsRow?.value as {
    due_date_notify?: boolean
    month_end_notify?: boolean
    unapproved_mail_notify?: boolean
  } | null) ?? {
    due_date_notify: true,
    month_end_notify: false,
    unapproved_mail_notify: true,
  }

  // 通知先メールアドレスを取得
  const { data: recipients } = await supabase
    .from("notify_recipients")
    .select("email")
    .eq("user_id", user.id)

  const toEmails = (recipients ?? []).map((r) => r.email)

  if (toEmails.length === 0) {
    return NextResponse.json({
      message: "通知先が設定されていません",
      results: {},
    })
  }

  const now = new Date()
  const today = format(now, "yyyy-MM-dd")
  const threeDaysLater = format(addDays(now, 3), "yyyy-MM-dd")

  const results: Record<string, { sent: boolean; count?: number; error?: string }> = {}

  // 1. 支払期限アラート（3日以内の未処理書類）
  if (flags.due_date_notify) {
    const { data: dueDocs } = await supabase
      .from("documents")
      .select("vendor_name, type, amount, due_date")
      .eq("user_id", user.id)
      .eq("status", "未処理")
      .gte("due_date", today)
      .lte("due_date", threeDaysLater)
      .order("due_date", { ascending: true })

    const items: DueDateAlertItem[] = (dueDocs ?? []).map((doc) => ({
      vendor_name: doc.vendor_name,
      type: doc.type,
      amount: doc.amount,
      due_date: doc.due_date!,
    }))

    if (items.length > 0) {
      const result = await sendDueDateAlert(toEmails, items)
      results.due_date = { sent: result.success, count: items.length, error: result.error }
    } else {
      results.due_date = { sent: false, count: 0 }
    }
  }

  // 2. 月末まとめ（月末3日以内の場合）
  if (flags.month_end_notify) {
    const daysInMonth = getDaysInMonth(now)
    const dayOfMonth = now.getDate()
    const isNearMonthEnd = dayOfMonth >= daysInMonth - 2

    if (isNearMonthEnd) {
      const year = now.getFullYear()
      const month = now.getMonth() + 1
      const monthStart = format(new Date(year, now.getMonth(), 1), "yyyy-MM-dd")
      const monthEnd = format(new Date(year, now.getMonth(), daysInMonth), "yyyy-MM-dd")

      const { data: monthDocs } = await supabase
        .from("documents")
        .select("type, amount, status")
        .eq("user_id", user.id)
        .gte("created_at", monthStart)
        .lte("created_at", monthEnd + "T23:59:59")

      const docs = monthDocs ?? []
      const totalCount = docs.length
      const totalAmount = docs.reduce((sum, d) => sum + (d.amount ?? 0), 0)
      const pendingCount = docs.filter((d) => d.status === "未処理").length
      const processedCount = docs.filter((d) => d.status === "処理済み").length

      // 種別ごとの集計
      const typeMap = new Map<string, { count: number; amount: number }>()
      for (const doc of docs) {
        const existing = typeMap.get(doc.type) ?? { count: 0, amount: 0 }
        typeMap.set(doc.type, {
          count: existing.count + 1,
          amount: existing.amount + (doc.amount ?? 0),
        })
      }
      const typeBreakdown = Array.from(typeMap.entries()).map(([type, data]) => ({
        type,
        ...data,
      }))

      const summaryData: MonthSummaryData = {
        year,
        month,
        totalCount,
        totalAmount,
        pendingCount,
        processedCount,
        typeBreakdown,
      }

      const result = await sendMonthSummary(toEmails, summaryData)
      results.month_summary = { sent: result.success, count: totalCount, error: result.error }
    } else {
      results.month_summary = { sent: false, count: 0 }
    }
  }

  // 3. 未承認メール通知
  if (flags.unapproved_mail_notify) {
    const { data: pendingMails } = await supabase
      .from("mail_pending")
      .select("file_name, sender, received_at, ai_type")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })

    const items: UnapprovedMailItem[] = (pendingMails ?? []).map((m) => ({
      file_name: m.file_name,
      sender: m.sender,
      received_at: m.received_at,
      ai_type: m.ai_type,
    }))

    if (items.length > 0) {
      const result = await sendUnapprovedMailNotify(toEmails, items)
      results.unapproved_mail = { sent: result.success, count: items.length, error: result.error }
    } else {
      results.unapproved_mail = { sent: false, count: 0 }
    }
  }

  return NextResponse.json({ message: "通知チェック完了", results })
}
