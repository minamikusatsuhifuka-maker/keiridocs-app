"use client"

import { useState, useEffect, useCallback } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts"
import { Loader2, BarChart3 } from "lucide-react"

// 型定義
interface MonthlyData {
  month: string
  count: number
  total_amount: number
}

interface TypeData {
  type: string
  count: number
  total_amount: number
}

interface VendorData {
  vendor_name: string
  count: number
  total_amount: number
}

interface StatusData {
  status: string
  count: number
}

interface MonthlyTypeMatrix {
  type: string
  months: Record<string, number>
}

interface AnalyticsResponse {
  monthly: MonthlyData[]
  byType: TypeData[]
  topVendors: VendorData[]
  byStatus: StatusData[]
  monthlyTypeMatrix: MonthlyTypeMatrix[]
  matrixMonths: string[]
  totalDocuments: number
  totalAmount: number
}

// 円グラフの色パレット
const PIE_COLORS = [
  "hsl(var(--primary))",
  "hsl(210, 70%, 55%)",
  "hsl(150, 60%, 45%)",
  "hsl(40, 80%, 50%)",
  "hsl(0, 70%, 55%)",
  "hsl(270, 60%, 55%)",
  "hsl(180, 50%, 45%)",
  "hsl(320, 60%, 50%)",
]

// ステータスの色
const STATUS_COLORS: Record<string, string> = {
  "未処理": "hsl(40, 80%, 50%)",
  "処理済み": "hsl(150, 60%, 45%)",
  "アーカイブ": "hsl(210, 20%, 60%)",
}

/** 金額をカンマ区切りで表示 */
function formatAmount(amount: number): string {
  return amount.toLocaleString("ja-JP")
}

