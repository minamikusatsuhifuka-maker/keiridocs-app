"use client"

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface WeeklyData {
  week: string
  amount: number
}

interface WeeklyBarChartProps {
  data: WeeklyData[]
}

// 週別経費推移の棒グラフ
export function WeeklyBarChart({ data }: WeeklyBarChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base" style={{ color: "#3A2D20" }}>
          週別経費推移（直近6週）
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="py-12 text-center text-sm text-[#9A8070]">
            データがありません
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart
              data={data}
              margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="weeklyBarGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#D4A860" stopOpacity={1} />
                  <stop offset="100%" stopColor="#C090C0" stopOpacity={0.8} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#E0CEB8"
                vertical={false}
              />
              <XAxis
                dataKey="week"
                tick={{ fontSize: 11, fill: "#9A8070" }}
                stroke="#E0CEB8"
              />
              <YAxis
                tick={{ fontSize: 11, fill: "#9A8070" }}
                stroke="#E0CEB8"
                tickFormatter={(v: number) =>
                  v >= 10000 ? `${(v / 10000).toFixed(0)}万` : `${v}`
                }
              />
              <Tooltip
                cursor={{ fill: "rgba(212, 168, 96, 0.2)" }}
                // 背景を完全不透明にし、常に最前面・グラフ領域外にはみ出しても
                // クリップされないようにする（/analytics と同じ修正方針で統一）
                contentStyle={{
                  backgroundColor: "#FFFFFF",
                  color: "#1A1A1A",
                  border: "1px solid #E0CEB8",
                  borderRadius: "8px",
                  fontSize: "12px",
                  padding: "8px 12px",
                  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.18)",
                }}
                wrapperStyle={{ zIndex: 50, outline: "none" }}
                allowEscapeViewBox={{ x: true, y: true }}
                offset={16}
                formatter={(value) => [
                  `¥${(value as number).toLocaleString()}`,
                  "経費合計",
                ]}
              />
              <Bar
                dataKey="amount"
                radius={[8, 8, 0, 0]}
                fill="url(#weeklyBarGradient)"
              >
                {data.map((_, idx) => (
                  <Cell key={idx} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}
