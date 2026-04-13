"use client"

import { useState } from "react"
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, Loader2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { format, differenceInDays } from "date-fns"
import { toast } from "sonner"

type PaymentStatus = "未対応" | "支払い済み"

interface DueDocument {
  id: string
  vendor_name: string
  amount: number | null
  due_date: string
  type: string
  payment_status?: string
}

interface DueAlertsProps {
  documents: DueDocument[]
}

// 支払期日が近い書類TOP5（未対応は上部・支払済は下部）
export function DueAlerts({ documents }: DueAlertsProps) {
  // ローカル状態で即時反映
  const [items, setItems] = useState<DueDocument[]>(documents)
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  // 支払ステータスを変更
  async function handleChangeStatus(doc: DueDocument, newStatus: PaymentStatus) {
    if ((doc.payment_status ?? "未対応") === newStatus) return
    setUpdatingId(doc.id)
    try {
      const res = await fetch(`/api/documents?id=${doc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payment_status: newStatus }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error ?? "支払ステータスの更新に失敗しました")
      }
      setItems((prev) =>
        prev.map((d) => (d.id === doc.id ? { ...d, payment_status: newStatus } : d))
      )
      toast.success(`「${newStatus}」に変更しました`)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "支払ステータスの更新に失敗しました"
      )
    } finally {
      setUpdatingId(null)
    }
  }

  // 未対応を上、支払済を下にソート
  const sorted = [...items].sort((a, b) => {
    const ap = (a.payment_status ?? "未対応") === "支払い済み" ? 1 : 0
    const bp = (b.payment_status ?? "未対応") === "支払い済み" ? 1 : 0
    if (ap !== bp) return ap - bp
    return new Date(a.due_date).getTime() - new Date(b.due_date).getTime()
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle
          className="flex items-center gap-2 text-base"
          style={{ color: "#1A1A1A" }}
        >
          <AlertCircle className="size-5" style={{ color: "#DC2626" }} />
          支払期日が近い書類 TOP5
        </CardTitle>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="py-6 text-center text-sm" style={{ color: "#4A4A4A" }}>
            期限間近の書類はありません
          </p>
        ) : (
          <div className="space-y-2">
            {sorted.map((doc) => {
              const daysLeft = differenceInDays(
                new Date(doc.due_date),
                new Date()
              )
              const status: PaymentStatus =
                (doc.payment_status as PaymentStatus) ?? "未対応"
              const isPaid = status === "支払い済み"
              const isUpdating = updatingId === doc.id

              // 未対応=赤系 / 支払済=グレーアウト
              const borderColor = isPaid ? "#D1D5DB" : "#DC2626"
              const bgColor = isPaid
                ? "rgba(243, 244, 246, 0.7)"
                : "rgba(254, 226, 226, 0.55)"
              const textColor = isPaid ? "#6B7280" : "#1A1A1A"
              const amountColor = isPaid ? "#9CA3AF" : "#DC2626"
              const dueTextColor = isPaid ? "#9CA3AF" : "#DC2626"

              return (
                <DropdownMenu key={doc.id}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      disabled={isUpdating}
                      className="w-full rounded-lg border p-3 text-left transition-colors hover:opacity-90"
                      style={{
                        borderColor,
                        borderWidth: isPaid ? "1px" : "2px",
                        backgroundColor: bgColor,
                        opacity: isPaid ? 0.7 : 1,
                        cursor: isUpdating ? "wait" : "pointer",
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className="truncate text-sm font-medium"
                              style={{
                                color: textColor,
                                textDecoration: isPaid ? "line-through" : "none",
                              }}
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
                            {isPaid ? (
                              <span
                                className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                                style={{
                                  backgroundColor: "#E5E7EB",
                                  color: "#374151",
                                }}
                              >
                                ✅ 支払済
                              </span>
                            ) : (
                              <span
                                className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                                style={{
                                  backgroundColor: "#DC2626",
                                  color: "#FFFFFF",
                                }}
                              >
                                ⚠️ 未対応
                              </span>
                            )}
                          </div>
                          <div
                            className="mt-0.5 text-xs"
                            style={{ color: dueTextColor }}
                          >
                            期限: {format(new Date(doc.due_date), "yyyy/MM/dd")}
                          </div>
                        </div>
                        <div className="ml-2 flex items-center gap-2">
                          <div className="text-right">
                            {doc.amount !== null && (
                              <div
                                className="text-sm font-bold"
                                style={{
                                  color: amountColor,
                                  textDecoration: isPaid ? "line-through" : "none",
                                }}
                              >
                                ¥{doc.amount.toLocaleString()}
                              </div>
                            )}
                            <div
                              className="mt-0.5 text-xs font-semibold"
                              style={{ color: dueTextColor }}
                            >
                              {daysLeft < 0
                                ? `${Math.abs(daysLeft)}日超過`
                                : daysLeft === 0
                                ? "本日期限"
                                : `残り${daysLeft}日`}
                            </div>
                          </div>
                          {isUpdating ? (
                            <Loader2 className="size-4 animate-spin" style={{ color: textColor }} />
                          ) : (
                            <ChevronDown className="size-4" style={{ color: textColor }} />
                          )}
                        </div>
                      </div>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => handleChangeStatus(doc, "未対応")}
                      disabled={status === "未対応"}
                    >
                      <AlertTriangle className="mr-2 size-4 text-red-600" />
                      未対応にする
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => handleChangeStatus(doc, "支払い済み")}
                      disabled={status === "支払い済み"}
                    >
                      <CheckCircle2 className="mr-2 size-4 text-gray-600" />
                      支払い済みにする
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
