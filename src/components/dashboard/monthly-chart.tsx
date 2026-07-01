"use client"

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface MonthlyData {
  month: string
  count: number
}

interface MonthlyChartProps {
  data: MonthlyData[]
}

// 月別登録数の棒グラフ
export function MonthlyChart({ data }: MonthlyChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">月別登録数</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            データがありません
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis
                dataKey="month"
                className="text-xs"
                tick={{ fontSize: 12 }}
              />
              <YAxis
                allowDecimals={false}
                className="text-xs"
                tick={{ fontSize: 12 }}
              />
              <Tooltip
                // hsl(var(--card)) / hsl(var(--border)) は --card(rgba) / --border(hex/oklch)
                // という完成値を hsl() でさらに包む無効なCSSで、背景・枠線が透明になっていた。
                // 完成値の変数はそのまま使う（/analytics と同じ修正方針）。
                contentStyle={{
                  backgroundColor: "var(--popover)",
                  color: "var(--popover-foreground)",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  fontSize: "12px",
                  padding: "8px 12px",
                  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.18)",
                }}
                labelStyle={{ color: "var(--popover-foreground)", fontWeight: "bold" }}
                wrapperStyle={{ zIndex: 50, outline: "none" }}
                allowEscapeViewBox={{ x: true, y: true }}
                cursor={{ fill: "var(--muted)", opacity: 0.35 }}
                // 縦位置を上部に固定し、下から伸びるバーと重ならないようにする
                position={{ y: 0 }}
                offset={16}
                formatter={(value) => [`${value} 件`, "登録数"]}
              />
              <Bar
                dataKey="count"
                fill="hsl(var(--primary))"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}
