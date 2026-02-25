import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { subMonths, format } from "date-fns"

/** 月次集計データ */
interface MonthlyData {
  month: string
  count: number
  total_amount: number
}

/** 種別集計データ */
interface TypeData {
  type: string
  count: number
  total_amount: number
}

/** 取引先集計データ */
interface VendorData {
  vendor_name: string
  count: number
  total_amount: number
}

/** ステータス集計データ */
interface StatusData {
  status: string
  count: number
}

/** 月別×種別のマトリクスデータ */
interface MonthlyTypeMatrix {
  type: string
  months: Record<string, number>
}

// 分析データ取得 API
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const period = searchParams.get("period") || "12m"

  // 期間の開始日を計算
  const now = new Date()
  let dateFrom: string | null = null

  switch (period) {
    case "3m":
      dateFrom = format(subMonths(now, 3), "yyyy-MM-dd")
      break
    case "6m":
      dateFrom = format(subMonths(now, 6), "yyyy-MM-dd")
      break
    case "12m":
      dateFrom = format(subMonths(now, 12), "yyyy-MM-dd")
      break
    case "all":
      dateFrom = null
      break
    default:
      dateFrom = format(subMonths(now, 12), "yyyy-MM-dd")
  }

  // 期間フィルタ付きでdocumentsを取得
  let query = supabase
    .from("documents")
    .select("type, vendor_name, amount, issue_date, status, created_at")
    .eq("user_id", user.id)

  if (dateFrom) {
    query = query.gte("created_at", dateFrom)
  }

  const { data: documents, error } = await query

  if (error) {
    console.error("分析データ取得エラー:", error)
    return NextResponse.json({ error: "分析データの取得に失敗しました" }, { status: 500 })
  }

  const docs = documents ?? []

  // 月次集計を計算
  const monthlyMap = new Map<string, { count: number; total_amount: number }>()
  // 月数を決定
  const monthCount = period === "3m" ? 3 : period === "6m" ? 6 : period === "12m" ? 12 : 24

  for (let i = monthCount - 1; i >= 0; i--) {
    const d = subMonths(now, i)
    const key = format(d, "yyyy/MM")
    monthlyMap.set(key, { count: 0, total_amount: 0 })
  }

  for (const doc of docs) {
    const date = new Date(doc.created_at)
    const key = format(date, "yyyy/MM")
    const existing = monthlyMap.get(key)
    if (existing) {
      existing.count++
      existing.total_amount += doc.amount ?? 0
    }
  }

  const monthly: MonthlyData[] = Array.from(monthlyMap.entries()).map(([month, data]) => ({
    month,
    ...data,
  }))

  // 種別集計を計算
  const typeMap = new Map<string, { count: number; total_amount: number }>()
  for (const doc of docs) {
    const type = doc.type || "未分類"
    const existing = typeMap.get(type) ?? { count: 0, total_amount: 0 }
    existing.count++
    existing.total_amount += doc.amount ?? 0
    typeMap.set(type, existing)
  }

  const byType: TypeData[] = Array.from(typeMap.entries())
    .map(([type, data]) => ({ type, ...data }))
    .sort((a, b) => b.total_amount - a.total_amount)

  // 取引先集計を計算（トップ10）
  const vendorMap = new Map<string, { count: number; total_amount: number }>()
  for (const doc of docs) {
    const vendor = doc.vendor_name || "不明"
    const existing = vendorMap.get(vendor) ?? { count: 0, total_amount: 0 }
    existing.count++
    existing.total_amount += doc.amount ?? 0
    vendorMap.set(vendor, existing)
  }

  const topVendors: VendorData[] = Array.from(vendorMap.entries())
    .map(([vendor_name, data]) => ({ vendor_name, ...data }))
    .sort((a, b) => b.total_amount - a.total_amount)
    .slice(0, 10)

  // ステータス集計を計算
  const statusMap = new Map<string, number>()
  for (const doc of docs) {
    const status = doc.status || "未処理"
    statusMap.set(status, (statusMap.get(status) ?? 0) + 1)
  }

  const byStatus: StatusData[] = Array.from(statusMap.entries())
    .map(([status, count]) => ({ status, count }))

  // 月別×種別マトリクス（過去6ヶ月分）
  const matrixMonths: string[] = []
  for (let i = 5; i >= 0; i--) {
    matrixMonths.push(format(subMonths(now, i), "yyyy/MM"))
  }

  const matrixTypeMap = new Map<string, Record<string, number>>()
  for (const doc of docs) {
    const type = doc.type || "未分類"
    const date = new Date(doc.created_at)
    const monthKey = format(date, "yyyy/MM")

    if (!matrixMonths.includes(monthKey)) continue

    if (!matrixTypeMap.has(type)) {
      matrixTypeMap.set(type, {})
    }
    const months = matrixTypeMap.get(type)!
    months[monthKey] = (months[monthKey] ?? 0) + (doc.amount ?? 0)
  }

  const monthlyTypeMatrix: MonthlyTypeMatrix[] = Array.from(matrixTypeMap.entries())
    .map(([type, months]) => ({ type, months }))
    .sort((a, b) => a.type.localeCompare(b.type))

  return NextResponse.json({
    monthly,
    byType,
    topVendors,
    byStatus,
    monthlyTypeMatrix,
    matrixMonths,
    totalDocuments: docs.length,
    totalAmount: docs.reduce((sum, d) => sum + (d.amount ?? 0), 0),
  })
}
