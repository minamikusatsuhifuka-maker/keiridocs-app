import { Users } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export interface StaffStatus {
  id: string
  name: string
  count: number
}

interface StaffStatusCardProps {
  staff: StaffStatus[]
}

// 信号機カラー（緑=提出済み3件以上, 黄=1-2件, 赤=未提出）
function getStatusColor(count: number): {
  bg: string
  border: string
  text: string
  label: string
} {
  if (count >= 3) {
    return {
      bg: "#DCFCE7",
      border: "#86EFAC",
      text: "#15803D",
      label: "提出済み",
    }
  }
  if (count >= 1) {
    return {
      bg: "#FEF9C3",
      border: "#FDE047",
      text: "#A16207",
      label: "一部提出",
    }
  }
  return {
    bg: "#FEE2E2",
    border: "#FCA5A5",
    text: "#B91C1C",
    label: "未提出",
  }
}

// スタッフ別領収書提出状況（信号機カラー）
export function StaffStatusCard({ staff }: StaffStatusCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle
          className="flex items-center gap-2 text-base"
          style={{ color: "#3A2D20" }}
        >
          <Users className="size-5" style={{ color: "#A0703A" }} />
          スタッフ別 領収書提出状況（今月）
        </CardTitle>
      </CardHeader>
      <CardContent>
        {staff.length === 0 ? (
          <p className="py-6 text-center text-sm text-[#9A8070]">
            スタッフが登録されていません
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {staff.map((s) => {
              const color = getStatusColor(s.count)
              return (
                <div
                  key={s.id}
                  className="flex items-center justify-between rounded-lg border-2 p-3"
                  style={{
                    backgroundColor: color.bg,
                    borderColor: color.border,
                  }}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="block size-3 rounded-full shadow-sm"
                      style={{ backgroundColor: color.text }}
                    />
                    <span
                      className="text-sm font-medium"
                      style={{ color: "#3A2D20" }}
                    >
                      {s.name}
                    </span>
                  </div>
                  <div className="text-right">
                    <div
                      className="text-sm font-bold"
                      style={{ color: color.text }}
                    >
                      {s.count}件
                    </div>
                    <div
                      className="text-[10px]"
                      style={{ color: color.text }}
                    >
                      {color.label}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
