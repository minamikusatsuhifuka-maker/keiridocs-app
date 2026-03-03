"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Download, Search, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react"

/** スプレッドシート行の型 */
interface SpreadsheetRow {
  document_id: string
  date: string | null
  type: string
  vendor: string
  item_name: string
  quantity: number | null
  unit_price: number | null
  amount: number
  category: string
  tax_category: string
  account_title: string
}

/** 集計結果の型 */
interface Summary {
  total: number
  by_category: Record<string, number>
  by_tax: Record<string, number>
  by_account: Record<string, number>
  by_vendor: Record<string, number>
}

/** ソートキー */
type SortKey = keyof SpreadsheetRow

/** 当月の開始日・終了日を取得 */
function getMonthRange() {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  return { start: fmt(start), end: fmt(end) }
}

/** 金額フォーマット */
function formatCurrency(n: number) {
  return `¥${n.toLocaleString()}`
}

const CATEGORY_OPTIONS = ["全て", "商品代", "手数料", "輸送費", "関税", "消費税", "値引き", "その他"]
const TYPE_OPTIONS = ["全て", "請求書", "領収書", "契約書"]

export default function SpreadsheetPage() {
  const router = useRouter()
  const { start: defaultStart, end: defaultEnd } = useMemo(() => getMonthRange(), [])

  // フィルター
  const [startDate, setStartDate] = useState(defaultStart)
  const [endDate, setEndDate] = useState(defaultEnd)
  const [typeFilter, setTypeFilter] = useState("全て")
  const [categoryFilter, setCategoryFilter] = useState("全て")
  const [vendorFilter, setVendorFilter] = useState("")

  // データ
  const [rows, setRows] = useState<SpreadsheetRow[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(false)

  // ソート
  const [sortKey, setSortKey] = useState<SortKey>("date")
  const [sortAsc, setSortAsc] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (startDate) params.set("start_date", startDate)
      if (endDate) params.set("end_date", endDate)
      if (typeFilter && typeFilter !== "全て") params.set("type", typeFilter)
      if (categoryFilter && categoryFilter !== "全て") params.set("category", categoryFilter)
      if (vendorFilter) params.set("vendor", vendorFilter)

      const res = await fetch(`/api/spreadsheet?${params}`)
      if (!res.ok) throw new Error("データ取得失敗")

      const data = await res.json() as { items: SpreadsheetRow[]; summary: Summary }
      setRows(data.items)
      setSummary(data.summary)
    } catch (error) {
      console.error("スプレッドシートデータ取得エラー:", error)
    } finally {
      setLoading(false)
    }
  }, [startDate, endDate, typeFilter, categoryFilter, vendorFilter])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ソート済みデータ
  const sortedRows = useMemo(() => {
    const sorted = [...rows].sort((a, b) => {
      const aVal = a[sortKey]
      const bVal = b[sortKey]
      if (aVal == null && bVal == null) return 0
      if (aVal == null) return 1
      if (bVal == null) return -1
      if (typeof aVal === "number" && typeof bVal === "number") {
        return sortAsc ? aVal - bVal : bVal - aVal
      }
      return sortAsc
        ? String(aVal).localeCompare(String(bVal), "ja")
        : String(bVal).localeCompare(String(aVal), "ja")
    })
    return sorted
  }, [rows, sortKey, sortAsc])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc)
    } else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="ml-1 h-3 w-3 inline opacity-40" />
    return sortAsc
      ? <ArrowUp className="ml-1 h-3 w-3 inline" />
      : <ArrowDown className="ml-1 h-3 w-3 inline" />
  }

  // Excelエクスポート
  const handleExport = async () => {
    const { utils, writeFile } = await import("xlsx")

    // Sheet1: 明細データ
    const wsData = sortedRows.map((r) => ({
      日付: r.date || "",
      種別: r.type,
      取引先: r.vendor,
      品目名: r.item_name,
      数量: r.quantity ?? "",
      単価: r.unit_price ?? "",
      金額: r.amount,
      カテゴリ: r.category,
      税区分: r.tax_category,
      勘定科目: r.account_title,
    }))
    const ws1 = utils.json_to_sheet(wsData)

    // 列幅を設定
    ws1["!cols"] = [
      { wch: 12 }, { wch: 8 }, { wch: 20 }, { wch: 30 },
      { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 10 },
      { wch: 12 }, { wch: 14 },
    ]

    // Sheet2: 集計
    const summaryData: Record<string, unknown>[] = []
    if (summary) {
      summaryData.push({ 項目: "合計金額", 金額: summary.total })
      summaryData.push({ 項目: "", 金額: "" })

      summaryData.push({ 項目: "【カテゴリ別】", 金額: "" })
      for (const [k, v] of Object.entries(summary.by_category)) {
        summaryData.push({ 項目: k, 金額: v })
      }
      summaryData.push({ 項目: "", 金額: "" })

      summaryData.push({ 項目: "【税区分別】", 金額: "" })
      for (const [k, v] of Object.entries(summary.by_tax)) {
        summaryData.push({ 項目: k, 金額: v })
      }
      summaryData.push({ 項目: "", 金額: "" })

      summaryData.push({ 項目: "【勘定科目別】", 金額: "" })
      for (const [k, v] of Object.entries(summary.by_account)) {
        summaryData.push({ 項目: k, 金額: v })
      }
      summaryData.push({ 項目: "", 金額: "" })

      summaryData.push({ 項目: "【取引先別】", 金額: "" })
      for (const [k, v] of Object.entries(summary.by_vendor)) {
        summaryData.push({ 項目: k, 金額: v })
      }
    }
    const ws2 = utils.json_to_sheet(summaryData)
    ws2["!cols"] = [{ wch: 25 }, { wch: 16 }]

    const wb = utils.book_new()
    utils.book_append_sheet(wb, ws1, "明細データ")
    utils.book_append_sheet(wb, ws2, "集計")

    const fileName = `書類データ_${startDate}_${endDate}.xlsx`
    writeFile(wb, fileName)
  }

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">書類データ一覧</h1>
        <Button onClick={handleExport} disabled={rows.length === 0}>
          <Download className="mr-2 h-4 w-4" />
          Excelエクスポート
        </Button>
      </div>

      {/* フィルターバー */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">開始日</label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-40"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">終了日</label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-40"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">種別</label>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">カテゴリ</label>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((opt) => (
                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">取引先</label>
              <Input
                placeholder="取引先名で検索"
                value={vendorFilter}
                onChange={(e) => setVendorFilter(e.target.value)}
                className="w-44"
              />
            </div>
            <Button onClick={fetchData} disabled={loading}>
              <Search className="mr-2 h-4 w-4" />
              検索
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* テーブル */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead className="cursor-pointer whitespace-nowrap" onClick={() => handleSort("date")}>
                    日付<SortIcon col="date" />
                  </TableHead>
                  <TableHead className="cursor-pointer whitespace-nowrap" onClick={() => handleSort("type")}>
                    種別<SortIcon col="type" />
                  </TableHead>
                  <TableHead className="cursor-pointer whitespace-nowrap" onClick={() => handleSort("vendor")}>
                    取引先<SortIcon col="vendor" />
                  </TableHead>
                  <TableHead className="cursor-pointer whitespace-nowrap" onClick={() => handleSort("item_name")}>
                    品目名<SortIcon col="item_name" />
                  </TableHead>
                  <TableHead className="cursor-pointer whitespace-nowrap text-right" onClick={() => handleSort("quantity")}>
                    数量<SortIcon col="quantity" />
                  </TableHead>
                  <TableHead className="cursor-pointer whitespace-nowrap text-right" onClick={() => handleSort("unit_price")}>
                    単価<SortIcon col="unit_price" />
                  </TableHead>
                  <TableHead className="cursor-pointer whitespace-nowrap text-right" onClick={() => handleSort("amount")}>
                    金額<SortIcon col="amount" />
                  </TableHead>
                  <TableHead className="cursor-pointer whitespace-nowrap" onClick={() => handleSort("category")}>
                    カテゴリ<SortIcon col="category" />
                  </TableHead>
                  <TableHead className="cursor-pointer whitespace-nowrap" onClick={() => handleSort("tax_category")}>
                    税区分<SortIcon col="tax_category" />
                  </TableHead>
                  <TableHead className="cursor-pointer whitespace-nowrap" onClick={() => handleSort("account_title")}>
                    勘定科目<SortIcon col="account_title" />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                      読み込み中...
                    </TableCell>
                  </TableRow>
                ) : sortedRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                      データがありません
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedRows.map((row, i) => (
                    <TableRow
                      key={`${row.document_id}-${i}`}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => router.push(`/documents/${row.document_id}`)}
                    >
                      <TableCell className="whitespace-nowrap">{row.date || "-"}</TableCell>
                      <TableCell className="whitespace-nowrap">{row.type}</TableCell>
                      <TableCell className="max-w-[200px] truncate">{row.vendor}</TableCell>
                      <TableCell className="max-w-[250px] truncate">{row.item_name}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {row.quantity != null ? row.quantity : "-"}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {row.unit_price != null ? formatCurrency(row.unit_price) : "-"}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap font-medium">
                        {formatCurrency(row.amount)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{row.category}</TableCell>
                      <TableCell className="whitespace-nowrap">{row.tax_category}</TableCell>
                      <TableCell className="whitespace-nowrap">{row.account_title || "-"}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* 集計セクション */}
      {summary && rows.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {/* 合計 */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">合計金額</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{formatCurrency(summary.total)}</p>
              <p className="text-xs text-muted-foreground mt-1">{sortedRows.length}件</p>
            </CardContent>
          </Card>

          {/* カテゴリ別 */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">カテゴリ別</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                {Object.entries(summary.by_category)
                  .sort(([, a], [, b]) => b - a)
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between text-sm">
                      <span className="text-muted-foreground truncate mr-2">{k}</span>
                      <span className="font-medium whitespace-nowrap">{formatCurrency(v)}</span>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>

          {/* 税区分別 */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">税区分別</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                {Object.entries(summary.by_tax)
                  .sort(([, a], [, b]) => b - a)
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between text-sm">
                      <span className="text-muted-foreground truncate mr-2">{k}</span>
                      <span className="font-medium whitespace-nowrap">{formatCurrency(v)}</span>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>

          {/* 勘定科目別 */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">勘定科目別</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                {Object.entries(summary.by_account)
                  .sort(([, a], [, b]) => b - a)
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between text-sm">
                      <span className="text-muted-foreground truncate mr-2">{k}</span>
                      <span className="font-medium whitespace-nowrap">{formatCurrency(v)}</span>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>

          {/* 取引先別 */}
          {Object.keys(summary.by_vendor).length > 0 && (
            <Card className="md:col-span-2 lg:col-span-4">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">取引先別</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
                  {Object.entries(summary.by_vendor)
                    .sort(([, a], [, b]) => b - a)
                    .map(([k, v]) => (
                      <div key={k} className="flex justify-between text-sm">
                        <span className="text-muted-foreground truncate mr-2">{k}</span>
                        <span className="font-medium whitespace-nowrap">{formatCurrency(v)}</span>
                      </div>
                    ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}
