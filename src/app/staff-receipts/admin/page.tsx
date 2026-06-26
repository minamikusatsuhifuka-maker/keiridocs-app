"use client"

import { useState, useEffect, useMemo } from "react"
import Link from "next/link"
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
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, Download, ArrowUpDown, ArrowUp, ArrowDown, Play, Bell, Users, AlertTriangle, ExternalLink, FileText } from "lucide-react"
import { toast } from "sonner"
import { subsidyLabel } from "@/lib/subsidy"
import { findDuplicateIds } from "@/lib/staff-receipt-dedup"

// petty_cash_transactions から付与する精算情報
interface SettleInfo {
  settlement_method: string | null
  subsidy_category: string | null
}

// 精算方法の日本語ラベル（NULLは後方互換で小口現金扱い）
function settlementMethodLabel(method: string | null | undefined): string {
  switch (method) {
    case "payroll":
      return "給与"
    case "storage_only":
      return "保管"
    case "petty_cash":
    default:
      return "小口現金"
  }
}

// ファイルがPDFかどうか（PDFは<img>で表示できないためアイコン表示にする）
function isPdfFile(receipt: { file_name?: string | null; dropbox_path?: string | null }): boolean {
  const name = (receipt.file_name || receipt.dropbox_path || "").toLowerCase()
  return name.endsWith(".pdf")
}

