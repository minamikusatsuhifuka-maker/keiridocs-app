import { NextRequest, NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/server"
import { uploadFile } from "@/lib/dropbox"
import type { Database } from "@/types/database"

export const maxDuration = 60

type StaffReceiptRow = Database["public"]["Tables"]["staff_receipts"]["Row"]

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
  // Vercel Cronからの呼び出し
  const authHeader = request.headers.get("authorization")
  if (authHeader === `Bearer ${process.env.CRON_SECRET}`) return true

  // 管理者画面からの手動実行（Supabase認証）
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
 * 月次締めCronジョブ
 * 毎月1日 0:00 UTC（日本時間9:00）に実行
 * 先月のstaff_receiptsを全員分集計しExcelをDropboxに保存、管理者にLINE通知
 */
export async function GET(request: NextRequest) {
  // 認証チェック（CRON_SECRET or ログインユーザー）
  if (!(await checkAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceClient()

  try {
    // 先月を計算
    const now = new Date()
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const year = prevMonth.getFullYear()
    const month = prevMonth.getMonth() + 1
    const yearStr = String(year)
    const monthStr = String(month).padStart(2, "0")

    const dateFrom = `${yearStr}-${monthStr}-01`
    const lastDay = new Date(year, month, 0).getDate()
    const dateTo = `${yearStr}-${monthStr}-${String(lastDay).padStart(2, "0")}`

    // スタッフ一覧を取得（名前解決用）
    const { data: staffMembers } = await supabase
      .from("staff_members")
      .select("id, name")

    const staffMap = new Map((staffMembers || []).map((s) => [s.id, s.name]))

    // 先月の全staff_receiptsを取得
    const { data: rawReceipts, error: receiptsError } = await supabase
      .from("staff_receipts")
      .select("*")
      .gte("date", dateFrom)
      .lte("date", dateTo)
      .order("date", { ascending: true })

    if (receiptsError) {
      console.error("[monthly-close] 領収書取得エラー:", receiptsError)
      return NextResponse.json({ error: "領収書の取得に失敗しました" }, { status: 500 })
    }

    const receipts = (rawReceipts || []) as StaffReceiptRow[]

    if (receipts.length === 0) {
      return NextResponse.json({
        message: `${yearStr}年${monthStr}月の領収書はありません`,
        count: 0,
        total: 0,
      })
    }

    // 集計データ作成
    const totalAmount = receipts.reduce((sum, r) => sum + (r.amount || 0), 0)
    const totalCount = receipts.length

    // スタッフ別・勘定科目別・税区分別の集計
    const byStaff: Record<string, number> = {}
    const byAccount: Record<string, number> = {}
    const byTax: Record<string, number> = {}

    for (const r of receipts) {
      const staffName = staffMap.get(r.staff_member_id) || "不明"
      byStaff[staffName] = (byStaff[staffName] || 0) + (r.amount || 0)

      const accountKey = r.account_title || "未分類"
      byAccount[accountKey] = (byAccount[accountKey] || 0) + (r.amount || 0)

      const taxKey = r.tax_category || "未判定"
      byTax[taxKey] = (byTax[taxKey] || 0) + (r.amount || 0)
    }

    // Excel生成（xlsx）
    const { utils, write } = await import("xlsx")

    // 明細シート
    const detailData = receipts.map((r) => ({
      スタッフ名: staffMap.get(r.staff_member_id) || "不明",
      日付: r.date || "",
      店名: r.store_name || "",
      金額: r.amount ?? 0,
      種別: r.document_type || "",
      税区分: r.tax_category || "",
      勘定科目: r.account_title || "",
      ファイル名: r.file_name,
    }))
    const ws1 = utils.json_to_sheet(detailData)
    ws1["!cols"] = [
      { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 14 },
      { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 30 },
    ]

    // 集計シート
    const summaryRows: Record<string, unknown>[] = []
    summaryRows.push({ 項目: "合計金額", 金額: totalAmount })
    summaryRows.push({ 項目: `件数: ${totalCount}件`, 金額: "" })
    summaryRows.push({ 項目: "", 金額: "" })

    summaryRows.push({ 項目: "【スタッフ別】", 金額: "" })
    for (const [k, v] of Object.entries(byStaff)) {
      summaryRows.push({ 項目: k, 金額: v })
    }
    summaryRows.push({ 項目: "", 金額: "" })

    summaryRows.push({ 項目: "【勘定科目別】", 金額: "" })
    for (const [k, v] of Object.entries(byAccount)) {
      summaryRows.push({ 項目: k, 金額: v })
    }
    summaryRows.push({ 項目: "", 金額: "" })

    summaryRows.push({ 項目: "【税区分別】", 金額: "" })
    for (const [k, v] of Object.entries(byTax)) {
      summaryRows.push({ 項目: k, 金額: v })
    }

    const ws2 = utils.json_to_sheet(summaryRows)
    ws2["!cols"] = [{ wch: 25 }, { wch: 16 }]

    const wb = utils.book_new()
    utils.book_append_sheet(wb, ws1, "領収書一覧")
    utils.book_append_sheet(wb, ws2, "集計")

    const excelBuffer = write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer

    // Dropboxに保存
    const dropboxFolder = `/経理書類/月次レポート/${yearStr}年${monthStr}月`
    const dropboxPath = `${dropboxFolder}/スタッフ領収書_${yearStr}年${monthStr}月.xlsx`
    await uploadFile(dropboxPath, Buffer.from(excelBuffer))

    // 管理者にLINE通知
    const adminLineUserId = process.env.ADMIN_LINE_USER_ID
    if (adminLineUserId) {
      const formattedAmount = totalAmount.toLocaleString("ja-JP")
      const message = `📊 ${yearStr}年${monthStr}月の月次締めが完了しました\n合計: ¥${formattedAmount}\n件数: ${totalCount}件\nDropboxに保存済みです`
      await pushLineMessage(adminLineUserId, message)
    }

    return NextResponse.json({
      message: `${yearStr}年${monthStr}月の月次締めが完了しました`,
      count: totalCount,
      total: totalAmount,
      dropbox_path: dropboxPath,
    })
  } catch (error) {
    console.error("[monthly-close] エラー:", error)
    return NextResponse.json(
      { error: "月次締めの実行に失敗しました" },
      { status: 500 }
    )
  }
}
