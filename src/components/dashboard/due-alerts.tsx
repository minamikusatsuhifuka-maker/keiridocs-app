"use client"

import { useState } from "react"
import Link from "next/link"
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
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

// カードの表示ステータス（3値）。ステータス管理は廃止し、
// 要振込マーク（status="要振込"）と支払状態（payment_status）から表示を導出する
type CardStatus = "要振込" | "未払い" | "支払済み"

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

// ドキュメントの要振込マーク + payment_status から3値のカードステータスを算出
function toCardStatus(doc: DueDocument): CardStatus {
  if ((doc.payment_status ?? "") === "支払い済み") return "支払済み"
  if ((doc.status ?? "") === "要振込") return "要振込"
  return "未払い"
}

// カードステータスごとの配色
function getStyle(cardStatus: CardStatus) {
  switch (cardStatus) {
    case "要振込":
      return {
        borderColor: "#DC2626",
        bgColor: "rgba(254, 226, 226, 0.7)", // 赤背景
        accentColor: "#DC2626",
        badgeBg: "#DC2626",
        badgeFg: "#FFFFFF",
        badgeLabel: "⚠️ 要振込",
      }
    case "未払い":
      return {
        borderColor: "#F59E0B",
        bgColor: "rgba(254, 243, 199, 0.75)", // 黄背景
        accentColor: "#B45309",
        badgeBg: "#F59E0B",
        badgeFg: "#FFFFFF",
        badgeLabel: "📝 未払い",
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

  // 支払状態を変更（要振込マークの遷移はサーバー側 payment-status API が自動で行う）
  async function handleChangePayment(doc: DueDocument, paid: boolean) {
    const next = paid ? "支払い済み" : "未対応"
    if ((doc.payment_status ?? "未対応") === next) return

    setUpdatingId(doc.id)
    try {
      const res = await fetch(`/api/documents/${doc.id}/payment-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payment_status: next }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        data?: { status?: string; payment_status?: string }
        error?: string
      }
      if (!res.ok) {
        throw new Error(json.error ?? "支払状態の更新に失敗しました")
      }
      setItems((prev) =>
        prev.map((d) =>
          d.id === doc.id
            ? {
                ...d,
                payment_status: json.data?.payment_status ?? next,
                status: json.data?.status ?? d.status,
              }
            : d
        )
      )
      toast.success(paid ? "支払済みにしました" : "未払いに戻しました")
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "支払状態の更新に失敗しました"
      )
    } finally {
      setUpdatingId(null)
    }
  }

  // 支払済みを下、未払い（要振込含む）を上に。同グループ内は期日昇順
  const sorted = [...items].sort((a, b) => {
    const aPaid = toCardStatus(a) === "支払済み" ? 1 : 0
    const bPaid = toCardStatus(b) === "支払済み" ? 1 : 0
    if (aPaid !== bPaid) return aPaid - bPaid
    return new Date(a.due_date).getTime() - new Date(b.due_date).getTime()
  })

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle
            className="flex items-center gap-2 text-base"
            style={{ color: "#1A1A1A" }}
          >
            <AlertCircle className="size-5" style={{ color: "#DC2626" }} />
            支払期日が近い書類 TOP5
          </CardTitle>
          {/* 要振込の支払管理ページへの導線 */}
          <Link
            href="/payments"
            className="flex shrink-0 items-center gap-0.5 text-xs font-semibold hover:underline"
            style={{ color: "#B8782A" }}
          >
            <Wallet className="size-3.5" />
            支払管理へ
            <ChevronRight className="size-3.5" />
          </Link>
        </div>
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

              // 未支払い（要振込・未払い）は金額・残り日数を赤字強調
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
                      onClick={() => handleChangePayment(doc, true)}
                      disabled={cardStatus === "支払済み"}
                    >
                      <Wallet className="mr-2 size-4 text-emerald-600" />
                      支払済みにする
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => handleChangePayment(doc, false)}
                      disabled={cardStatus !== "支払済み"}
                    >
                      <AlertTriangle className="mr-2 size-4 text-amber-600" />
                      未払いに戻す
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
