"use client"

import { useCallback, useEffect, useState } from "react"
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
import { DocumentTable } from "@/components/documents/document-table"
import { Loader2, Plus, Search, X } from "lucide-react"
import { toast } from "sonner"
import type { Database } from "@/types/database"
import type { DocumentStatus } from "@/types"

type Document = Database["public"]["Tables"]["documents"]["Row"]
type SortField = "type" | "vendor_name" | "amount" | "issue_date" | "due_date" | "status" | "created_at"
type SortDirection = "asc" | "desc"

const PAGE_SIZE = 20

const typeOptions: { value: string; label: string }[] = [
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

  const hasFilters = search || typeFilter !== "all" || statusFilter !== "all" || dateFrom || dateTo

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">書類一覧</h1>
        <Button asChild>
          <Link href="/documents/new">
            <Plus className="size-4" />
            新規登録
          </Link>
        </Button>
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
        </div>
      </div>

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
    </div>
  )
}
