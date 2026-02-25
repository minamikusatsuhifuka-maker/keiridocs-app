import { AlertCircle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { format, differenceInDays } from "date-fns"

interface DueDocument {
  id: string
  vendor_name: string
  amount: number | null
  due_date: string
  type: string
}

interface DueAlertsProps {
  documents: DueDocument[]
}

// 支払期限アラート一覧（3日以内の書類）
export function DueAlerts({ documents }: DueAlertsProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertCircle className="h-5 w-5 text-destructive" />
          支払期限アラート
        </CardTitle>
      </CardHeader>
      <CardContent>
        {documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            期限間近の書類はありません
          </p>
        ) : (
          <div className="space-y-3">
            {documents.map((doc) => {
              const daysLeft = differenceInDays(
                new Date(doc.due_date),
                new Date()
              )
              return (
                <div
                  key={doc.id}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {doc.vendor_name}
                      </span>
                      <Badge variant="outline" className="shrink-0 text-xs">
                        {doc.type}
                      </Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      期限: {format(new Date(doc.due_date), "yyyy/MM/dd")}
                    </div>
                  </div>
                  <div className="ml-4 text-right">
                    {doc.amount !== null && (
                      <div className="text-sm font-medium">
                        ¥{doc.amount.toLocaleString()}
                      </div>
                    )}
                    <Badge
                      variant={daysLeft <= 1 ? "destructive" : "secondary"}
                      className="text-xs"
                    >
                      {daysLeft <= 0 ? "本日期限" : `残り${daysLeft}日`}
                    </Badge>
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
