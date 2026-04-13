import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { StatsCards } from "@/components/dashboard/stats-cards"
import { DueAlerts } from "@/components/dashboard/due-alerts"
import { StaffStatusCard, type StaffStatus } from "@/components/dashboard/staff-status-card"
import {
  CategoryPieChartClient,
  WeeklyBarChartClient,
} from "@/app/_components/dashboard-charts"
import { format, addDays, startOfWeek, startOfMonth } from "date-fns"

// ダッシュボードページ（Server Component）
export default async function DashboardPage() {
  const supabase = await createClient()

  // 現在のユーザーを取得
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const userRole = await getCurrentUserRole()
  const isAdminUser = userRole?.role === "admin"

  if (!user) {
    return (
      <div>
        <h1 className="text-2xl font-bold" style={{ color: "#3A2D20" }}>
          ダッシュボード
        </h1>
        <p className="mt-2 text-sm text-[#9A8070]">ログインしてください</p>
      </div>
    )
  }

  const now = new Date()
  const monthStart = format(startOfMonth(now), "yyyy-MM-dd")
  const sevenDaysLater = format(addDays(now, 7), "yyyy-MM-dd")
  const today = format(now, "yyyy-MM-dd")
  // 直近6週間分の開始日（月曜始まり）
  const sixWeeksAgo = startOfWeek(addDays(now, -7 * 5), { weekStartsOn: 1 })
  const sixWeeksAgoStr = format(sixWeeksAgo, "yyyy-MM-dd")

  // 並行してデータ取得
  const [
    monthlyResult,
    pendingResult,
    dueSoonResult,
    weeklyResult,
    staffMembersResult,
    staffReceiptsResult,
  ] = await Promise.all([
    // 今月の登録書類（金額・種別）
    supabase
      .from("documents")
      .select("amount, type")
      .eq("user_id", user.id)
      .gte("created_at", monthStart),

    // 未処理件数
    supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "未処理"),

    // 支払期日が近い書類TOP5（7日以内）※支払済も含む（下部表示のため）
    supabase
      .from("documents")
      .select("id, vendor_name, amount, due_date, type, payment_status")
      .eq("user_id", user.id)
      .eq("status", "未処理")
      .gte("due_date", today)
      .lte("due_date", sevenDaysLater)
      .order("due_date", { ascending: true })
      .limit(10),

    // 過去6週間の金額推移（created_at + amount）
    supabase
      .from("documents")
      .select("created_at, amount")
      .eq("user_id", user.id)
      .gte("created_at", sixWeeksAgoStr),

    // スタッフ一覧
    supabase.from("staff_members").select("id, name").order("name"),

    // 今月のスタッフ領収書
    supabase
      .from("staff_receipts")
      .select("staff_member_id")
      .gte("created_at", monthStart),
  ])

  // 今月の経費合計・件数
  const monthlyDocs = monthlyResult.data ?? []
  const monthlyCount = monthlyDocs.length
  const monthlyTotal = monthlyDocs.reduce(
    (sum, doc) => sum + (doc.amount ?? 0),
    0
  )

  // 未処理件数
  const pendingCount = pendingResult.count ?? 0

  // 支払期日が近い書類
  const dueSoonDocs = (dueSoonResult.data ?? []).map((doc) => ({
    id: doc.id,
    vendor_name: doc.vendor_name,
    amount: doc.amount,
    due_date: doc.due_date!,
    type: doc.type,
    payment_status: doc.payment_status ?? "未対応",
  }))
  // 未対応の件数のみカウント
  const dueSoonCount = dueSoonDocs.filter((d) => d.payment_status !== "支払い済み").length

  // カテゴリ別集計（金額合計）
  const categoryMap = new Map<string, number>()
  for (const doc of monthlyDocs) {
    if (!doc.amount) continue
    const key = doc.type || "その他"
    categoryMap.set(key, (categoryMap.get(key) ?? 0) + doc.amount)
  }
  const categoryData = Array.from(categoryMap.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)

  // 週別集計（直近6週）
  const weeklyData = buildWeeklyData(weeklyResult.data ?? [], now)

  // スタッフ別提出状況
  const staffList = staffMembersResult.data ?? []
  const receipts = staffReceiptsResult.data ?? []
  const staffCountMap = new Map<string, number>()
  for (const r of receipts) {
    staffCountMap.set(
      r.staff_member_id,
      (staffCountMap.get(r.staff_member_id) ?? 0) + 1
    )
  }
  const staffStatus: StaffStatus[] = staffList.map((s) => ({
    id: s.id,
    name: s.name,
    count: staffCountMap.get(s.id) ?? 0,
  }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: "#3A2D20" }}>
          ダッシュボード
        </h1>
        <p className="mt-1 text-sm text-[#9A8070]">
          {format(now, "yyyy年MM月")}の経理書類サマリー
        </p>
      </div>

      {/* メトリクスカード */}
      <StatsCards
        monthlyCount={monthlyCount}
        pendingCount={pendingCount}
        monthlyTotal={monthlyTotal}
        dueSoonCount={dueSoonCount}
      />

      {/* グラフ：カテゴリ別（円）＋ 週別推移（棒） */}
      <div className="grid gap-6 lg:grid-cols-2">
        <CategoryPieChartClient data={categoryData} />
        <WeeklyBarChartClient data={weeklyData} />
      </div>

      {/* スタッフ状況（admin のみ） + 支払期限 */}
      <div className={`grid gap-6 ${isAdminUser ? "lg:grid-cols-2" : ""}`}>
        {isAdminUser && <StaffStatusCard staff={staffStatus} />}
        <DueAlerts documents={dueSoonDocs} />
      </div>
    </div>
  )
}

// 直近6週間の金額を週単位で集計（月曜始まり）
function buildWeeklyData(
  docs: { created_at: string; amount: number | null }[],
  now: Date
): { week: string; amount: number }[] {
  const result: { week: string; amount: number }[] = []

  for (let i = 5; i >= 0; i--) {
    const weekStart = startOfWeek(addDays(now, -7 * i), { weekStartsOn: 1 })
    const weekEnd = addDays(weekStart, 7)
    const label = format(weekStart, "MM/dd")

    const amount = docs.reduce((sum, doc) => {
      const d = new Date(doc.created_at)
      if (d >= weekStart && d < weekEnd) {
        return sum + (doc.amount ?? 0)
      }
      return sum
    }, 0)

    result.push({ week: label, amount })
  }

  return result
}
