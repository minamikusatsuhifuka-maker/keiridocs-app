"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import {
  Wallet,
  AlertTriangle,
  CheckCircle2,
  RotateCcw,
  Loader2,
  Landmark,
  HelpCircle,
  ExternalLink,
  RefreshCw,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { format, differenceInDays } from "date-fns"
import { toast } from "sonner"
import type { BankInfo } from "@/lib/gemini"

/** 支払管理ページで扱う書類（要振込の請求書） */
export interface PaymentDoc {
  id: string
  vendor_name: string
  amount: number | null
  due_date: string | null
  payment_method: string
  bank_info: BankInfo | null
  payment_status: string
}

interface PaymentsClientProps {
  documents: PaymentDoc[]
}

/** 振込先情報を1行の文字列に整形する */
function formatBankInfo(info: BankInfo | null): string {
  if (!info) return ""
  const parts = [
    info.bank_name,
    info.branch_name,
    info.account_type,
    info.account_number,
    info.account_holder,
  ].filter((v) => v && v.trim() !== "")
  return parts.join(" ")
}

/** 支払方法バッジの見た目 */
function methodBadge(method: string): { label: string; bg: string; fg: string; icon: typeof Landmark } {
  if (method === "bank_transfer") {
    return { label: "🏦 振込", bg: "#E8D5A8", fg: "#8A5A1A", icon: Landmark }
  }
  // unknown（NULL含む）
  return { label: "❓ 要確認", bg: "#FEF3C7", fg: "#B45309", icon: HelpCircle }
}

