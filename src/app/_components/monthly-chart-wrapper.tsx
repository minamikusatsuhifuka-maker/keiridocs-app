"use client"

import { MonthlyChart } from "@/components/dashboard/monthly-chart"

// MonthlyChartのクライアントラッパー（Rechartsはクライアントのみ）
export function MonthlyChartWrapper({
  data,
}: {
  data: { month: string; count: number }[]
}) {
  return <MonthlyChart data={data} />
}
