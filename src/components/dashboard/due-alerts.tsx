"use client"

import { useState } from "react"
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Wallet,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { format, differenceInDays } from "date-fns"
import { toast } from "sonner"

// カードの表示ステータス（3値）
type CardStatus = "未処理" | "処理済み" | "支払済み"

interface DueDocument {
  id: string
  vendor_name: string
  amount: number | null
  due_date: string
  type: string
  status?: string
  payment_status?: string
}

interface DueAlertsProps {
  documents: DueDocument[]
}

// ドキュメントの status + payment_status から3値のカードステータスを算出
function toCardStatus(doc: DueDocument): CardStatus {
  if ((doc.payment_status ?? "") === "支払い済み") return "支払済み"
  if ((doc.status ?? "未処理") === "処理済み") return "処理済み"
  return "未処理"
}

// カードステータスごとの配色
function getStyle(cardStatus: CardStatus) {
  switch (cardStatus) {
    case "未処理":
      return {
        borderColor: "#DC2626",
        bgColor: "rgba(254, 226, 226, 0.7)", // 赤背景
        accentColor: "#DC2626",
        badgeBg: "#DC2626",
        badgeFg: "#FFFFFF",
        badgeLabel: "⚠️ 未処理",
      }
    case "処理済み":
      return {
        borderColor: "#F59E0B",
        bgColor: "rgba(254, 243, 199, 0.75)", // 黄背景
        accentColor: "#B45309",
        badgeBg: "#F59E0B",
        badgeFg: "#FFFFFF",
        badgeLabel: "📝 処理済み",
      }
    case "支払済み":
      return {
        borderColor: "#059669",
        bgColor: "rgba(209, 250, 229, 0.75)", // 緑背景
        accentColor: "#047857",
        badgeBg: "#059669",
        badgeFg: "#FFFFFF",
        badgeLabel: "✅ 支払済み",
      }
  }
}

// 支払期日が近い書類TOP5
export function DueAlerts({ documents }: DueAlertsProps) {
  // ローカル状態で即時反映
  const [items, setItems] = useState<DueDocument[]>(documents)
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  // ステータスを変更（3値 → DBフィールドへマッピング）
  async function handleChangeStatus(doc: DueDocument, newStatus: CardStatus) {
    if (toCardStatus(doc) === newStatus) return

    // 3値を status + payment_status にマッピング
    const body: Record<string, string> =
      newStatus === "未処理"
        ? { status: "未処理", payment_status: "未対応" }
        : newStatus === "処理済み"
        ? { status: "処理済み", payment_status: "未対応" }
        : { status: "処理済み", payment_status: "支払い済み" }

    setUpdatingId(doc.id)
    try {
      const res = await fetch(`/api/documents?id=${doc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error ?? "ステータスの更新に失敗しました")
      }
      setItems((prev) =>
        prev.map((d) =>
          d.id === doc.id
            ? { ...d, status: body.status, payment_status: body.payment_status }
            : d
        )
      )
      toast.success(`「${newStatus}」に変更しました`)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "ステータスの更新に失敗しました"
      )
    } finally {
      setUpdatingId(null)
    }
  }

  // 支払済みを下、未処理・処理済みを上に。同グループ内は期日昇順
  const sorted = [...items].sort((a, b) => {
    const aPaid = toCardStatus(a) === "支払済み" ? 1 : 0
    const bPaid = toCardStatus(b) === "支払済み" ? 1 : 0
    if (aPaid !== bPaid) return aPaid - bPaid
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
              const cardStatus = toCardStatus(doc)
              const style = getStyle(cardStatus)
              const isPaid = cardStatus === "支払済み"
              const isUpdating = updatingId === doc.id

              // 期日当日・超過は「期日超過」と表示
              const dueLabel =
                daysLeft <= 0 ? "期日超過" : `残り${daysLeft}日`

              // 未支払い（未処理・処理済み）は金額・残り日数を赤字強調
              const isUnpaid = !isPaid
              const amountClass = isUnpaid
                ? "text-red-600 text-sm font-bold"
                : "text-sm font-bold"
              const dueClass = isUnpaid
                ? "text-red-600 mt-0.5 text-xs font-bold"
                : "mt-0.5 text-xs font-semibold"

              return (
                <DropdownMenu key={doc.id}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      disabled={isUpdating}
                      className="w-full rounded-lg border p-3 text-left transition-colors hover:opacity-90"
                      style={{
                        borderColor: style.borderColor,
                        borderWidth: "2px",
                        backgroundColor: style.bgColor,
                        opacity: isPaid ? 0.85 : 1,
                        cursor: isUpdating ? "wait" : "pointer",
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className="truncate text-sm font-medium"
                              style={{
                                color: "#1A1A1A",
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
                            <span
                              className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                              style={{
                                backgroundColor: style.badgeBg,
                                color: style.badgeFg,
                              }}
                            >
                              {style.badgeLabel}
                            </span>
                          </div>
                          <div
                            className="mt-0.5 text-xs"
                            style={{
                              color: isUnpaid ? "#DC2626" : "#6B7280",
                              fontWeight: isUnpaid ? 600 : 400,
                            }}
                          >
                            期限: {format(new Date(doc.due_date), "yyyy/MM/dd")}
                          </div>
                        </div>
                        <div className="ml-2 flex items-center gap-2">
                          <div className="text-right">
                            {doc.amount !== null && (
                              <div
                                className={amountClass}
                                style={{
                                  textDecoration: isPaid
                                    ? "line-through"
                                    : "none",
                                  color: isPaid ? "#6B7280" : undefined,
                                }}
                              >
                                ¥{doc.amount.toLocaleString()}
                              </div>
                            )}
                            <div
                              className={dueClass}
                              style={{ color: isPaid ? "#6B7280" : undefined }}
                            >
                              {dueLabel}
                            </div>
                          </div>
                          {isUpdating ? (
                            <Loader2
                              className="size-4 animate-spin"
                              style={{ color: "#6B7280" }}
                            />
                          ) : (
                            <ChevronDown
                              className="size-4"
                              style={{ color: "#6B7280" }}
                            />
                          )}
                        </div>
                      </div>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => handleChangeStatus(doc, "未処理")}
                      disabled={cardStatus === "未処理"}
                    >
                      <AlertTriangle className="mr-2 size-4 text-red-600" />
                      未処理にする
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => handleChangeStatus(doc, "処理済み")}
                      disabled={cardStatus === "処理済み"}
                    >
                      <CheckCircle2 className="mr-2 size-4 text-amber-600" />
                      処理済みにする
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => handleChangeStatus(doc, "支払済み")}
                      disabled={cardStatus === "支払済み"}
                    >
                      <Wallet className="mr-2 size-4 text-emerald-600" />
                      支払済みにする
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
