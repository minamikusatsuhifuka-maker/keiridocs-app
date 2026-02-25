import { createClient } from "@/lib/supabase/server"
import { StatsCards } from "@/components/dashboard/stats-cards"
import { DueAlerts } from "@/components/dashboard/due-alerts"
import { MonthlyChartWrapper } from "@/app/_components/monthly-chart-wrapper"
import { format, subMonths, addDays } from "date-fns"

// ダッシュボードページ（Server Component）
export default async function DashboardPage() {
  const supabase = await createClient()

  // 現在のユーザーを取得
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return (
      <div>
        <h1 className="text-2xl font-bold">ダッシュボード</h1>
        <p className="mt-2 text-muted-foreground">ログインしてください</p>
      </div>
    )
  }

  const now = new Date()
  const monthStart = format(new Date(now.getFullYear(), now.getMonth(), 1), "yyyy-MM-dd")
  const threeDaysLater = format(addDays(now, 3), "yyyy-MM-dd")
  const today = format(now, "yyyy-MM-dd")

  // 並行してデータ取得
  const [
    monthlyResult,
    pendingResult,
    dueSoonResult,
    chartResult,
  ] = await Promise.all([
    // 今月の登録数 + 合計金額
    supabase
      .from("documents")
      .select("amount")
      .eq("user_id", user.id)
      .gte("created_at", monthStart),

    // 未処理件数
    supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "未処理"),

    // 支払期限間近（3日以内）
    supabase
      .from("documents")
      .select("id, vendor_name, amount, due_date, type")
      .eq("user_id", user.id)
      .eq("status", "未処理")
      .gte("due_date", today)
      .lte("due_date", threeDaysLater)
      .order("due_date", { ascending: true }),

    // 過去6ヶ月の月別登録数
    supabase
      .from("documents")
      .select("created_at")
      .eq("user_id", user.id)
      .gte("created_at", format(subMonths(now, 5), "yyyy-MM-01")),
  ])

  // 今月の登録数
  const monthlyCount = monthlyResult.data?.length ?? 0

  // 今月の合計金額
  const monthlyTotal = monthlyResult.data?.reduce(
    (sum, doc) => sum + (doc.amount ?? 0),
    0
  ) ?? 0

  // 未処理件数
  const pendingCount = pendingResult.count ?? 0

  // 支払期限間近の書類
  const dueSoonDocs = (dueSoonResult.data ?? []).map((doc) => ({
    id: doc.id,
    vendor_name: doc.vendor_name,
    amount: doc.amount,
    due_date: doc.due_date!,
    type: doc.type,
  }))

  // 支払期限間近の件数
  const dueSoonCount = dueSoonDocs.length

  // 月別データの集計（過去6ヶ月）
  const monthlyChartData = buildMonthlyData(chartResult.data ?? [], now)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">ダッシュボード</h1>

      {/* 統計カード */}
      <StatsCards
        monthlyCount={monthlyCount}
        pendingCount={pendingCount}
        monthlyTotal={monthlyTotal}
        dueSoonCount={dueSoonCount}
      />

      {/* 下部: アラート + グラフ */}
      <div className="grid gap-6 lg:grid-cols-2">
        <DueAlerts documents={dueSoonDocs} />
        <MonthlyChartWrapper data={monthlyChartData} />
      </div>
    </div>
  )
}

// 過去6ヶ月の月別データを集計
function buildMonthlyData(
  docs: { created_at: string }[],
  now: Date
): { month: string; count: number }[] {
  const result: { month: string; count: number }[] = []

  for (let i = 5; i >= 0; i--) {
    const d = subMonths(now, i)
    const year = d.getFullYear()
    const month = d.getMonth()
    const label = `${year}/${String(month + 1).padStart(2, "0")}`

    const count = docs.filter((doc) => {
      const docDate = new Date(doc.created_at)
      return docDate.getFullYear() === year && docDate.getMonth() === month
    }).length

    result.push({ month: label, count })
  }

  return result
}
