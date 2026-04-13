import { FileText, AlertCircle, Banknote, Clock } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"

interface StatsCardsProps {
  monthlyCount: number
  pendingCount: number
  monthlyTotal: number
  dueSoonCount: number
}

// ダッシュボード統計カード（Dusk Goldテーマ）
export function StatsCards({
  monthlyCount,
  pendingCount,
  monthlyTotal,
  dueSoonCount,
}: StatsCardsProps) {
  const cards = [
    {
      title: "今月の経費合計",
      value: `¥${monthlyTotal.toLocaleString()}`,
      icon: Banknote,
      description: "今月登録された書類の合計",
      highlight: false,
    },
    {
      title: "今月の登録件数",
      value: `${monthlyCount} 件`,
      icon: FileText,
      description: "今月登録された書類",
      highlight: false,
    },
    {
      title: "未処理件数",
      value: `${pendingCount} 件`,
      icon: AlertCircle,
      description: "処理待ちの書類",
      highlight: pendingCount > 0,
    },
    {
      title: "支払期限間近",
      value: `${dueSoonCount} 件`,
      icon: Clock,
      description: "7日以内に期限到来",
      highlight: false,
    },
  ]

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon
        return (
          <Card key={card.title} className="relative overflow-hidden">
            <CardContent className="p-5">
              <div className="flex items-start justify-between">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-[#9A8070]">
                    {card.title}
                  </p>
                  <p
                    className="mt-2 text-2xl font-bold"
                    style={{ color: "#3A2D20" }}
                  >
                    {card.value}
                  </p>
                  <p className="mt-1 text-xs text-[#9A8070]">
                    {card.description}
                  </p>
                </div>
                <div
                  className="flex size-10 shrink-0 items-center justify-center rounded-xl"
                  style={{
                    background:
                      "linear-gradient(135deg, #D4A860, #C090C0)",
                  }}
                >
                  <Icon className="size-5 text-white" />
                </div>
              </div>
              {card.highlight && (
                <span className="absolute -right-1 -top-1 flex size-3">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-75"></span>
                  <span className="relative inline-flex size-3 rounded-full bg-red-500"></span>
                </span>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