export function PaymentsClient({ documents }: PaymentsClientProps) {
  const [items, setItems] = useState<PaymentDoc[]>(documents)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [reanalyzingId, setReanalyzingId] = useState<string | null>(null)

  // 未払い（支払い済み以外）と支払済みに分け、未払いは支払期限が近い順に並べる
  const sorted = useMemo(() => {
    return [...items].sort((a, b) => {
      const aPaid = a.payment_status === "支払い済み" ? 1 : 0
      const bPaid = b.payment_status === "支払い済み" ? 1 : 0
      if (aPaid !== bPaid) return aPaid - bPaid
      // 期日なしは後ろ
      if (!a.due_date && !b.due_date) return 0
      if (!a.due_date) return 1
      if (!b.due_date) return -1
      return new Date(a.due_date).getTime() - new Date(b.due_date).getTime()
    })
  }, [items])

  // 未払い金額の合計（支払い済み以外を合算）
  const unpaidTotal = useMemo(
    () =>
      items
        .filter((d) => d.payment_status !== "支払い済み")
        .reduce((sum, d) => sum + (d.amount ?? 0), 0),
    [items]
  )
  const unpaidCount = items.filter((d) => d.payment_status !== "支払い済み").length

  // 支払状態を切り替え（未払い⇄支払済み）
  async function togglePaid(doc: PaymentDoc) {
    const next = doc.payment_status === "支払い済み" ? "未対応" : "支払い済み"
    setUpdatingId(doc.id)
    try {
      const res = await fetch(`/api/documents/${doc.id}/payment-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payment_status: next }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error ?? "支払状態の更新に失敗しました")
      }
      setItems((prev) =>
        prev.map((d) => (d.id === doc.id ? { ...d, payment_status: next } : d))
      )
      toast.success(next === "支払い済み" ? "支払済みにしました" : "未払いに戻しました")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "支払状態の更新に失敗しました")
    } finally {
      setUpdatingId(null)
    }
  }

  // 不明な書類を再解析して支払方法・振込先を判定し直す
  async function reanalyze(doc: PaymentDoc) {
    setReanalyzingId(doc.id)
    try {
      const res = await fetch(`/api/documents/${doc.id}/reanalyze`, { method: "POST" })
      const json = (await res.json().catch(() => ({}))) as {
        data?: { payment_method?: string | null; bank_info?: BankInfo | null }
        error?: string
        reason?: string
      }
      if (!res.ok) {
        throw new Error(json.error ?? "再解析に失敗しました")
      }
      const newMethod = json.data?.payment_method ?? "unknown"
      const newBank = (json.data?.bank_info as BankInfo | null) ?? null

      // 自動引落し・カード払いと判定されたら支払管理の対象外なので一覧から除外
      if (newMethod === "auto_debit" || newMethod === "credit_card") {
        setItems((prev) => prev.filter((d) => d.id !== doc.id))
        toast.success("自動引落し／カード払いと判定されました（支払管理から除外）")
        return
      }
      setItems((prev) =>
        prev.map((d) =>
          d.id === doc.id ? { ...d, payment_method: newMethod, bank_info: newBank } : d
        )
      )
      toast.success(newMethod === "bank_transfer" ? "振込が必要と判定されました" : "再解析しました")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "再解析に失敗しました")
    } finally {
      setReanalyzingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: "#1A1A1A" }}>
          <Wallet className="size-6" style={{ color: "#B8782A" }} />
          支払管理
        </h1>
        <p className="mt-1 text-sm" style={{ color: "#4A4A4A" }}>
          自分で振込が必要な請求書の支払期限・振込先・未払いを管理します（自動引落し・カード払いは除外）
        </p>
      </div>

      {/* 未払い金額の合計 */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-5">
          <div>
            <div className="text-sm" style={{ color: "#4A4A4A" }}>
              未払い合計（要振込）
            </div>
            <div className="mt-1 text-3xl font-bold" style={{ color: "#B8782A" }}>
              ¥{unpaidTotal.toLocaleString()}
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm" style={{ color: "#4A4A4A" }}>
              未払い件数
            </div>
            <div className="mt-1 text-2xl font-bold" style={{ color: "#1A1A1A" }}>
              {unpaidCount}件
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 一覧 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base" style={{ color: "#1A1A1A" }}>
            <Landmark className="size-5" style={{ color: "#B8782A" }} />
            要振込の請求書（支払期限が近い順）
          </CardTitle>
        </CardHeader>
        <CardContent>
          {sorted.length === 0 ? (
            <p className="py-10 text-center text-sm" style={{ color: "#4A4A4A" }}>
              要振込の請求書はありません
            </p>
          ) : (
            <div className="space-y-3">
              {sorted.map((doc) => {
                const isPaid = doc.payment_status === "支払い済み"
                const isUpdating = updatingId === doc.id
                const isReanalyzing = reanalyzingId === doc.id
                const isUnknown = doc.payment_method !== "bank_transfer"
                const badge = methodBadge(doc.payment_method)
                const bankText = formatBankInfo(doc.bank_info)

                // 支払期限の状態（未払いのみ強調）
                const daysLeft = doc.due_date
                  ? differenceInDays(new Date(doc.due_date), new Date())
                  : null
                const isOverdue = !isPaid && daysLeft !== null && daysLeft < 0
                const isSoon = !isPaid && daysLeft !== null && daysLeft >= 0 && daysLeft <= 3

                // 期限の配色
                const dueColor = isPaid
                  ? "#6B7280"
                  : isOverdue
                  ? "#DC2626"
                  : isSoon
                  ? "#D97706"
                  : "#4A4A4A"

                return (
                  <div
                    key={doc.id}
                    className="rounded-lg border p-4"
                    style={{
                      borderColor: isOverdue ? "#DC2626" : isSoon ? "#F59E0B" : "#E5DCC8",
                      borderWidth: isOverdue || isSoon ? "2px" : "1px",
                      backgroundColor: isPaid
                        ? "rgba(243,244,246,0.6)"
                        : isOverdue
                        ? "rgba(254,226,226,0.5)"
                        : isSoon
                        ? "rgba(254,243,199,0.5)"
                        : "#FFFFFF",
                      opacity: isPaid ? 0.85 : 1,
                    }}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      {/* 左：取引先・バッジ・期限・振込先 */}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className="truncate text-sm font-semibold"
                            style={{
                              color: "#1A1A1A",
                              textDecoration: isPaid ? "line-through" : "none",
                            }}
                          >
                            {doc.vendor_name || "（取引先不明）"}
                          </span>
                          {/* 支払方法バッジ */}
                          <span
                            className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                            style={{ backgroundColor: badge.bg, color: badge.fg }}
                          >
                            {badge.label}
                          </span>
                          {/* 状態バッジ */}
                          <span
                            className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                            style={
                              isPaid
                                ? { backgroundColor: "#059669", color: "#FFFFFF" }
                                : { backgroundColor: "#DC2626", color: "#FFFFFF" }
                            }
                          >
                            {isPaid ? "✅ 支払済み" : "⚠️ 未払い"}
                          </span>
                        </div>

                        {/* 支払期限 */}
                        <div
                          className="mt-1.5 flex items-center gap-1.5 text-xs"
                          style={{ color: dueColor, fontWeight: isOverdue || isSoon ? 700 : 500 }}
                        >
                          {(isOverdue || isSoon) && <AlertTriangle className="size-3.5" />}
                          支払期限:{" "}
                          {doc.due_date
                            ? format(new Date(doc.due_date), "yyyy/MM/dd")
                            : "未設定"}
                          {!isPaid && daysLeft !== null && (
                            <span>
                              （{daysLeft < 0 ? `${Math.abs(daysLeft)}日超過` : daysLeft === 0 ? "本日" : `残り${daysLeft}日`}）
                            </span>
                          )}
                        </div>

                        {/* 振込先 */}
                        {doc.payment_method === "bank_transfer" && (
                          <div
                            className="mt-1.5 rounded-md px-2.5 py-1.5 text-xs"
                            style={{ backgroundColor: "#FAF6EC", color: "#5A4A30" }}
                          >
                            <span className="font-semibold">振込先: </span>
                            {bankText || "（振込先情報なし。書類を再解析または詳細で確認してください）"}
                          </div>
                        )}

                        {/* 不明の注意表示 + 導線 */}
                        {isUnknown && (
                          <div
                            className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md px-2.5 py-1.5 text-xs"
                            style={{ backgroundColor: "#FEF3C7", color: "#92400E" }}
                          >
                            <span className="flex items-center gap-1 font-semibold">
                              <HelpCircle className="size-3.5" />
                              支払方法が未確定です
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-[11px]"
                              disabled={isReanalyzing}
                              onClick={() => reanalyze(doc)}
                            >
                              {isReanalyzing ? (
                                <Loader2 className="mr-1 size-3 animate-spin" />
                              ) : (
                                <RefreshCw className="mr-1 size-3" />
                              )}
                              再解析で判定
                            </Button>
                            <Link
                              href={`/documents/${doc.id}`}
                              className="flex items-center gap-1 underline"
                            >
                              <ExternalLink className="size-3" />
                              詳細で確認
                            </Link>
                          </div>
                        )}
                      </div>

                      {/* 右：金額・支払い完了ボタン */}
                      <div className="flex flex-col items-end gap-2">
                        {doc.amount !== null && (
                          <div
                            className="text-lg font-bold"
                            style={{
                              color: isPaid ? "#6B7280" : "#1A1A1A",
                              textDecoration: isPaid ? "line-through" : "none",
                            }}
                          >
                            ¥{doc.amount.toLocaleString()}
                          </div>
                        )}
                        {isPaid ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={isUpdating}
                            onClick={() => togglePaid(doc)}
                          >
                            {isUpdating ? (
                              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                            ) : (
                              <RotateCcw className="mr-1.5 size-3.5" />
                            )}
                            未払いに戻す
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            disabled={isUpdating}
                            onClick={() => togglePaid(doc)}
                            style={{
                              background: "linear-gradient(135deg, #C8922A, #B8782A)",
                              color: "#fff",
                              boxShadow: "0 4px 12px rgba(180,120,40,0.35)",
                            }}
                          >
                            {isUpdating ? (
                              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                            ) : (
                              <CheckCircle2 className="mr-1.5 size-3.5" />
                            )}
                            支払い完了
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
