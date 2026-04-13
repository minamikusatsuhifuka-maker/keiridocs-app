import { AlertCircle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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

// 支払期日が近い書類TOP5（期日まで7日以内は赤）
export function DueAlerts({ documents }: DueAlertsProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle
          className="flex items-center gap-2 text-base"
          style={{ color: "#3A2D20" }}
        >
          <AlertCircle className="size-5" style={{ color: "#A0703A" }} />
          支払期日が近い書類 TOP5
        </CardTitle>
      </CardHeader>
      <CardContent>
        {documents.length === 0 ? (
          <p className="py-6 text-center text-sm text-[#9A8070]">
            期限間近の書類はありません
          </p>
        ) : (
          <div className="space-y-2">
            {documents.map((doc) => {
              const daysLeft = differenceInDays(
                new Date(doc.due_date),
                new Date()
              )
              const isUrgent = daysLeft <= 7
              return (
                <div
                  key={doc.id}
                  className="flex items-center justify-between rounded-lg border p-3 transition-colors"
                  style={{
                    borderColor: isUrgent ? "#FCA5A5" : "#E0CEB8",
                    backgroundColor: isUrgent
                      ? "rgba(254, 226, 226, 0.5)"
                      : "rgba(255, 255, 255, 0.4)",
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="truncate text-sm font-medium"
                        style={{ color: "#3A2D20" }}
                      >
                        {doc.vendor_name || "—"}
                      </span>
                      <span
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                        style={{
                          backgroundColor: "#F0E0C8",
                          color: "#A0703A",
                        }}
                      >
                        {doc.type}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-[#9A8070]">
                      期限: {format(new Date(doc.due_date), "yyyy/MM/dd")}
                    </div>
                  </div>
                  <div className="ml-4 text-right">
                    {doc.amount !== null && (
                      <div
                        className="text-sm font-semibold"
                        style={{ color: "#3A2D20" }}
                      >
                        ¥{doc.amount.toLocaleString()}
                      </div>
                    )}
                    <div
                      className="mt-0.5 text-xs font-medium"
                      style={{
                        color: isUrgent ? "#B91C1C" : "#9A8070",
                      }}
                    >
                      {daysLeft < 0
                        ? `${Math.abs(daysLeft)}日超過`
                        : daysLeft === 0
                        ? "本日期限"
                        : `残り${daysLeft}日`}
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
