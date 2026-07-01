"use client"

import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface CategoryData {
  name: string
  value: number
}

interface CategoryPieChartProps {
  data: CategoryData[]
}

// Dusk Gold系カラーパレット
const COLORS = [
  "#D4A860",
  "#C090C0",
  "#A0703A",
  "#E0B890",
  "#B894C4",
  "#8A6040",
  "#F0D4B0",
  "#9A7AAA",
]

// カテゴリ別経費の円グラフ
export function CategoryPieChart({ data }: CategoryPieChartProps) {
  const total = data.reduce((sum, d) => sum + d.value, 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base" style={{ color: "#3A2D20" }}>
          カテゴリ別経費（今月）
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 || total === 0 ? (
          <p className="py-12 text-center text-sm text-[#9A8070]">
            データがありません
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, percent }) =>
                  `${name} ${((percent ?? 0) * 100).toFixed(0)}%`
                }
                outerRadius={90}
                innerRadius={40}
                fill="#D4A860"
                dataKey="value"
                stroke="#fff"
                strokeWidth={2}
              >
                {data.map((_, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={COLORS[index % COLORS.length]}
                  />
                ))}
              </Pie>
              <Tooltip
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
                  "金額",
                ]}
              />
              <Legend
                wrapperStyle={{ fontSize: "12px", color: "#3A2D20" }}
              />
            </PieChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}
