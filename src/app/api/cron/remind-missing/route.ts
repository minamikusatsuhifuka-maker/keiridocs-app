import { NextRequest, NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/server"
import type { Database } from "@/types/database"

export const maxDuration = 60

type StaffMemberRow = Database["public"]["Tables"]["staff_members"]["Row"]

/** サービスロールキーでRLSをバイパスするSupabaseクライアント */
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createSupabaseClient<Database>(url, serviceKey)
}

/** 認証チェック: CRON_SECRET または ログインユーザー */
async function checkAuth(request: NextRequest): Promise<boolean> {
  const authHeader = request.headers.get("authorization")
  if (authHeader === `Bearer ${process.env.CRON_SECRET}`) return true

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    return !!user
  } catch {
    return false
  }
}

/** LINE Push メッセージ送信 */
async function pushLineMessage(userId: string, text: string): Promise<boolean> {
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
      console.error("LINE Push送信失敗:", res.status, await res.text())
      return false
    }
    return true
  } catch (error) {
    console.error("LINE Push送信エラー:", error)
    return false
  }
}

/**
 * 未提出リマインダーCronジョブ
 * 毎月25日 1:00 UTC（日本時間10:00）に実行
 * 当月のstaff_receiptsを確認し、1件も提出していないスタッフにLINE通知
 */
export async function GET(request: NextRequest) {
  // 認証チェック（CRON_SECRET or ログインユーザー）
  if (!(await checkAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceClient()

  try {
    // 当月の範囲を計算
    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth() + 1
    const yearStr = String(year)
    const monthStr = String(month).padStart(2, "0")

    const dateFrom = `${yearStr}-${monthStr}-01`
    const lastDay = new Date(year, month, 0).getDate()
    const dateTo = `${yearStr}-${monthStr}-${String(lastDay).padStart(2, "0")}`

    // 全スタッフを取得
    const { data: rawStaff, error: staffError } = await supabase
      .from("staff_members")
      .select("*")

    if (staffError || !rawStaff) {
      console.error("[remind-missing] スタッフ取得エラー:", staffError)
      return NextResponse.json({ error: "スタッフ情報の取得に失敗しました" }, { status: 500 })
    }

    const staffMembers = rawStaff as StaffMemberRow[]

    // 当月の提出済みスタッフIDを取得
    const { data: rawReceipts, error: receiptsError } = await supabase
      .from("staff_receipts")
      .select("staff_member_id")
      .gte("date", dateFrom)
      .lte("date", dateTo)

    if (receiptsError) {
      console.error("[remind-missing] 領収書取得エラー:", receiptsError)
      return NextResponse.json({ error: "領収書の取得に失敗しました" }, { status: 500 })
    }

    const receipts = (rawReceipts || []) as { staff_member_id: string }[]
    const submittedStaffIds = new Set(receipts.map((r) => r.staff_member_id))

    // 未提出スタッフを検出
    const missingStaff = staffMembers.filter((s) => !submittedStaffIds.has(s.id))

    // LINE通知を送信
    const notified: string[] = []
    const skipped: string[] = []

    for (const staff of missingStaff) {
      if (staff.line_user_id) {
        const message = `📎 ${staff.name}さん、今月の領収書がまだ提出されていません。\n月末までに「南草津皮フ科 経理」LINEに写真を送ってください`
        const sent = await pushLineMessage(staff.line_user_id, message)
        if (sent) {
          notified.push(staff.name)
        } else {
          skipped.push(staff.name)
        }
      } else {
        skipped.push(staff.name)
      }
    }

    // 管理者にもサマリーを通知
    const adminLineUserId = process.env.ADMIN_LINE_USER_ID
    if (adminLineUserId && missingStaff.length > 0) {
      const names = missingStaff.map((s) => s.name).join("、")
      const adminMessage = `📋 ${yearStr}年${monthStr}月 未提出リマインダー\n未提出: ${names}\nLINE通知済み: ${notified.length}名\n未通知（LINE未登録）: ${skipped.length}名`
      await pushLineMessage(adminLineUserId, adminMessage)
    }

    return NextResponse.json({
      message: "未提出リマインダーを送信しました",
      target_month: `${yearStr}-${monthStr}`,
      missing_count: missingStaff.length,
      notified,
      skipped,
    })
  } catch (error) {
    console.error("[remind-missing] エラー:", error)
    return NextResponse.json(
      { error: "未提出リマインダーの送信に失敗しました" },
      { status: 500 }
    )
  }
}