// 登録日時の表示（YYYY/MM/DD HH:mm）
function formatRegisteredAt(iso: string): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "—"
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  return `${y}/${m}/${day} ${hh}:${mm}`
}

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
  image_hash?: string | null
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

  // 小口現金連携（staff_receipt_id → 精算情報）
  const [settlementInfo, setSettlementInfo] = useState<Map<string, SettleInfo>>(new Map())
  const [pettyCashTarget, setPettyCashTarget] = useState<StaffReceipt | null>(null)
  const [isRegisteringPettyCash, setIsRegisteringPettyCash] = useState(false)
  const [pettyCashBalance, setPettyCashBalance] = useState<number>(0)

  // 画像プレビュー（拡大表示）
  const [previewReceipt, setPreviewReceipt] = useState<StaffReceipt | null>(null)
  const [isOpeningDropbox, setIsOpeningDropbox] = useState(false)

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

  // 小口現金登録済み情報を取得
  useEffect(() => {
    async function fetchPettyCash() {
      try {
        const res = await fetch("/api/petty-cash")
        if (!res.ok) return
        const json = await res.json() as {
          balance: number
          transactions: {
            staff_receipt_id: string | null
            settlement_method: string | null
            subsidy_category: string | null
          }[]
        }
        setPettyCashBalance(json.balance)
        const map = new Map<string, SettleInfo>()
        for (const tx of json.transactions) {
          if (tx.staff_receipt_id) {
            map.set(tx.staff_receipt_id, {
              settlement_method: tx.settlement_method,
              subsidy_category: tx.subsidy_category,
            })
          }
        }
        setSettlementInfo(map)
      } catch {
        // 取得失敗は無視
      }
    }
    fetchPettyCash()
  }, [])

  // 小口現金出金登録
  const handlePettyCashRegister = async (receipt: StaffReceipt) => {
    setIsRegisteringPettyCash(true)
    try {
      const res = await fetch("/api/petty-cash/from-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staff_receipt_id: receipt.id }),
      })
      const json = await res.json() as { error?: string; balance?: number }
      if (!res.ok) throw new Error(json.error || "登録に失敗しました")

      toast.success(`¥${(receipt.amount || 0).toLocaleString()} を小口現金から出金登録しました`)
      // 小口対応で登録した分は小口現金（settlement_method=null=小口扱い）／区分なし
      setSettlementInfo((prev) => {
        const next = new Map(prev)
        next.set(receipt.id, { settlement_method: null, subsidy_category: null })
        return next
      })
      if (typeof json.balance === "number") setPettyCashBalance(json.balance)
      setPettyCashTarget(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "小口現金登録に失敗しました")
    } finally {
      setIsRegisteringPettyCash(false)
    }
  }

  // Dropboxの実ファイルを新規タブで開く（一時リンクを取得）
  const handleOpenInDropbox = async (receipt: StaffReceipt) => {
    setIsOpeningDropbox(true)
    try {
      const res = await fetch(`/api/staff-receipts/image?id=${receipt.id}&mode=link`)
      const json = await res.json() as { link?: string; error?: string }
      if (!res.ok || !json.link) throw new Error(json.error || "リンク取得に失敗しました")
      window.open(json.link, "_blank", "noopener,noreferrer")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Dropboxファイルを開けませんでした")
    } finally {
      setIsOpeningDropbox(false)
    }
  }

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

  // 重複している領収書のIDセット（画像ハッシュ一致 or 同一スタッフの店名+金額+日付一致）
  // 表示中（絞り込み後）のデータから検出する
  const duplicateIds = useMemo(() => findDuplicateIds(receipts), [receipts])

  // サマリー（件数・精算済み/未精算の内訳）
  const summary = useMemo(() => {
    let settledCount = 0
    let settledAmount = 0
    let unsettledCount = 0
    let unsettledAmount = 0
    for (const r of receipts) {
      const amount = r.amount || 0
      if (settlementInfo.has(r.id)) {
        settledCount += 1
        settledAmount += amount
      } else {
        unsettledCount += 1
        unsettledAmount += amount
      }
    }
    return { settledCount, settledAmount, unsettledCount, unsettledAmount }
  }, [receipts, settlementInfo])

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
      {/* 参照のみバナー */}
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-bold">📁 過去データ参照用ページ</p>
        <p className="mt-1">
          新規のスタッフ領収書アップロード機能は
          <Link href="/petty-cash" className="underline mx-1 font-bold">小口現金管理</Link>
          の「スタッフ返金」に統合されました。このページは過去データの閲覧・Excelエクスポート専用です。
        </p>
      </div>

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">スタッフ領収書管理</h1>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/line-staff">
              <Users className="mr-1 size-4" />
              LINEスタッフ管理へ
            </Link>
          </Button>
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

      {/* サマリー（件数・合計・精算済み/未精算の内訳） */}
      {receipts.length > 0 && (
        <div className="flex flex-wrap gap-3">
          <Card className="flex-1 min-w-[140px]">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">件数 / 合計</p>
              <p className="mt-1 text-lg font-bold">
                {receipts.length}件 <span className="text-sm font-normal text-muted-foreground">/</span> ¥{totalAmount.toLocaleString()}
              </p>
            </CardContent>
          </Card>
          <Card className="flex-1 min-w-[140px]">
            <CardContent className="p-4">
              <p className="text-xs text-emerald-700">精算済み</p>
              <p className="mt-1 text-lg font-bold text-emerald-700">
                {summary.settledCount}件 <span className="text-sm font-normal">/ ¥{summary.settledAmount.toLocaleString()}</span>
              </p>
            </CardContent>
          </Card>
          <Card className="flex-1 min-w-[140px]">
            <CardContent className="p-4">
              <p className="text-xs text-amber-700">未精算</p>
              <p className="mt-1 text-lg font-bold text-amber-700">
                {summary.unsettledCount}件 <span className="text-sm font-normal">/ ¥{summary.unsettledAmount.toLocaleString()}</span>
              </p>
            </CardContent>
          </Card>
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
                    <th className="px-4 py-3 text-center font-medium">画像</th>
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
                    <th className="px-4 py-3 text-left font-medium">登録日時</th>
                    <th className="px-4 py-3 text-center font-medium">精算状態</th>
                    <th className="px-4 py-3 text-left font-medium">アチーブメント区分</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedReceipts.map((r) => (
                    <tr key={r.id} className="border-b hover:bg-muted/30 transition-colors">
                      {/* 画像サムネイル（クリックで拡大）。PDFはアイコン表示 */}
                      <td className="px-4 py-3">
                        <div className="flex justify-center">
                          {isPdfFile(r) ? (
                            <button
                              type="button"
                              onClick={() => setPreviewReceipt(r)}
                              title="PDFを開く"
                              className="flex h-14 w-14 items-center justify-center rounded border bg-muted/40 hover:bg-muted transition-colors"
                            >
                              <FileText className="size-6 text-muted-foreground" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setPreviewReceipt(r)}
                              title="クリックで拡大"
                              className="h-14 w-14 overflow-hidden rounded border bg-muted/40 hover:ring-2 hover:ring-primary/50 transition-all"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={`/api/staff-receipts/image?id=${r.id}`}
                                alt={`${r.store_name || "領収書"}のサムネイル`}
                                loading="lazy"
                                className="h-full w-full object-cover"
                              />
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">{r.staff_name}</td>
                      <td className="px-4 py-3">{r.date || "—"}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          <span>{r.store_name || "—"}</span>
                          {duplicateIds.has(r.id) && (
                            <Badge
                              variant="outline"
                              className="w-fit gap-1 border-rose-200 bg-rose-50 text-rose-700"
                              title="同じ画像、または同一スタッフで店名・金額・日付が一致する領収書があります"
                            >
                              <AlertTriangle className="size-3" />
                              重複の可能性
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {r.amount != null ? `¥${r.amount.toLocaleString()}` : "—"}
                      </td>
                      <td className="px-4 py-3">{r.document_type || "—"}</td>
                      <td className="px-4 py-3">{r.tax_category || "—"}</td>
                      <td className="px-4 py-3">{r.account_title || "—"}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground">
                        {formatRegisteredAt(r.created_at)}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {settlementInfo.has(r.id) ? (
                          <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                            ✅ 精算済み（{settlementMethodLabel(settlementInfo.get(r.id)?.settlement_method)}）
                          </Badge>
                        ) : r.amount && r.amount > 0 ? (
                          <div className="flex flex-col items-center gap-1">
                            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                              未精算
                            </Badge>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-xs"
                              onClick={() => setPettyCashTarget(r)}
                            >
                              💰 小口対応
                            </Button>
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {settlementInfo.get(r.id)?.subsidy_category
                          ? subsidyLabel(settlementInfo.get(r.id)?.subsidy_category)
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 小口現金確認ダイアログ */}
      <Dialog open={!!pettyCashTarget} onOpenChange={(open) => !open && setPettyCashTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>💰 小口現金から出金登録</DialogTitle>
          </DialogHeader>
          {pettyCashTarget && (
            <div className="space-y-4">
              <div className="rounded-lg bg-muted/50 p-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">スタッフ</span>
                  <span className="font-medium">{pettyCashTarget.staff_name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">店名</span>
                  <span className="font-medium">{pettyCashTarget.store_name || "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">金額</span>
                  <span className="font-bold text-lg">¥{(pettyCashTarget.amount || 0).toLocaleString()}</span>
                </div>
              </div>

              <p className="text-sm text-center">
                ¥{(pettyCashTarget.amount || 0).toLocaleString()} を小口現金から支出として登録しますか？
              </p>

              {pettyCashBalance - (pettyCashTarget.amount || 0) < 0 && (
                <Alert className="border-red-200 bg-red-50">
                  <AlertTriangle className="size-4 text-red-600" />
                  <AlertDescription className="text-red-700">
                    残高がマイナス（¥{(pettyCashBalance - (pettyCashTarget.amount || 0)).toLocaleString()}）になります
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setPettyCashTarget(null)}
                >
                  キャンセル
                </Button>
                <Button
                  className="flex-1"
                  variant="destructive"
                  disabled={isRegisteringPettyCash}
                  onClick={() => handlePettyCashRegister(pettyCashTarget)}
                >
                  {isRegisteringPettyCash && <Loader2 className="mr-2 size-4 animate-spin" />}
                  出金登録する
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 画像拡大プレビュー */}
      <Dialog open={!!previewReceipt} onOpenChange={(open) => !open && setPreviewReceipt(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {previewReceipt?.store_name || "領収書"}
              {previewReceipt?.amount != null && (
                <span className="ml-2 text-muted-foreground">
                  ¥{previewReceipt.amount.toLocaleString()}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          {previewReceipt && (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground">
                {previewReceipt.staff_name} ／ {previewReceipt.date || "日付不明"} ／ 登録: {formatRegisteredAt(previewReceipt.created_at)}
              </div>

              {/* 本体（画像 or PDFはアイコン案内） */}
              <div className="flex max-h-[60vh] items-center justify-center overflow-auto rounded-lg border bg-muted/30 p-2">
                {isPdfFile(previewReceipt) ? (
                  <div className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground">
                    <FileText className="size-12" />
                    <p className="text-sm">PDFファイルです。下のボタンからDropboxで開いてください。</p>
                  </div>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/staff-receipts/image?id=${previewReceipt.id}`}
                    alt={`${previewReceipt.store_name || "領収書"}の画像`}
                    className="max-h-[58vh] w-auto object-contain"
                  />
                )}
              </div>

              <div className="flex justify-end gap-3">
                <Button
                  variant="outline"
                  disabled={isOpeningDropbox}
                  onClick={() => handleOpenInDropbox(previewReceipt)}
                >
                  {isOpeningDropbox ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ExternalLink className="mr-2 size-4" />}
                  Dropboxで開く
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
