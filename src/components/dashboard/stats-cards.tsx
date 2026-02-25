import { FileText, AlertCircle, Banknote, Clock } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface StatsCardsProps {
  monthlyCount: number
  pendingCount: number
  monthlyTotal: number
  dueSoonCount: number
}

// ダッシュボード統計カード4枚
export function StatsCards({
  monthlyCount,
  pendingCount,
  monthlyTotal,
  dueSoonCount,
}: StatsCardsProps) {
  const cards = [
    {
      title: "今月の登録数",
      value: `${monthlyCount} 件`,
      icon: FileText,
      description: "今月登録された書類",
    },
    {
      title: "未処理件数",
      value: `${pendingCount} 件`,
      icon: AlertCircle,
      description: "処理待ちの書類",
    },
    {
      title: "今月の合計金額",
      value: `¥${monthlyTotal.toLocaleString()}`,
      icon: Banknote,
      description: "今月登録された書類の合計",
    },
    {
      title: "支払期限間近",
      value: `${dueSoonCount} 件`,
      icon: Clock,
      description: "3日以内に期限到来",
    },
  ]

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon
        return (
          <Card key={card.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">
                {card.title}
              </CardTitle>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{card.value}</div>
              <p className="text-xs text-muted-foreground">
                {card.description}
              </p>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