// 分析ダッシュボードページ
export default function AnalyticsPage() {
  const [period, setPeriod] = useState("12m")
  const [data, setData] = useState<AnalyticsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async (p: string) => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/analytics?period=${p}`)
      if (!res.ok) {
        throw new Error("データの取得に失敗しました")
      }
      const json = await res.json() as AnalyticsResponse
      setData(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData(period)
  }, [period, fetchData])

  const handlePeriodChange = (value: string) => {
    setPeriod(value)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">データ分析</h1>
        <p className="text-sm text-destructive">{error}</p>
      </div>
    )
  }

  const isEmpty = !data || data.totalDocuments === 0

  return (
    <div className="space-y-6">
      {/* ヘッダー + 期間フィルタ */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold">データ分析</h1>
        <Select value={period} onValueChange={handlePeriodChange}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="3m">過去3ヶ月</SelectItem>
            <SelectItem value="6m">過去6ヶ月</SelectItem>
            <SelectItem value="12m">過去12ヶ月</SelectItem>
            <SelectItem value="all">全期間</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isEmpty ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16">
            <BarChart3 className="size-12 text-muted-foreground" />
            <p className="text-muted-foreground">
              書類を登録すると分析データが表示されます
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* サマリーカード */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  書類総数
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{data.totalDocuments} 件</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  合計金額
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">&yen;{formatAmount(data.totalAmount)}</p>
              </CardContent>
            </Card>
          </div>

          {/* グラフエリア（2カラム） */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* a) 月次推移グラフ */}
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">月次推移</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={350}>
                  <BarChart data={data.monthly}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis
                      dataKey="month"
                      tick={{ fontSize: 12 }}
                    />
                    <YAxis
                      yAxisId="left"
                      allowDecimals={false}
                      tick={{ fontSize: 12 }}
                      label={{ value: "件数", angle: -90, position: "insideLeft", style: { fontSize: 12 } }}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      tick={{ fontSize: 12 }}
                      tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`}
                      label={{ value: "金額", angle: 90, position: "insideRight", style: { fontSize: 12 } }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      formatter={((value: unknown, name: unknown) => {
                        const v = typeof value === "number" ? value : 0
                        if (name === "count") return [`${v} 件`, "登録数"]
                        return [`¥${formatAmount(v)}`, "合計金額"]
                      }) as never}
                    />
                    <Legend
                      formatter={(value: unknown) => {
                        if (value === "count") return "登録数"
                        return "合計金額"
                      }}
                    />
                    <Bar
                      yAxisId="left"
                      dataKey="count"
                      fill="hsl(var(--primary))"
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      yAxisId="right"
                      dataKey="total_amount"
                      fill="hsl(210, 70%, 55%)"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* b) 書類種別の内訳 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">書類種別の内訳</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={data.byType}
                      dataKey="count"
                      nameKey="type"
                      cx="50%"
                      cy="50%"
                      outerRadius={100}
                      label={({ name, value }: { name?: string; value?: number }) => `${name ?? ""}: ${value ?? 0}件`}
                      labelLine
                    >
                      {data.byType.map((_, index) => (
                        <Cell
                          key={`type-${index}`}
                          fill={PIE_COLORS[index % PIE_COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      formatter={((value: unknown, _name: unknown, entry: any) => {
                        const v = typeof value === "number" ? value : 0
                        const item = entry?.payload as TypeData | undefined
                        return [`${v} 件 / ¥${formatAmount(item?.total_amount ?? 0)}`, item?.type ?? ""]
                      }) as never}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* d) ステータス分布 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">ステータス分布</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={data.byStatus}
                      dataKey="count"
                      nameKey="status"
                      cx="50%"
                      cy="50%"
                      outerRadius={100}
                      label={({ name, value }: { name?: string; value?: number }) => `${name ?? ""}: ${value ?? 0}件`}
                      labelLine
                    >
                      {data.byStatus.map((entry, index) => (
                        <Cell
                          key={`status-${index}`}
                          fill={STATUS_COLORS[entry.status] || PIE_COLORS[index % PIE_COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      formatter={((value: unknown, name: unknown) => [`${value ?? 0} 件`, name ?? ""]) as never}
                    />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* c) 取引先トップ10 */}
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">取引先トップ10（金額ベース）</CardTitle>
              </CardHeader>
              <CardContent>
                {data.topVendors.length === 0 ? (
                  <p className="text-sm text-muted-foreground">データがありません</p>
                ) : (
                  <ResponsiveContainer width="100%" height={Math.max(300, data.topVendors.length * 40)}>
                    <BarChart
                      data={data.topVendors}
                      layout="vertical"
                      margin={{ left: 20 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis
                        type="number"
                        tick={{ fontSize: 12 }}
                        tickFormatter={(v: number) => `¥${formatAmount(v)}`}
                      />
                      <YAxis
                        type="category"
                        dataKey="vendor_name"
                        tick={{ fontSize: 12 }}
                        width={120}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "8px",
                          fontSize: "12px",
                        }}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        formatter={((value: unknown, _name: unknown, entry: any) => {
                          const v = typeof value === "number" ? value : 0
                          const item = entry?.payload as VendorData | undefined
                          return [`¥${formatAmount(v)} (${item?.count ?? 0}件)`, "合計金額"]
                        }) as never}
                      />
                      <Bar
                        dataKey="total_amount"
                        fill="hsl(150, 60%, 45%)"
                        radius={[0, 4, 4, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* e) 月別経費テーブル */}
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">月別経費テーブル</CardTitle>
              </CardHeader>
              <CardContent>
                {data.monthlyTypeMatrix.length === 0 ? (
                  <p className="text-sm text-muted-foreground">データがありません</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>種別</TableHead>
                        {data.matrixMonths.map((m) => (
                          <TableHead key={m} className="text-right">
                            {m}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.monthlyTypeMatrix.map((row) => (
                        <TableRow key={row.type}>
                          <TableCell className="font-medium">{row.type}</TableCell>
                          {data.matrixMonths.map((m) => (
                            <TableCell key={m} className="text-right">
                              {row.months[m] ? `¥${formatAmount(row.months[m])}` : "-"}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                    <TableFooter>
                      <TableRow>
                        <TableCell className="font-bold">合計</TableCell>
                        {data.matrixMonths.map((m) => {
                          const total = data.monthlyTypeMatrix.reduce(
                            (sum, row) => sum + (row.months[m] ?? 0),
                            0
                          )
                          return (
                            <TableCell key={m} className="text-right font-bold">
                              {total > 0 ? `¥${formatAmount(total)}` : "-"}
                            </TableCell>
                          )
                        })}
                      </TableRow>
                    </TableFooter>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
