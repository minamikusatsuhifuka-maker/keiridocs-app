"use client"

import { CategoryPieChart } from "@/components/dashboard/category-pie-chart"
import { WeeklyBarChart } from "@/components/dashboard/weekly-bar-chart"

// Rechartsはクライアント専用のためラップ
export function CategoryPieChartClient({
  data,
}: {
  data: { name: string; value: number }[]
}) {
  return <CategoryPieChart data={data} />
}

export function WeeklyBarChartClient({
  data,
}: {
  data: { week: string; amount: number }[]
}) {
  return <WeeklyBarChart data={data} />
}
