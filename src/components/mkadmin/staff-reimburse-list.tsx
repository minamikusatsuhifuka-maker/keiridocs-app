"use client"

import { useState, useEffect, useCallback, Fragment } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Loader2, Download, ChevronRight, ChevronDown, Briefcase } from "lucide-react"
import { toast } from "sonner"

interface ReimburseDetail {
  transactionId: string
  staffMemberId: string | null
  staffName: string
  paymentDate: string
  applicationDate: string
  storeName: string
  expenseDetail: string
  amount: number
  isHalf: boolean
  subsidy: number
}

interface ReimburseSummary {
  staffMemberId: string | null
  staffName: string
  count: number
  totalAmount: number
  totalSubsidy: number
}

interface ReimburseResponse {
  summaries: ReimburseSummary[]
  details: ReimburseDetail[]
  totals: { count: number; totalAmount: number; totalSubsidy: number }
  periodLabel: string
}

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`
const staffKey = (id: string | null) => id ?? "__unknown__"

function getYearOptions(): number[] {
  const now = new Date()
  const years: number[] = []
  for (let y = now.getFullYear(); y >= now.getFullYear() - 3; y--) years.push(y)
  return years
}
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)

/**
 * 会計士向けスタッフ立替まとめ（/mkadmin タブ）。
 * スタッフ毎の支給額合計（上段）＋各立替明細（展開）。月選択／任意期間で集計し、CSV出力できる。
 */
export function StaffReimburseList() {
  const now = new Date()
  const [mode, setMode] = useState<"month" | "range">("month")
  const [year, setYear] = useState<number>(now.getFullYear())
  const [month, setMonth] = useState<number>(now.getMonth() + 1)
  const [startDate, setStartDate] = useState<string>("")
  const [endDate, setEndDate] = useState<string>("")

  const [data, setData] = useState<ReimburseResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // 現在の期間に対応するクエリ文字列を作る（CSVと共用）
  const buildQuery = useCallback((): string | null => {
    if (mode === "range") {
      if (!startDate || !endDate) return null
      return `start=${startDate}&end=${endDate}`
    }
    return `year=${year}&month=${month}`
  }, [mode, startDate, endDate, year, month])

  const fetchData = useCallback(async () => {
    const q = buildQuery()
    if (q === null) {
      // 任意期間が未入力のときは集計しない
      setData(null)
      return
    }
    setIsLoading(true)
    try {
      const res = await fetch(`/api/petty-cash/staff-reimburse?${q}`)
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error || "取得に失敗しました")
      }
      const json = (await res.json()) as ReimburseResponse
      setData(json)
      setExpanded(new Set())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "取得に失敗しました")
      setData(null)
    } finally {
      setIsLoading(false)
    }
  }, [buildQuery])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function handleCsv() {
    const q = buildQuery()
    if (q === null) {
      toast.error("任意期間の開始日・終了日を入力してください")
      return
    }
    window.location.href = `/api/petty-cash/staff-reimburse?${q}&format=csv`
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Briefcase className="size-5" style={{ color: "var(--dusk-primary)" }} />
            スタッフ立替まとめ（会計士向け・給与反映用）
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm" style={{ color: "var(--dusk-text-muted)" }}>
            申請日（アップロード日）ベースで集計します。立替は全件「給与支給」、
            「セミナー2回目以降」のみ半額（端数切り捨て）、他は全額です。
          </p>
          {/* 役割の整理: このタブは給与の月次反映用サマリー。
              1件ごとの内訳・分割の確認・資料閲覧・編集削除は専用メニュー「スタッフ立替」で行う。 */}
          <p className="text-sm" style={{ color: "var(--dusk-text-muted)" }}>
            1件ごとの内訳（申請日・提出日・分割の内訳・登録資料）を見るときは
            <Link href="/staff-reimburse" className="mx-1 font-medium underline">
              スタッフ立替メニュー
            </Link>
            を開いてください。金額はこのタブと同じ計算です。
          </p>

          {/* 期間選択 */}
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label>集計方法</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as "month" | "range")}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="month">月で集計</SelectItem>
                  <SelectItem value="range">任意期間</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {mode === "month" ? (
              <>
                <div className="space-y-1">
                  <Label>年</Label>
                  <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                    <SelectTrigger className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {getYearOptions().map((y) => (
                        <SelectItem key={y} value={String(y)}>
                          {y}年
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>月</Label>
                  <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
                    <SelectTrigger className="w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONTHS.map((m) => (
                        <SelectItem key={m} value={String(m)}>
                          {m}月
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1">
                  <Label>開始日</Label>
                  <Input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-44"
                  />
                </div>
                <div className="space-y-1">
                  <Label>終了日</Label>
                  <Input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-44"
                  />
                </div>
              </>
            )}

            <Button
              onClick={handleCsv}
              className="btn-dusk-primary gap-2"
              disabled={isLoading || !data || data.details.length === 0}
            >
              <Download className="size-4" />
              CSV出力
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* サマリー */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin" style={{ color: "var(--dusk-primary)" }} />
        </div>
      ) : !data ? (
        <div className="py-12 text-center" style={{ color: "var(--dusk-text-muted)" }}>
          期間を選択してください
        </div>
      ) : data.summaries.length === 0 ? (
        <div className="py-12 text-center" style={{ color: "var(--dusk-text-muted)" }}>
          {data.periodLabel} の対象データがありません
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
              <span>{data.periodLabel} の支給額</span>
              <span className="text-sm font-normal" style={{ color: "var(--dusk-text-muted)" }}>
                {data.totals.count}件 ／ 立替額 {yen(data.totals.totalAmount)} ／ 支給額{" "}
                <span className="font-bold" style={{ color: "var(--dusk-primary)" }}>
                  {yen(data.totals.totalSubsidy)}
                </span>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>スタッフ名</TableHead>
                    <TableHead className="text-right">立替件数</TableHead>
                    <TableHead className="text-right">立替額合計</TableHead>
                    <TableHead className="text-right">支給額合計</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.summaries.map((s) => {
                    const key = staffKey(s.staffMemberId)
                    const isOpen = expanded.has(key)
                    const rows = data.details.filter((d) => staffKey(d.staffMemberId) === key)
                    return (
                      <Fragment key={key}>
                        <TableRow
                          className="cursor-pointer hover:bg-muted/40"
                          onClick={() => toggleExpand(key)}
                        >
                          <TableCell>
                            {isOpen ? (
                              <ChevronDown className="size-4" />
                            ) : (
                              <ChevronRight className="size-4" />
                            )}
                          </TableCell>
                          <TableCell className="font-medium">{s.staffName}</TableCell>
                          <TableCell className="text-right tabular-nums">{s.count}件</TableCell>
                          <TableCell className="text-right tabular-nums">{yen(s.totalAmount)}</TableCell>
                          <TableCell
                            className="text-right font-bold tabular-nums"
                            style={{ color: "var(--dusk-primary)" }}
                          >
                            {yen(s.totalSubsidy)}
                          </TableCell>
                        </TableRow>

                        {/* 明細（展開時） */}
                        {isOpen && (
                          <TableRow className="bg-muted/20 hover:bg-muted/20">
                            <TableCell />
                            <TableCell colSpan={4} className="py-2">
                              <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr style={{ color: "var(--dusk-text-muted)" }}>
                                      <th className="px-2 py-1 text-left font-medium">支払年月日</th>
                                      <th className="px-2 py-1 text-left font-medium">申請日</th>
                                      <th className="px-2 py-1 text-left font-medium">店名</th>
                                      <th className="px-2 py-1 text-left font-medium">区分</th>
                                      <th className="px-2 py-1 text-right font-medium">立替額</th>
                                      <th className="px-2 py-1 text-center font-medium">支給率</th>
                                      <th className="px-2 py-1 text-right font-medium">支給額</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {rows.map((d) => (
                                      <tr key={d.transactionId} className="border-t">
                                        <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">
                                          {d.paymentDate || "—"}
                                        </td>
                                        <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">
                                          {d.applicationDate}
                                        </td>
                                        <td className="px-2 py-1.5">{d.storeName}</td>
                                        <td className="px-2 py-1.5">{d.expenseDetail}</td>
                                        <td className="px-2 py-1.5 text-right tabular-nums">
                                          {yen(d.amount)}
                                        </td>
                                        <td className="px-2 py-1.5 text-center">
                                          {d.isHalf ? (
                                            <Badge
                                              variant="outline"
                                              className="border-amber-200 bg-amber-50 text-amber-700"
                                            >
                                              半額
                                            </Badge>
                                          ) : (
                                            <span style={{ color: "var(--dusk-text-muted)" }}>全額</span>
                                          )}
                                        </td>
                                        <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                                          {yen(d.subsidy)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
