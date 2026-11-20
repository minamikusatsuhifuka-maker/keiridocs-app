"use client"

import { useCallback, useState } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Calculator, Loader2 } from "lucide-react"

/**
 * 保存済みの明細を、いまの規程で計算し直す画面。
 *
 * 計算の不具合を直しても、保存済みの支給額は変わらない。
 * これまでは「費用区分を別のものに変えて保存し、元に戻す」しか方法が無く、
 * 区分を間違えたまま保存してしまう危険があった。
 *
 * 保存の前に、対象者・明細・変更前後の支給額を必ず確認できるようにする。
 */

interface RecalcRow {
  id: string
  staffName: string
  label: string
  date: string | null
  amount: number
  before: number
  after: number
  holdBefore: string | null
  holdAfter: string | null
  alreadyRefunded: boolean
  dateUnconfirmed: boolean
}

const yen = (v: number) => `¥${v.toLocaleString("ja-JP")}`

const HOLD_LABELS: Record<string, string> = {
  excess: "上限超過の確認待ち",
  course: "講座の確認待ち",
  attach: "添付待ち",
  undecided: "支給率が未定",
  history: "受講回数の確認待ち",
  pass: "定期券区間の確認待ち",
  term: "会員期間外の確認待ち",
  detail: "内訳の確認待ち",
  dup: "二重申請の確認待ち",
}

export function RecalcPanel({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<RecalcRow[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const check = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/staff-reimburse/recalc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: true, days: 90 }),
      })
      const json = (await res.json().catch(() => ({}))) as { rows?: RecalcRow[]; error?: string }
      if (!res.ok) throw new Error(json.error || "確認できませんでした")
      const list = json.rows ?? []
      setRows(list)
      // 既に給与で返金済みの分は、既定では選ばない（支払いとずれるため）
      setChecked(new Set(list.filter((r) => !r.alreadyRefunded).map((r) => r.id)))
      if (list.length === 0) toast.success("計算し直しても変わる明細はありませんでした")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "確認できませんでした")
    } finally {
      setLoading(false)
    }
  }, [])

  async function save() {
    const ids = [...checked]
    if (ids.length === 0) {
      toast.error("保存する明細を選んでください")
      return
    }
    const picked = (rows ?? []).filter((r) => ids.includes(r.id))
    const diff = picked.reduce((s, r) => s + (r.after - r.before), 0)
    if (
      !confirm(
        `${ids.length}件の支給額を保存します。\n\n` +
          `支給額の合計は ${diff >= 0 ? "+" : ""}${yen(diff)} 変わります。\n\n` +
          "立替額と費用区分は変更しません。\n\nよろしいですか？"
      )
    )
      return

    setSaving(true)
    try {
      const res = await fetch("/api/staff-reimburse/recalc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: false, ids, days: 90 }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || "保存できませんでした")
      toast.success(`${ids.length}件を保存しました`)
      setRows(null)
      setChecked(new Set())
      onChanged?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存できませんでした")
    } finally {
      setSaving(false)
    }
  }

  const picked = (rows ?? []).filter((r) => checked.has(r.id))
  const diff = picked.reduce((s, r) => s + (r.after - r.before), 0)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Calculator className="size-4" />
          支給額の再計算
        </CardTitle>
        <CardDescription>
          保存済みの明細を、いまの規程で計算し直します。
          <strong>まず内容を確認してから保存します。</strong>
          立替額と費用区分は変更しません。
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={check} disabled={loading || saving}>
            {loading && <Loader2 className="size-3.5 animate-spin" />}
            変わる明細を確認する
          </Button>
          {rows && rows.length > 0 && (
            <Button size="sm" onClick={save} disabled={saving || checked.size === 0}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              選んだ {checked.size}件を保存する
            </Button>
          )}
        </div>

        {rows && rows.length > 0 && (
          <>
            <div className="rounded-lg border p-3">
              <p className="text-sm">
                変わる明細：<strong>{rows.length}件</strong>／選択中の支給額の差：
                <strong className={diff >= 0 ? "text-emerald-700" : "text-red-700"}>
                  {diff >= 0 ? "+" : ""}
                  {yen(diff)}
                </strong>
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1.5 pr-2 font-medium">保存</th>
                    <th className="py-1.5 pr-2 font-medium">スタッフ</th>
                    <th className="py-1.5 pr-2 font-medium">明細</th>
                    <th className="py-1.5 pr-2 text-right font-medium">立替額</th>
                    <th className="py-1.5 pr-2 text-right font-medium">いまの支給額</th>
                    <th className="py-1.5 pr-2 text-right font-medium">計算し直すと</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 align-top">
                      <td className="py-2 pr-2">
                        <Checkbox
                          checked={checked.has(r.id)}
                          onCheckedChange={(v) =>
                            setChecked((prev) => {
                              const next = new Set(prev)
                              if (v) next.add(r.id)
                              else next.delete(r.id)
                              return next
                            })
                          }
                        />
                      </td>
                      <td className="py-2 pr-2 whitespace-nowrap">{r.staffName}</td>
                      <td className="py-2 pr-2">
                        {r.label}
                        <span className="block text-xs text-muted-foreground">
                          {r.date || "日付なし"}
                        </span>
                        <span className="mt-1 flex flex-wrap gap-1">
                          {r.alreadyRefunded && (
                            <Badge
                              variant="outline"
                              className="border-amber-500 text-amber-700 dark:text-amber-400"
                            >
                              給与で返金済み
                            </Badge>
                          )}
                          {r.dateUnconfirmed && (
                            <Badge
                              variant="outline"
                              className="border-red-500 text-red-700 dark:text-red-400"
                            >
                              支払日が未確認
                            </Badge>
                          )}
                          {r.holdBefore !== r.holdAfter && (
                            <Badge variant="outline">
                              {r.holdBefore ? HOLD_LABELS[r.holdBefore] ?? r.holdBefore : "確定済み"}
                              {" → "}
                              {r.holdAfter ? HOLD_LABELS[r.holdAfter] ?? r.holdAfter : "確定"}
                            </Badge>
                          )}
                        </span>
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums">{yen(r.amount)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">
                        {yen(r.before)}
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums font-medium">
                        {yen(r.after)}
                        {r.after !== r.before && (
                          <span
                            className={
                              r.after > r.before
                                ? "block text-xs text-emerald-700"
                                : "block text-xs text-red-700"
                            }
                          >
                            {r.after > r.before ? "+" : ""}
                            {yen(r.after - r.before)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-xs text-muted-foreground">
              「給与で返金済み」の明細は、すでに支払った金額とずれるため既定では選んでいません。
              支払い直しが必要かを確認してから選んでください。
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
