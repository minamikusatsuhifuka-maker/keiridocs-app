"use client"

import { useState, useEffect, useMemo } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2, Download, ArrowUpDown, ArrowUp, ArrowDown, Play, Bell } from "lucide-react"
import { toast } from "sonner"

interface StaffMember {
  id: string
  name: string
}

interface StaffReceipt {
  id: string
  staff_member_id: string
  staff_name: string
  file_name: string
  dropbox_path: string
  document_type: string | null
  date: string | null
  amount: number | null
  store_name: string | null
  tax_category: string | null
  account_title: string | null
  created_at: string
}

type SortKey = "date" | "staff_name" | "store_name" | "amount" | "document_type"

// 年の選択肢を生成（現在年から3年前まで）
function getYearOptions(): string[] {
  const now = new Date()
  const years: string[] = []
  for (let y = now.getFullYear(); y >= now.getFullYear() - 3; y--) {
    years.push(String(y))
  }
  return years
}

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => String(i + 1))

export default function StaffReceiptsAdminPage() {
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>([])
  const [receipts, setReceipts] = useState<StaffReceipt[]>([])
  const [isLoading, setIsLoading] = useState(false)

  // フィルター
  const [selectedStaffId, setSelectedStaffId] = useState<string>("all")
  const [selectedYear, setSelectedYear] = useState<string>(String(new Date().getFullYear()))
  const [selectedMonth, setSelectedMonth] = useState<string>(String(new Date().getMonth() + 1))

  // ソート
  const [sortKey, setSortKey] = useState<SortKey>("date")
  const [sortAsc, setSortAsc] = useState(false)

  // 手動実行
  const [isRunningClose, setIsRunningClose] = useState(false)
  const [isRunningRemind, setIsRunningRemind] = useState(false)

  // スタッフ一覧取得
  useEffect(() => {
    async function fetchStaff() {
      try {
        const res = await fetch("/api/staff-members")
        if (!res.ok) throw new Error("取得失敗")
        const json = await res.json() as { data: StaffMember[] }
        setStaffMembers(json.data || [])
      } catch {
        toast.error("スタッフ一覧の取得に失敗しました")
      }
    }
    fetchStaff()
  }, [])

  // 領収書一覧取得
  useEffect(() => {
    async function fetchReceipts() {
      setIsLoading(true)
      try {
        const params = new URLSearchParams()
        if (selectedStaffId !== "all") params.set("staff_member_id", selectedStaffId)
        if (selectedYear) params.set("year", selectedYear)
        if (selectedMonth) params.set("month", selectedMonth)

        const res = await fetch(`/api/staff-receipts?${params.toString()}`)
        if (!res.ok) throw new Error("取得失敗")
        const json = await res.json() as { data: StaffReceipt[] }
        setReceipts(json.data || [])
      } catch {
        toast.error("領収書一覧の取得に失敗しました")
      } finally {
        setIsLoading(false)
      }
    }
    fetchReceipts()
  }, [selectedStaffId, selectedYear, selectedMonth])

  // ソート処理
  const sortedReceipts = useMemo(() => {
    const sorted = [...receipts].sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case "date":
          cmp = (a.date || "").localeCompare(b.date || "")
          break
        case "staff_name":
          cmp = a.staff_name.localeCompare(b.staff_name)
          break
        case "store_name":
          cmp = (a.store_name || "").localeCompare(b.store_name || "")
          break
        case "amount":
          cmp = (a.amount || 0) - (b.amount || 0)
          break
        case "document_type":
          cmp = (a.document_type || "").localeCompare(b.document_type || "")
          break
      }
      return sortAsc ? cmp : -cmp
    })
    return sorted
  }, [receipts, sortKey, sortAsc])

  // 合計金額
  const totalAmount = useMemo(() => {
    return receipts.reduce((sum, r) => sum + (r.amount || 0), 0)
  }, [receipts])

  // ソートトグル
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc)
    } else {
      setSortKey(key)
      setSortAsc(key === "date" ? false : true)
    }
  }

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="ml-1 h-3 w-3 inline opacity-40" />
    return sortAsc
      ? <ArrowUp className="ml-1 h-3 w-3 inline" />
      : <ArrowDown className="ml-1 h-3 w-3 inline" />
  }

  // 月次締め手動実行
  const handleMonthlyClose = async () => {
    setIsRunningClose(true)
    try {
      const res = await fetch("/api/cron/monthly-close")
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "実行に失敗しました")
      toast.success(`月次締め完了: ${json.count}件 / ¥${json.total?.toLocaleString()}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "月次締めの実行に失敗しました")
    } finally {
      setIsRunningClose(false)
    }
  }

  // 未提出リマインダー手動実行
  const handleRemindMissing = async () => {
    setIsRunningRemind(true)
    try {
      const res = await fetch("/api/cron/remind-missing")
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "送信に失敗しました")
      toast.success(`リマインダー送信完了: 未提出${json.missing_count}名 / 通知${json.notified?.length}名`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "リマインダーの送信に失敗しました")
    } finally {
      setIsRunningRemind(false)
    }
  }

  // Excelエクスポート
  const handleExport = async () => {
    const { utils, writeFile } = await import("xlsx")

    const wsData = sortedReceipts.map((r) => ({
      スタッフ名: r.staff_name,
      日付: r.date || "",
      店名: r.store_name || "",
      金額: r.amount ?? "",
      種別: r.document_type || "",
      税区分: r.tax_category || "",
      勘定科目: r.account_title || "",
      ファイル名: r.file_name,
    }))
    const ws = utils.json_to_sheet(wsData)

    ws["!cols"] = [
      { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 14 },
      { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 30 },
    ]

    // 集計シート
    const summaryData: Record<string, unknown>[] = []
    summaryData.push({ 項目: "合計金額", 金額: totalAmount })
    summaryData.push({ 項目: "", 金額: "" })

    // スタッフ別集計
    const byStaff: Record<string, number> = {}
    receipts.forEach((r) => {
      byStaff[r.staff_name] = (byStaff[r.staff_name] || 0) + (r.amount || 0)
    })
    summaryData.push({ 項目: "【スタッフ別】", 金額: "" })
    for (const [k, v] of Object.entries(byStaff)) {
      summaryData.push({ 項目: k, 金額: v })
    }
    summaryData.push({ 項目: "", 金額: "" })

    // 勘定科目別集計
    const byAccount: Record<string, number> = {}
    receipts.forEach((r) => {
      const key = r.account_title || "未分類"
      byAccount[key] = (byAccount[key] || 0) + (r.amount || 0)
    })
    summaryData.push({ 項目: "【勘定科目別】", 金額: "" })
    for (const [k, v] of Object.entries(byAccount)) {
      summaryData.push({ 項目: k, 金額: v })
    }
    summaryData.push({ 項目: "", 金額: "" })

    // 税区分別集計
    const byTax: Record<string, number> = {}
    receipts.forEach((r) => {
      const key = r.tax_category || "未判定"
      byTax[key] = (byTax[key] || 0) + (r.amount || 0)
    })
    summaryData.push({ 項目: "【税区分別】", 金額: "" })
    for (const [k, v] of Object.entries(byTax)) {
      summaryData.push({ 項目: k, 金額: v })
    }

    const ws2 = utils.json_to_sheet(summaryData)
    ws2["!cols"] = [{ wch: 25 }, { wch: 16 }]

    const wb = utils.book_new()
    utils.book_append_sheet(wb, ws, "領収書一覧")
    utils.book_append_sheet(wb, ws2, "集計")

    const monthStr = selectedMonth ? selectedMonth.padStart(2, "0") : "全月"
    const fileName = `スタッフ領収書_${selectedYear}年${monthStr}月.xlsx`
    writeFile(wb, fileName)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">スタッフ領収書管理</h1>
        <div className="flex gap-2">
          <Button
            onClick={handleMonthlyClose}
            disabled={isRunningClose}
            variant="outline"
          >
            {isRunningClose ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Play className="mr-2 size-4" />}
            今すぐ月次締め実行
          </Button>
          <Button
            onClick={handleRemindMissing}
            disabled={isRunningRemind}
            variant="outline"
          >
            {isRunningRemind ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Bell className="mr-2 size-4" />}
            未提出リマインダー送信
          </Button>
          <Button
            onClick={handleExport}
            disabled={receipts.length === 0}
            className="btn-float-primary"
          >
            <Download className="mr-2 size-4" />
            Excelエクスポート
          </Button>
        </div>
      </div>

      {/* フィルター */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">絞り込み</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            <div className="space-y-1">
              <Label>スタッフ</Label>
              <Select value={selectedStaffId} onValueChange={setSelectedStaffId}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全員</SelectItem>
                  {staffMembers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>年</Label>
              <Select value={selectedYear} onValueChange={setSelectedYear}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {getYearOptions().map((y) => (
                    <SelectItem key={y} value={y}>{y}年</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>月</Label>
              <Select value={selectedMonth} onValueChange={setSelectedMonth}>
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTH_OPTIONS.map((m) => (
                    <SelectItem key={m} value={m}>{m}月</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 合計 */}
      {receipts.length > 0 && (
        <div className="text-sm text-muted-foreground">
          {receipts.length}件 / 合計: <span className="font-bold text-foreground">¥{totalAmount.toLocaleString()}</span>
        </div>
      )}

      {/* 一覧テーブル */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : receipts.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              該当する領収書がありません
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="cursor-pointer px-4 py-3 text-left font-medium" onClick={() => toggleSort("staff_name")}>
                      スタッフ <SortIcon col="staff_name" />
                    </th>
                    <th className="cursor-pointer px-4 py-3 text-left font-medium" onClick={() => toggleSort("date")}>
                      日付 <SortIcon col="date" />
                    </th>
                    <th className="cursor-pointer px-4 py-3 text-left font-medium" onClick={() => toggleSort("store_name")}>
                      店名 <SortIcon col="store_name" />
                    </th>
                    <th className="cursor-pointer px-4 py-3 text-right font-medium" onClick={() => toggleSort("amount")}>
                      金額 <SortIcon col="amount" />
                    </th>
                    <th className="cursor-pointer px-4 py-3 text-left font-medium" onClick={() => toggleSort("document_type")}>
                      種別 <SortIcon col="document_type" />
                    </th>
                    <th className="px-4 py-3 text-left font-medium">税区分</th>
                    <th className="px-4 py-3 text-left font-medium">勘定科目</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedReceipts.map((r) => (
                    <tr key={r.id} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3">{r.staff_name}</td>
                      <td className="px-4 py-3">{r.date || "—"}</td>
                      <td className="px-4 py-3">{r.store_name || "—"}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {r.amount != null ? `¥${r.amount.toLocaleString()}` : "—"}
                      </td>
                      <td className="px-4 py-3">{r.document_type || "—"}</td>
                      <td className="px-4 py-3">{r.tax_category || "—"}</td>
                      <td className="px-4 py-3">{r.account_title || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
