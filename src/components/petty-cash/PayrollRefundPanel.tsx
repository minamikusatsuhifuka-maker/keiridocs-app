"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, Banknote, ChevronDown, ChevronRight, CheckCircle2 } from "lucide-react"
import { toast } from "sonner"

interface PayrollItem {
  id: string
  amount: number
  note: string | null
  description: string | null
  transaction_date: string | null
  created_at: string
  receipt_urls: string[] | null
}

interface StaffGroup {
  staff_member_id: string | null
  staff_name: string
  total: number
  count: number
  items: PayrollItem[]
}

interface DoneItem extends PayrollItem {
  staff_name: string
  payroll_refunded_at: string | null
}

interface PayrollData {
  pending: StaffGroup[]
  done: DoneItem[]
  pendingTotal: number
}

/**
 * 給与返金待ちの集計パネル
 * @param reloadKey 値が変わると再取得する（親で返金登録した後にインクリメント）
 * @param onChanged 「返金済み」操作後に親へ通知（一覧再取得など）
 */
export function PayrollRefundPanel({
  reloadKey,
  onChanged,
}: {
  reloadKey?: number
  onChanged?: () => void
}) {
  const [data, setData] = useState<PayrollData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showHistory, setShowHistory] = useState(false)
  const [processingKey, setProcessingKey] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch("/api/petty-cash/staff-refund/payroll")
      if (!res.ok) throw new Error("取得失敗")
      const json = (await res.json()) as PayrollData
      setData(json)
    } catch {
      toast.error("給与返金一覧の取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData, reloadKey])

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // スタッフ単位で返金済みにする
  const markStaffDone = async (group: StaffGroup) => {
    if (
      !confirm(
        `「${group.staff_name}」の給与返金 ¥${group.total.toLocaleString()}（${group.count}件）を返金済みにしますか？`
      )
    )
      return
    const key = group.staff_member_id ?? "unknown"
    setProcessingKey(key)
    try {
      const body = group.staff_member_id
        ? { staff_member_id: group.staff_member_id }
        : { ids: group.items.map((i) => i.id) }
      const res = await fetch("/api/petty-cash/staff-refund/payroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error || "更新に失敗しました")
      }
      toast.success(`${group.staff_name} を返金済みにしました`)
      await fetchData()
      onChanged?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "更新に失敗しました")
    } finally {
      setProcessingKey(null)
    }
  }

  const fmtDate = (item: { transaction_date: string | null; created_at: string }) =>
    item.transaction_date
      ? new Date(item.transaction_date).toLocaleDateString("ja-JP")
      : new Date(item.created_at).toLocaleDateString("ja-JP")

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Banknote className="size-5" style={{ color: "var(--dusk-primary)" }} />
          給与返金待ち
          {data && data.pending.length > 0 && (
            <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">
              合計 ¥{data.pendingTotal.toLocaleString()}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : !data || data.pending.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            給与で返金待ちのスタッフ領収書はありません
          </div>
        ) : (
          <div className="space-y-3">
            {data.pending.map((group) => {
              const key = group.staff_member_id ?? "unknown"
              const isOpen = expanded.has(key)
              return (
                <div key={key} className="rounded-lg border">
                  <div className="flex items-center justify-between gap-3 p-3">
                    <button
                      type="button"
                      onClick={() => toggleExpand(key)}
                      className="flex items-center gap-2 text-left"
                    >
                      {isOpen ? (
                        <ChevronDown className="size-4 shrink-0" />
                      ) : (
                        <ChevronRight className="size-4 shrink-0" />
                      )}
                      <span className="font-medium">{group.staff_name}</span>
                      <span className="text-sm text-muted-foreground">
                        {group.count}件
                      </span>
                    </button>
                    <div className="flex items-center gap-3">
                      <span className="tabular-nums font-bold">
                        ¥{group.total.toLocaleString()}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => markStaffDone(group)}
                        disabled={processingKey === key}
                      >
                        {processingKey === key ? (
                          <Loader2 className="mr-1 size-4 animate-spin" />
                        ) : (
                          <CheckCircle2 className="mr-1 size-4" />
                        )}
                        返金済みにする
                      </Button>
                    </div>
                  </div>
                  {isOpen && (
                    <div className="border-t bg-muted/30 px-3 py-2">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-muted-foreground">
                            <th className="py-1 font-medium">日付</th>
                            <th className="py-1 font-medium">内容</th>
                            <th className="py-1 text-right font-medium">金額</th>
                            <th className="py-1 text-right font-medium">領収書</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.items.map((it) => (
                            <tr key={it.id} className="border-t border-border/50">
                              <td className="py-1 whitespace-nowrap">{fmtDate(it)}</td>
                              <td className="py-1">{it.note || it.description || "—"}</td>
                              <td className="py-1 text-right tabular-nums">
                                ¥{it.amount.toLocaleString()}
                              </td>
                              <td className="py-1 text-right text-muted-foreground">
                                {Array.isArray(it.receipt_urls) && it.receipt_urls.length > 0
                                  ? `${it.receipt_urls.length}件`
                                  : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* 返金済み履歴 */}
        {data && data.done.length > 0 && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              {showHistory ? (
                <ChevronDown className="size-4" />
              ) : (
                <ChevronRight className="size-4" />
              )}
              返金済み履歴（{data.done.length}件）
            </button>
            {showHistory && (
              <div className="mt-2 overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50 text-left">
                      <th className="px-3 py-2 font-medium">返金日</th>
                      <th className="px-3 py-2 font-medium">スタッフ</th>
                      <th className="px-3 py-2 font-medium">内容</th>
                      <th className="px-3 py-2 text-right font-medium">金額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.done.map((it) => (
                      <tr key={it.id} className="border-b last:border-0">
                        <td className="px-3 py-2 whitespace-nowrap">
                          {it.payroll_refunded_at
                            ? new Date(it.payroll_refunded_at).toLocaleDateString("ja-JP")
                            : "—"}
                        </td>
                        <td className="px-3 py-2">{it.staff_name}</td>
                        <td className="px-3 py-2">{it.note || it.description || "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          ¥{it.amount.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
