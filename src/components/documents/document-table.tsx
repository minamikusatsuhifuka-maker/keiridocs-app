"use client"

import { useState } from "react"
import Link from "next/link"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { StatusBadge } from "@/components/documents/status-badge"
import { ArrowUpDown, ChevronDown, Eye } from "lucide-react"
import type { Database } from "@/types/database"
import type { DocumentStatus } from "@/types"
import { toast } from "sonner"

type Document = Database["public"]["Tables"]["documents"]["Row"]

// ソート可能なカラム
type SortField = "type" | "vendor_name" | "amount" | "issue_date" | "due_date" | "status" | "created_at"
type SortDirection = "asc" | "desc"

interface DocumentTableProps {
  documents: Document[]
  sortField: SortField
  sortDirection: SortDirection
  onSort: (field: SortField) => void
  onStatusChange: (id: string, newStatus: DocumentStatus) => void
  selectedIds?: Set<string>
  onSelectionChange?: (ids: Set<string>) => void
}

const statuses: DocumentStatus[] = ["未処理", "処理済み", "アーカイブ"]

/** 金額をカンマ区切りでフォーマット */
function formatAmount(amount: number | null): string {
  if (amount === null) return "-"
  return `¥${amount.toLocaleString()}`
}

/** 日付を yyyy/MM/dd でフォーマット */
function formatDate(date: string | null): string {
  if (!date) return "-"
  return new Date(date).toLocaleDateString("ja-JP")
}

export function DocumentTable({
  documents,
  sortField,
  sortDirection,
  onSort,
  onStatusChange,
  selectedIds,
  onSelectionChange,
}: DocumentTableProps) {
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  const hasSelection = !!selectedIds && !!onSelectionChange

  // 全選択/全解除
  function toggleSelectAll() {
    if (!onSelectionChange) return
    if (selectedIds && selectedIds.size === documents.length) {
      onSelectionChange(new Set())
    } else {
      onSelectionChange(new Set(documents.map((d) => d.id)))
    }
  }

  // 個別選択切り替え
  function toggleSelect(id: string) {
    if (!onSelectionChange || !selectedIds) return
    const next = new Set(selectedIds)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    onSelectionChange(next)
  }

  // ステータス変更ハンドラ
  async function handleStatusChange(doc: Document, newStatus: DocumentStatus) {
    if (doc.status === newStatus) return
    setUpdatingId(doc.id)
    try {
      const res = await fetch(`/api/documents?id=${doc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      })
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(data.error ?? "ステータス変更に失敗しました")
      }
      onStatusChange(doc.id, newStatus)
      toast.success(`ステータスを「${newStatus}」に変更しました`)
    } catch (error) {
      const message = error instanceof Error ? error.message : "ステータス変更に失敗しました"
      toast.error(message)
    } finally {
      setUpdatingId(null)
    }
  }

  // ソートインジケーター
  function SortIcon({ field }: { field: SortField }) {
    const isActive = sortField === field
    return (
      <ArrowUpDown
        className={`ml-1 inline size-3.5 ${isActive ? "text-foreground" : "text-muted-foreground/50"}`}
        style={isActive ? { transform: sortDirection === "desc" ? "scaleY(-1)" : undefined } : undefined}
      />
    )
  }

  // ソート可能なヘッダー
  function SortableHead({ field, children }: { field: SortField; children: React.ReactNode }) {
    return (
      <TableHead>
        <button
          type="button"
          className="flex items-center hover:text-foreground transition-colors"
          onClick={() => onSort(field)}
        >
          {children}
          <SortIcon field={field} />
        </button>
      </TableHead>
    )
  }

  if (documents.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        書類が見つかりません
      </div>
    )
  }

  const allSelected = selectedIds && selectedIds.size === documents.length
  const someSelected = selectedIds && selectedIds.size > 0 && selectedIds.size < documents.length

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {hasSelection && (
            <TableHead className="w-[40px]">
              <Checkbox
                checked={allSelected ? true : someSelected ? "indeterminate" : false}
                onCheckedChange={toggleSelectAll}
                aria-label="全選択"
              />
            </TableHead>
          )}
          <SortableHead field="type">種別</SortableHead>
          <SortableHead field="vendor_name">取引先</SortableHead>
          <SortableHead field="amount">金額</SortableHead>
          <SortableHead field="issue_date">発行日</SortableHead>
          <SortableHead field="due_date">支払期日</SortableHead>
          <TableHead className="hidden lg:table-cell">税区分</TableHead>
          <TableHead className="hidden lg:table-cell">勘定科目</TableHead>
          <SortableHead field="status">ステータス</SortableHead>
          <TableHead>操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {documents.map((doc) => (
          <TableRow
            key={doc.id}
            className={hasSelection && selectedIds?.has(doc.id) ? "bg-muted/50" : undefined}
          >
            {hasSelection && (
              <TableCell>
                <Checkbox
                  checked={selectedIds?.has(doc.id) ?? false}
                  onCheckedChange={() => toggleSelect(doc.id)}
                  aria-label={`${doc.vendor_name}を選択`}
                />
              </TableCell>
            )}
            <TableCell>{doc.type}</TableCell>
            <TableCell className="max-w-[200px] truncate">{doc.vendor_name}</TableCell>
            <TableCell className="text-right">{formatAmount(doc.amount)}</TableCell>
            <TableCell>{formatDate(doc.issue_date)}</TableCell>
            <TableCell>{formatDate(doc.due_date)}</TableCell>
            <TableCell className="hidden lg:table-cell text-xs">{doc.tax_category || "-"}</TableCell>
            <TableCell className="hidden lg:table-cell text-xs">{doc.account_title || "-"}</TableCell>
            <TableCell>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center gap-1 focus:outline-none"
                    disabled={updatingId === doc.id}
                  >
                    <StatusBadge status={doc.status as DocumentStatus} />
                    <ChevronDown className="size-3 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {statuses.map((s) => (
                    <DropdownMenuItem
                      key={s}
                      onClick={() => handleStatusChange(doc, s)}
                      disabled={doc.status === s}
                    >
                      <StatusBadge status={s} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
            <TableCell>
              <Button variant="ghost" size="icon-xs" asChild>
                <Link href={`/documents/${doc.id}`}>
                  <Eye className="size-4" />
                </Link>
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
