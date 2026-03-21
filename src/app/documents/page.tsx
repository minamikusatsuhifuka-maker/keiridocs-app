"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { DocumentTable } from "@/components/documents/document-table"
import { Download, Loader2, Plus, Search, X, Copy, Trash2, AlertTriangle, RefreshCw, CheckCircle2, XCircle, ScanLine } from "lucide-react"
import { toast } from "sonner"
import type { Database } from "@/types/database"
import type { DocumentStatus } from "@/types"

type Document = Database["public"]["Tables"]["documents"]["Row"]
type SortField = "type" | "vendor_name" | "amount" | "issue_date" | "due_date" | "status" | "created_at"
type SortDirection = "asc" | "desc"

/** 重複グループ（3段階対応） */
interface DuplicateGroup {
  level: "exact" | "likely" | "similar"
  match_reason: string
  vendor_name: string
  amount: number | null
  type: string
  documents: {
    id: string
    vendor_name: string
    amount: number | null
    type: string
    issue_date: string | null
    due_date: string | null
    dropbox_path: string | null
    file_hash: string | null
    created_at: string
  }[]
}

/** 重複レベルに応じたスタイル */
const LEVEL_STYLES: Record<string, { border: string; badge: string; badgeText: string; label: string }> = {
  exact: { border: "border-l-4 border-red-500 bg-red-50 dark:bg-red-950", badge: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200", badgeText: "完全重複", label: "同一ファイルです" },
  likely: { border: "border-l-4 border-orange-500 bg-orange-50 dark:bg-orange-950", badge: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200", badgeText: "重複の可能性", label: "取引先・金額・日付が一致" },
  similar: { border: "border-l-4 border-gray-400 bg-gray-50 dark:bg-gray-900", badge: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300", badgeText: "類似書類", label: "取引先・金額が一致（参考情報）" },
}

const PAGE_SIZE = 20

const DEFAULT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "すべての種別" },
  { value: "請求書", label: "請求書" },
  { value: "領収書", label: "領収書" },
  { value: "契約書", label: "契約書" },
]

const statusOptions: { value: string; label: string }[] = [
  { value: "all", label: "すべてのステータス" },
  { value: "未処理", label: "未処理" },
  { value: "処理済み", label: "処理済み" },
  { value: "アーカイブ", label: "アーカイブ" },
]

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<Document[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [isLoading, setIsLoading] = useState(true)

  // 動的書類種別
  const [dynamicTypes, setDynamicTypes] = useState<{ name: string }[]>([])

  // 動的種別をフィルタオプションに変換
  const typeOptions = useMemo(() => {
    if (dynamicTypes.length === 0) return DEFAULT_TYPE_OPTIONS
    return [
      { value: "all", label: "すべての種別" },
      ...dynamicTypes.map((t) => ({ value: t.name, label: t.name })),
    ]
  }, [dynamicTypes])

  // 書類種別リストを取得
  useEffect(() => {
    async function fetchTypes() {
      try {
        const res = await fetch("/api/settings?table=document_types")
        if (!res.ok) return
        const json = await res.json() as { data: { name: string }[] }
        if (json.data && json.data.length > 0) {
          setDynamicTypes(json.data)
        }
      } catch {
        // フォールバック: デフォルトを使う
      }
    }
    fetchTypes()
  }, [])

  // フィルタ
  const [search, setSearch] = useState("")
  const [typeFilter, setTypeFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")

  // ソート
  const [sortField, setSortField] = useState<SortField>("created_at")
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc")

  // ページネーション
  const [page, setPage] = useState(0)

  const totalPages = Math.ceil(totalCount / PAGE_SIZE)

  // データ取得
  const fetchDocuments = useCallback(async () => {
    setIsLoading(true)
    setSelectedDocIds(new Set())
    try {
      const params = new URLSearchParams()
      params.set("limit", String(PAGE_SIZE))
      params.set("offset", String(page * PAGE_SIZE))
      params.set("sort", sortField)
      params.set("direction", sortDirection)

      if (search) params.set("search", search)
      if (typeFilter !== "all") params.set("type", typeFilter)
      if (statusFilter !== "all") params.set("status", statusFilter)
      if (dateFrom) params.set("date_from", dateFrom)
      if (dateTo) params.set("date_to", dateTo)

      const res = await fetch(`/api/documents?${params.toString()}`)
      if (!res.ok) throw new Error("データの取得に失敗しました")
      const json = await res.json() as { data: Document[]; count: number | null }
      setDocuments(json.data ?? [])
      setTotalCount(json.count ?? 0)
    } catch {
      toast.error("書類データの取得に失敗しました")
      setDocuments([])
      setTotalCount(0)
    } finally {
      setIsLoading(false)
    }
  }, [search, typeFilter, statusFilter, dateFrom, dateTo, sortField, sortDirection, page])

  useEffect(() => {
    fetchDocuments()
  }, [fetchDocuments])

  // ソートハンドラ
  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortField(field)
      setSortDirection("asc")
    }
    setPage(0)
  }

  // ステータス変更をローカルに反映
  function handleStatusChange(id: string, newStatus: DocumentStatus) {
    setDocuments((prev) =>
      prev.map((doc) => (doc.id === id ? { ...doc, status: newStatus } : doc))
    )
  }

  // 検索実行
  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault()
    setPage(0)
    fetchDocuments()
  }

  // フィルタリセット
  function handleReset() {
    setSearch("")
    setTypeFilter("all")
    setStatusFilter("all")
    setDateFrom("")
    setDateTo("")
    setPage(0)
  }

  // 一覧チェックボックス選択（一括削除用）
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set())
  const [isBulkDeleting, setIsBulkDeleting] = useState(false)
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false)

  // 重複チェック
  const [isDuplicateChecking, setIsDuplicateChecking] = useState(false)
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([])
  const [showDuplicateModal, setShowDuplicateModal] = useState(false)
  const [selectedForDeletion, setSelectedForDeletion] = useState<Set<string>>(new Set())
  const [isDeleting, setIsDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Dropboxスキャン
  const [isScanning, setIsScanning] = useState(false)
  const [showScanResult, setShowScanResult] = useState(false)
  const [scanResult, setScanResult] = useState<{
    scanned: number
    registered: number
    needs_review: number
    errors: number
    details: {
      filename: string
      status: "registered" | "needs_review" | "error"
      vendor?: string
      type?: string
      amount?: number | null
      reasons?: string[]
      error?: string
    }[]
  } | null>(null)

  // CSVエクスポート
  const [isExporting, setIsExporting] = useState(false)

  // 重複チェック実行
  async function handleDuplicateCheck() {
    setIsDuplicateChecking(true)
    try {
      const res = await fetch("/api/documents/duplicates")
      const json = await res.json() as { data?: DuplicateGroup[]; error?: string }

      if (!res.ok) {
        throw new Error(json.error || "重複チェックに失敗しました")
      }

      const groups = json.data ?? []

      if (groups.length === 0) {
        toast.success("重複書類はありませんでした")
        return
      }

      setDuplicateGroups(groups)
      setSelectedForDeletion(new Set())
      setShowDuplicateModal(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重複チェックに失敗しました")
    } finally {
      setIsDuplicateChecking(false)
    }
  }

  // 完全一致グループで「新しい方を残す」（古い方を自動選択）
  function selectOlderForDeletion(group: DuplicateGroup) {
    // created_at でソートし、最新の1件以外を選択
    const sorted = [...group.documents].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
    setSelectedForDeletion((prev) => {
      const next = new Set(prev)
      // 最新（sorted[0]）以外を選択
      for (let i = 1; i < sorted.length; i++) {
        next.add(sorted[i].id)
      }
      return next
    })
  }

  // 削除チェックボックスの切り替え
  function toggleDeletionSelection(docId: string) {
    setSelectedForDeletion((prev) => {
      const next = new Set(prev)
      if (next.has(docId)) {
        next.delete(docId)
      } else {
        next.add(docId)
      }
      return next
    })
  }

  // 選択した書類を一括削除
  async function handleBulkDelete() {
    if (selectedForDeletion.size === 0) return
    setIsDeleting(true)
    try {
      const ids = Array.from(selectedForDeletion)
      console.log("削除リクエスト:", ids)
      let successCount = 0
      const errors: string[] = []

      for (const id of ids) {
        const res = await fetch(`/api/documents?id=${id}`, { method: "DELETE" })
        if (res.ok) {
          successCount++
        } else {
          const json = await res.json().catch(() => ({ error: "不明なエラー" })) as { error?: string }
          const errMsg = `書類 ${id}: ${json.error || res.statusText}`
          console.error("削除失敗:", errMsg)
          errors.push(errMsg)
        }
      }

      if (successCount > 0) {
        toast.success(`${successCount}件の書類を削除しました（Dropboxからも削除済み）`)
      }
      if (errors.length > 0) {
        toast.error(`${errors.length}件の削除に失敗: ${errors[0]}`)
      }
      setShowDeleteConfirm(false)
      setShowDuplicateModal(false)
      setSelectedForDeletion(new Set())
      setDuplicateGroups([])
      // 一覧を再取得
      fetchDocuments()
    } catch {
      toast.error("削除処理に失敗しました")
    } finally {
      setIsDeleting(false)
    }
  }

  // 一括削除（一覧チェックボックスから）
  async function handleBulkDeleteFromList() {
    if (selectedDocIds.size === 0) return
    setIsBulkDeleting(true)
    try {
      const ids = Array.from(selectedDocIds)
      let successCount = 0
      const errors: string[] = []

      for (const id of ids) {
        const res = await fetch(`/api/documents?id=${id}`, { method: "DELETE" })
        if (res.ok) {
          successCount++
        } else {
          const json = await res.json().catch(() => ({ error: "不明なエラー" })) as { error?: string }
          errors.push(json.error || res.statusText)
        }
      }

      if (successCount > 0) {
        toast.success(`${successCount}件の書類を削除しました（Dropboxからも削除済み）`)
      }
      if (errors.length > 0) {
        toast.error(`${errors.length}件の削除に失敗: ${errors[0]}`)
      }
      setShowBulkDeleteConfirm(false)
      setSelectedDocIds(new Set())
      fetchDocuments()
    } catch {
      toast.error("削除処理に失敗しました")
    } finally {
      setIsBulkDeleting(false)
    }
  }

  // Dropboxスキャン実行
  async function handleScan() {
    setIsScanning(true)
    setScanResult(null)
    try {
      const res = await fetch("/api/cron/scan-dropbox", { method: "POST" })
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(json.error || "スキャンに失敗しました")
      }
      const result = await res.json() as typeof scanResult
      setScanResult(result)

      if (!result || result.scanned === 0) {
        toast("新しいファイルはありませんでした")
      } else {
        if (result.registered > 0) {
          toast.success(`${result.registered}件の書類を自動登録しました`)
        }
        if (result.needs_review > 0) {
          toast.warning(`${result.needs_review}件の要確認書類があります`)
        }
        if (result.errors > 0) {
          toast.error(`${result.errors}件のエラーが発生しました`)
        }
        setShowScanResult(true)
        fetchDocuments()
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "スキャンに失敗しました")
    } finally {
      setIsScanning(false)
    }
  }

  async function handleExportCsv() {
    setIsExporting(true)
    try {
      // 現在のフィルタ条件で全件取得（ページネーションなし）
      const params = new URLSearchParams()
      params.set("limit", "10000")
      params.set("offset", "0")
      params.set("sort", sortField)
      params.set("direction", sortDirection)

      if (search) params.set("search", search)
      if (typeFilter !== "all") params.set("type", typeFilter)
      if (statusFilter !== "all") params.set("status", statusFilter)
      if (dateFrom) params.set("date_from", dateFrom)
      if (dateTo) params.set("date_to", dateTo)

      const res = await fetch(`/api/documents?${params.toString()}`)
      if (!res.ok) throw new Error("データの取得に失敗しました")
      const json = await res.json() as { data: Document[] }
      const allDocs = json.data ?? []

      // CSVヘッダー
      const headers = ["種別", "取引先名", "金額", "発行日", "支払期日", "ステータス", "摘要", "入力経路", "登録日時"]

      // CSV行を生成
      const rows = allDocs.map((doc) => [
        doc.type,
        doc.vendor_name,
        doc.amount != null ? String(doc.amount) : "",
        doc.issue_date ?? "",
        doc.due_date ?? "",
        doc.status,
        doc.description ?? "",
        doc.input_method,
        doc.created_at ? new Date(doc.created_at).toLocaleString("ja-JP") : "",
      ])

      // CSVセルをエスケープ（ダブルクォートやカンマを含む場合）
      function escapeCsvCell(value: string): string {
        if (value.includes(",") || value.includes('"') || value.includes("\n")) {
          return `"${value.replace(/"/g, '""')}"`
        }
        return value
      }

      const csvContent = [
        headers.map(escapeCsvCell).join(","),
        ...rows.map((row) => row.map(escapeCsvCell).join(",")),
      ].join("\n")

      // UTF-8 BOM付きでBlobを生成（Excel文字化け対策）
      const bom = new Uint8Array([0xEF, 0xBB, 0xBF])
      const blob = new Blob([bom, csvContent], { type: "text/csv;charset=utf-8" })

      // ファイル名: 経理書類_YYYY-MM-DD.csv
      const today = new Date()
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
      const fileName = `経理書類_${dateStr}.csv`

      // ダウンロード
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      toast.success(`${allDocs.length}件のデータをエクスポートしました`)
    } catch {
      toast.error("CSVエクスポートに失敗しました")
    } finally {
      setIsExporting(false)
    }
  }

  const hasFilters = search || typeFilter !== "all" || statusFilter !== "all" || dateFrom || dateTo

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">書類一覧</h1>
        <div className="flex gap-2">
          <div className="tooltip-wrapper">
            <Button
              onClick={handleScan}
              disabled={isScanning}
              className="btn-float-primary rounded-lg px-4 py-2 text-sm text-white"
              size="sm"
              style={{
                background: "linear-gradient(135deg, #C8922A, #B8782A)",
                boxShadow: "0 4px 12px rgba(180,120,40,0.35)",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "linear-gradient(135deg, #B8822A, #A8682A)" }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "linear-gradient(135deg, #C8922A, #B8782A)" }}
            >
              {isScanning ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ScanLine className="size-4" />
              )}
              {isScanning ? "スキャン中..." : "スキャン"}
            </Button>
            <span className="tooltip-text">Dropbox内の未登録ファイルを自動でAI解析・登録・仕分けします</span>
          </div>
          <Button asChild className="btn-float-primary">
            <Link href="/documents/new">
              <Plus className="size-4" />
              新規登録
            </Link>
          </Button>
        </div>
      </div>

      {/* 検索・フィルタ */}
      <div className="space-y-3">
        <form onSubmit={handleSearchSubmit} className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="取引先名・摘要で検索..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="secondary">
            検索
          </Button>
        </form>

        <div className="flex flex-wrap gap-2 items-end">
          <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v); setPage(0) }}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {typeOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0) }}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {statusOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-1">
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => { setDateFrom(e.target.value); setPage(0) }}
              className="w-[150px]"
            />
            <span className="text-muted-foreground text-sm">〜</span>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setPage(0) }}
              className="w-[150px]"
            />
          </div>

          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={handleReset}>
              <X className="size-3.5" />
              リセット
            </Button>
          )}

          <Button variant="outline" size="sm" onClick={handleDuplicateCheck} disabled={isDuplicateChecking} className="btn-float">
            {isDuplicateChecking ? <Loader2 className="size-3.5 animate-spin" /> : <Copy className="size-3.5" />}
            重複チェック
          </Button>

          <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={isExporting} className="btn-float">
            {isExporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            CSVエクスポート
          </Button>
        </div>
      </div>

      {/* 一括削除アクションバー */}
      {selectedDocIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border bg-muted/50 px-4 py-2.5">
          <span className="text-sm font-medium">{selectedDocIds.size}件選択中</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedDocIds(new Set())}
          >
            選択を解除
          </Button>
          <div className="tooltip-wrapper">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowBulkDeleteConfirm(true)}
              className="btn-float-danger"
            >
              <Trash2 className="mr-1.5 size-3.5" />
              選択した書類を削除
            </Button>
            <span className="tooltip-text">チェックした書類をDBとDropboxから一括削除します</span>
          </div>
        </div>
      )}

      {/* テーブル */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <DocumentTable
          documents={documents}
          sortField={sortField}
          sortDirection={sortDirection}
          onSort={handleSort}
          onStatusChange={handleStatusChange}
          selectedIds={selectedDocIds}
          onSelectionChange={setSelectedDocIds}
        />
      )}

      {/* ページネーション */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            全 {totalCount} 件中 {page * PAGE_SIZE + 1}〜{Math.min((page + 1) * PAGE_SIZE, totalCount)} 件
          </p>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              前へ
            </Button>
            {Array.from({ length: totalPages }, (_, i) => (
              <Button
                key={i}
                variant={page === i ? "default" : "outline"}
                size="sm"
                onClick={() => setPage(i)}
                className="min-w-[36px]"
              >
                {i + 1}
              </Button>
            )).slice(
              Math.max(0, page - 2),
              Math.min(totalPages, page + 3)
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              次へ
            </Button>
          </div>
        </div>
      )}

      {/* 重複チェック結果モーダル */}
      <Dialog open={showDuplicateModal} onOpenChange={setShowDuplicateModal}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-600" />
              重複候補 ({duplicateGroups.length}グループ)
            </DialogTitle>
            <DialogDescription>
              重複レベルごとに色分けされています。削除する書類にチェックを入れてください。
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4 pr-1">
            {duplicateGroups.map((group, gi) => {
              const style = LEVEL_STYLES[group.level] ?? LEVEL_STYLES.similar
              return (
                <div key={`${group.level}-${gi}`} className={`rounded-md p-4 ${style.border}`}>
                  <div className="mb-2 flex items-center gap-2 flex-wrap">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${style.badge}`}>
                      {style.badgeText}
                    </span>
                    <span className="font-medium">
                      {group.vendor_name} ・ {group.type}
                      {group.amount != null && ` ・ ¥${group.amount.toLocaleString()}`}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      ({group.documents.length}件)
                    </span>
                  </div>
                  <div className="mb-2 text-xs text-muted-foreground">
                    {group.match_reason}
                  </div>
                  {/* 完全一致グループには「新しい方を残す」ボタン */}
                  {group.level === "exact" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mb-2"
                      onClick={() => selectOlderForDeletion(group)}
                    >
                      新しい方を残す（古い方を自動選択）
                    </Button>
                  )}
                  <div className="space-y-2">
                    {group.documents.map((doc) => (
                      <label
                        key={doc.id}
                        className={`flex items-start gap-3 rounded-md border p-3 hover:bg-muted/50 cursor-pointer ${
                          selectedForDeletion.has(doc.id) ? "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800" : ""
                        }`}
                      >
                        <Checkbox
                          checked={selectedForDeletion.has(doc.id)}
                          onCheckedChange={() => toggleDeletionSelection(doc.id)}
                          className="mt-0.5"
                        />
                        <div className="flex-1 text-sm">
                          <div>
                            {doc.issue_date && <span>発行日: {doc.issue_date}</span>}
                            {doc.due_date && <span className="ml-3">支払期日: {doc.due_date}</span>}
                          </div>
                          {doc.dropbox_path && (
                            <div className="mt-0.5 text-xs text-muted-foreground truncate">
                              {doc.dropbox_path}
                            </div>
                          )}
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            登録日時: {new Date(doc.created_at).toLocaleString("ja-JP")}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowDuplicateModal(false)}>
              閉じる
            </Button>
            <Button
              variant="destructive"
              disabled={selectedForDeletion.size === 0}
              onClick={() => setShowDeleteConfirm(true)}
            >
              <Trash2 className="mr-2 size-4" />
              選択した書類を削除 ({selectedForDeletion.size}件)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 一括削除確認ダイアログ（一覧チェックボックスから） */}
      <Dialog open={showBulkDeleteConfirm} onOpenChange={setShowBulkDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="size-5" />
              削除の確認
            </DialogTitle>
            <DialogDescription>
              {selectedDocIds.size}件の書類を削除しますか？Dropboxからもファイルが削除されます。この操作は取り消せません。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowBulkDeleteConfirm(false)} disabled={isBulkDeleting}>
              キャンセル
            </Button>
            <Button variant="destructive" onClick={handleBulkDeleteFromList} disabled={isBulkDeleting}>
              {isBulkDeleting ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  削除中...
                </>
              ) : (
                "削除する"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 削除確認ダイアログ（重複チェックから） */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="size-5" />
              削除の確認
            </DialogTitle>
            <DialogDescription>
              {selectedForDeletion.size}件の書類を削除します。Dropboxからもファイルが削除されます。この操作は取り消せません。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)} disabled={isDeleting}>
              キャンセル
            </Button>
            <Button variant="destructive" onClick={handleBulkDelete} disabled={isDeleting}>
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  削除中...
                </>
              ) : (
                "本当に削除する"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* スキャン結果モーダル */}
      <Dialog open={showScanResult} onOpenChange={setShowScanResult}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="size-5" />
              スキャン結果
            </DialogTitle>
            <DialogDescription>
              {scanResult?.scanned ?? 0}件のファイルを処理しました
            </DialogDescription>
          </DialogHeader>
          {scanResult && scanResult.details.length > 0 && (
            <div className="max-h-60 space-y-2 overflow-y-auto">
              {scanResult.details.map((d, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
                    d.status === "registered"
                      ? "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/30"
                      : d.status === "needs_review"
                        ? "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"
                        : "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30"
                  }`}
                >
                  {d.status === "registered" ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[#A0703A]" />
                  ) : d.status === "needs_review" ? (
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-red-600" />
                  )}
                  <div className="min-w-0 flex-1">
                    {d.status === "registered" && d.vendor ? (
                      <span>
                        {d.vendor} / {d.type} / ¥{(d.amount ?? 0).toLocaleString()}
                      </span>
                    ) : d.status === "needs_review" ? (
                      <span>
                        {d.filename} — {d.reasons?.join("、")}
                      </span>
                    ) : (
                      <span>
                        {d.filename} — {d.error}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setShowScanResult(false)}>閉じる</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
