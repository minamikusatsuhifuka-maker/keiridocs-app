"use client"

import { useCallback, useState } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Check, Loader2, Search, Wrench } from "lucide-react"
import {
  CompletePendingDialog,
  type CompleteTarget,
} from "@/components/line-staff/complete-pending-dialog"

/**
 * 「申請したのに見つからない」を調べる画面。
 *
 * 支給の対象にならない理由は複数あり（明細が作られていない、テストスタッフ扱い、
 * テストの印が残っている、確認待ち、取り消し済み）、どれなのかが画面から
 * 分からなかった。ここでは**除外されたものも含めて**全件出し、理由を1件ずつ書く。
 */

interface DiagnoseItem {
  receiptId: string
  staffMemberId: string | null
  staffName: string
  createdAt: string
  date: string | null
  storeName: string | null
  amount: number | null
  settled: boolean
  cancelled: boolean
  expenseDetail: string | null
  holdReason: string | null
  counted: boolean
  reasons: string[]
  fix: "clear_test_mark" | "turn_off_test_staff" | "resume_in_line" | "approve_hold" | "none"
}

const yen = (v: number | null) => (v == null ? "—" : `¥${v.toLocaleString("ja-JP")}`)

const jst = (iso: string) =>
  new Date(iso).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })

export function ReceiptDiagnose({ onChanged }: { onChanged?: () => void }) {
  const [items, setItems] = useState<DiagnoseItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [days, setDays] = useState(14)
  const [onlyProblem, setOnlyProblem] = useState(true)
  // 担当が代わりに登録するダイアログの対象
  const [completeTarget, setCompleteTarget] = useState<CompleteTarget | null>(null)

  const load = useCallback(
    async (d: number) => {
      setLoading(true)
      try {
        const res = await fetch(`/api/staff-receipts/diagnose?days=${d}`)
        const json = (await res.json().catch(() => ({}))) as { items?: DiagnoseItem[]; error?: string }
        if (!res.ok) throw new Error(json.error || "調べられませんでした")
        setItems(json.items ?? [])
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "調べられませんでした")
      } finally {
        setLoading(false)
      }
    },
    []
  )

  async function clearMark(it: DiagnoseItem) {
    if (
      !confirm(
        `${it.staffName}さんの申請（${yen(it.amount)}）からテストの印を外し、本番の申請として扱います。\n\n` +
          "記録は消えません。\n\nよろしいですか？"
      )
    )
      return
    setBusy(it.receiptId)
    try {
      const res = await fetch("/api/staff-receipts/clear-test-mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptIds: [it.receiptId] }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        error?: string
        skipped?: { reason: string }[]
      }
      if (!res.ok) throw new Error(json.error || "処理に失敗しました")
      if (json.skipped && json.skipped.length > 0) {
        toast.error(`外せませんでした（${json.skipped[0].reason}）`)
      } else {
        toast.success("テストの印を外しました")
      }
      load(days)
      onChanged?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "処理に失敗しました")
    } finally {
      setBusy(null)
    }
  }

  const shown = items ? (onlyProblem ? items.filter((i) => !i.counted) : items) : null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Search className="size-4" />
          申請が見つからないときに調べる
        </CardTitle>
        <CardDescription>
          スタッフが申請したのに一覧に出ない・支給の対象にならないときに使います。
          隠れている申請も含めて全件出し、1件ずつ理由を表示します。記録は変更しません。
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {[3, 14, 60].map((d) => (
            <Button
              key={d}
              size="sm"
              variant={items && days === d ? "default" : "outline"}
              disabled={loading}
              onClick={() => {
                setDays(d)
                load(d)
              }}
            >
              直近{d}日を調べる
            </Button>
          ))}
          {loading && <Loader2 className="size-4 animate-spin" />}
          {items && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => setOnlyProblem((v) => !v)}
            >
              {onlyProblem ? "すべて表示" : "対象外だけ表示"}
            </Button>
          )}
        </div>

        {shown && shown.length === 0 && (
          <p className="py-2 text-sm text-muted-foreground">
            {onlyProblem
              ? "支給の対象から外れている申請はありません。"
              : "この期間の申請はありません。"}
          </p>
        )}

        {shown?.map((it) => (
          <div key={it.receiptId} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={
                  it.counted
                    ? "border-emerald-500 text-emerald-700 dark:text-emerald-400"
                    : "border-red-500 text-red-700 dark:text-red-400"
                }
              >
                {it.counted ? "支給の対象" : "対象外"}
              </Badge>
              <span className="text-sm font-medium">{it.staffName}さん</span>
              <span className="text-sm text-muted-foreground">
                ／{it.storeName || "支払先不明"}
              </span>
              <span className="text-sm">
                <strong>{yen(it.amount)}</strong>
              </span>
              <span className="ml-auto text-xs text-muted-foreground">
                申請 {jst(it.createdAt)}
                {it.date ? `／領収書 ${it.date}` : ""}
              </span>
            </div>

            <ul className="mt-2 flex flex-col gap-1">
              {it.reasons.map((r, i) => (
                <li key={i} className="text-sm leading-relaxed">
                  ・{r}
                </li>
              ))}
            </ul>

            {/* 明細が無い＝まだ支給の対象になっていない。担当がここで完了させられる */}
            {!it.settled && !it.cancelled && (
              <Button
                size="sm"
                className="mt-3 mr-2"
                onClick={() =>
                  setCompleteTarget({
                    id: it.receiptId,
                    staffName: it.staffName,
                    amount: it.amount ?? 0,
                    storeName: it.storeName,
                    date: it.date,
                  })
                }
              >
                <Check className="size-3.5" />
                担当が代わりに登録
              </Button>
            )}
            {it.fix === "clear_test_mark" && (
              <Button
                size="sm"
                className="mt-3"
                disabled={busy === it.receiptId}
                onClick={() => clearMark(it)}
              >
                {busy === it.receiptId ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Wrench className="size-3.5" />
                )}
                テストの印を外す
              </Button>
            )}
            {it.fix === "turn_off_test_staff" && (
              <p className="mt-2 text-xs text-muted-foreground">
                → 「スタッフ」タブで、この方の「テストスタッフ」をOFFにしてください。
              </p>
            )}
            {it.fix === "resume_in_line" && (
              <p className="mt-2 text-xs text-muted-foreground">
                → 本人のLINEで「申請履歴」を開き、「この申請を続ける」から終えてもらってください。
              </p>
            )}
          </div>
        ))}
        <CompletePendingDialog
          target={completeTarget}
          onClose={() => setCompleteTarget(null)}
          onDone={() => {
            load(days)
            onChanged?.()
          }}
        />
      </CardContent>
    </Card>
  )
}
