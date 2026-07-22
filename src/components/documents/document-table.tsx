"use client"

import { useEffect, useState } from "react"
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { StatusBadge } from "@/components/documents/status-badge"
import {
  AlertTriangle,
  ArrowUpDown,
  Calendar,
  Check,
  ChevronDown,
  Eye,
  GripVertical,
  Loader2,
  RotateCcw,
} from "lucide-react"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type { Database } from "@/types/database"
import type { DocumentStatus } from "@/types"
import { toast } from "sonner"

type Document = Database["public"]["Tables"]["documents"]["Row"] & {
  registrant?: { id: string; name: string } | null
}

// ソート可能なカラム
type SortField = "type" | "vendor_name" | "amount" | "issue_date" | "due_date" | "status" | "created_at"
type SortDirection = "asc" | "desc"

// 並べ替え可能なカラムのID（先頭のチェックボックスと右端の「操作」は固定＝対象外）
type ColumnId =
  | "type"
  | "vendor_name"
  | "amount"
  | "created_at"
  | "registrant"
  | "issue_date"
  | "due_date"
  | "tax_category"
  | "account_title"
  | "payment_purpose"
  | "status"

// 既定の列順（正規化・「既定に戻す」の基準）
const DEFAULT_COLUMN_ORDER: ColumnId[] = [
  "type",
  "vendor_name",
  "amount",
  "created_at",
  "registrant",
  "issue_date",
  "due_date",
  "tax_category",
  "account_title",
  "payment_purpose",
  "status",
]

// カラム定義（ヘッダーラベル・ソート対象・セル描画）
interface ColumnDef {
  id: ColumnId
  label: string
  sortField?: SortField
  headClassName?: string
  cellClassName?: string
  renderCell: (doc: Document) => React.ReactNode
}

interface DocumentTableProps {
  documents: Document[]
  sortField: SortField
  sortDirection: SortDirection
  onSort: (field: SortField) => void
  onStatusChange: (id: string, newStatus: DocumentStatus) => void
  selectedIds?: Set<string>
  onSelectionChange?: (ids: Set<string>) => void
  /** 列順をタブごとに保存するためのキー（経費書類 / 売上 で別々に保持） */
  tab?: string
}

const statuses: DocumentStatus[] = ["要振込", "処理済み", "アーカイブ"]

/** localStorage の保存キー（ブラウザ単位・タブごと） */
function columnOrderStorageKey(tab: string): string {
  return `keiridocs:documentTable:columnOrder:${tab}`
}

/**
 * 保存済みの並び順を正規化する。
 * - 未知の列は無視（列が減っても壊れない）
 * - 欠けている既知列は既定順で末尾に補完（列が増えても追従）
 * - 重複は除去
 */
function normalizeColumnOrder(saved: unknown): ColumnId[] {
  const known = new Set<string>(DEFAULT_COLUMN_ORDER)
  const seen = new Set<ColumnId>()
  const result: ColumnId[] = []
  if (Array.isArray(saved)) {
    for (const id of saved) {
      if (typeof id === "string" && known.has(id) && !seen.has(id as ColumnId)) {
        result.push(id as ColumnId)
        seen.add(id as ColumnId)
      }
    }
  }
  for (const id of DEFAULT_COLUMN_ORDER) {
    if (!seen.has(id)) result.push(id)
  }
  return result
}

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

/**
 * 支払い内容（AI要約）セル：セル内は省略表示のまま、
 * ホバー（デスクトップ）／タップ（タッチ端末）で全文をポップアップ表示する。
 */
function PaymentPurposeCell({ value }: { value: string | null }) {
  const [open, setOpen] = useState(false)

  // NULL=未生成（遅延生成の待ち）。空=判定不能。
  if (value == null) {
    return <span className="text-xs text-muted-foreground/60">—</span>
  }
  const text = value.trim()
  if (text === "") {
    return <span className="text-xs text-muted-foreground">-</span>
  }

  const PREVIEW = 12
  const isLong = text.length > PREVIEW
  const preview = isLong ? `${text.slice(0, PREVIEW)}…` : text

  // 短文はポップアップ不要でそのまま表示
  if (!isLong) {
    return <span className="text-xs">{text}</span>
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          // デスクトップはホバーで開閉、タッチ端末はタップ（Radixのトリガー/onOpenChange）で開閉
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          className="max-w-[210px] truncate text-left text-xs hover:text-foreground transition-colors cursor-default"
          aria-label="支払い内容の全文を表示"
        >
          {preview}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        // クリックでフォーカスを奪わない（ホバー表示を安定させる）
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-auto max-w-sm max-h-60 overflow-y-auto p-3 text-sm leading-relaxed whitespace-pre-wrap break-words"
      >
        {text}
      </PopoverContent>
    </Popover>
  )
}

/** ソートインジケーター */
function SortIcon({
  active,
  direction,
}: {
  active: boolean
  direction: SortDirection
}) {
  return (
    <ArrowUpDown
      className={`ml-1 inline size-3.5 ${active ? "text-foreground" : "text-muted-foreground/50"}`}
      style={active ? { transform: direction === "desc" ? "scaleY(-1)" : undefined } : undefined}
    />
  )
}

/**
 * 並べ替え可能なヘッダーセル。
 * グリップ（⋮⋮）でドラッグして列順を変更。ソート対象列はラベルクリックで従来通りソート。
 */
function SortableHeaderCell({
  column,
  sortField,
  sortDirection,
  onSort,
}: {
  column: ColumnDef
  sortField: SortField
  sortDirection: SortDirection
  onSort: (field: SortField) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: column.id })

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : undefined,
    zIndex: isDragging ? 10 : undefined,
    position: isDragging ? "relative" : undefined,
  }

  const isActive = sortField === column.sortField

  return (
    <TableHead ref={setNodeRef} style={style} className={column.headClassName}>
      <div className="flex items-center gap-1">
        {/* ドラッグ用グリップ（列順の変更） */}
        <button
          type="button"
          className="cursor-grab touch-none text-muted-foreground/40 hover:text-foreground active:cursor-grabbing"
          aria-label={`${column.label}列を並べ替え`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </button>
        {column.sortField ? (
          <button
            type="button"
            className="flex items-center hover:text-foreground transition-colors"
            onClick={() => onSort(column.sortField!)}
          >
            {column.label}
            <SortIcon active={isActive} direction={sortDirection} />
          </button>
        ) : (
          <span>{column.label}</span>
        )}
      </div>
    </TableHead>
  )
}

export function DocumentTable({
  documents,
  sortField,
  sortDirection,
  onSort,
  onStatusChange,
  selectedIds,
  onSelectionChange,
  tab = "default",
}: DocumentTableProps) {
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [calendarLoadingId, setCalendarLoadingId] = useState<string | null>(null)
  // カレンダー登録済みIDをローカル管理（DBの calendar_event_id 更新を即時反映）
  const [registeredEventIds, setRegisteredEventIds] = useState<Record<string, string>>({})

  // 列の並び順（localStorage・タブごとに保存）。SSRとの不一致を避けるため
  // 初期値は既定順とし、マウント後に localStorage から読み込む。
  const [columnOrder, setColumnOrder] = useState<ColumnId[]>(DEFAULT_COLUMN_ORDER)

  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      const raw = window.localStorage.getItem(columnOrderStorageKey(tab))
      setColumnOrder(normalizeColumnOrder(raw ? JSON.parse(raw) : null))
    } catch {
      setColumnOrder(DEFAULT_COLUMN_ORDER)
    }
  }, [tab])

  // 並び順を保存
  function persistColumnOrder(next: ColumnId[]) {
    setColumnOrder(next)
    try {
      window.localStorage.setItem(columnOrderStorageKey(tab), JSON.stringify(next))
    } catch {
      // localStorage 非対応/満杯でも表示は継続
    }
  }

  // 既定に戻す
  function resetColumnOrder() {
    setColumnOrder(DEFAULT_COLUMN_ORDER)
    try {
      window.localStorage.removeItem(columnOrderStorageKey(tab))
    } catch {
      // 失敗しても既定順の表示は維持される
    }
  }

  const isDefaultOrder =
    columnOrder.length === DEFAULT_COLUMN_ORDER.length &&
    columnOrder.every((id, i) => id === DEFAULT_COLUMN_ORDER[i])

  // DnD センサー（8px 動かすまではドラッグ扱いにしない＝クリックとの誤動作を防ぐ）
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = columnOrder.indexOf(active.id as ColumnId)
    const newIndex = columnOrder.indexOf(over.id as ColumnId)
    if (oldIndex < 0 || newIndex < 0) return
    persistColumnOrder(arrayMove(columnOrder, oldIndex, newIndex))
  }

  // カレンダー登録ハンドラ
  async function handleCalendarRegister(doc: Document) {
    if (!doc.due_date) return
    setCalendarLoadingId(doc.id)
    try {
      const res = await fetch("/api/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: doc.id }),
      })
      const json = (await res.json()) as {
        data?: { eventId: string; alreadyRegistered?: boolean }
        error?: string
        configRequired?: boolean
      }
      if (res.status === 412 || json.configRequired) {
        toast.error(
          "Google カレンダー連携が未設定です。設定ページから連携してください",
          {
            action: {
              label: "設定を開く",
              onClick: () => {
                window.location.href = "/settings"
              },
            },
          }
        )
        return
      }
      if (!res.ok || !json.data) {
        throw new Error(json.error ?? "カレンダー登録に失敗しました")
      }
      setRegisteredEventIds((prev) => ({ ...prev, [doc.id]: json.data!.eventId }))
      if (json.data.alreadyRegistered) {
        toast("このイベントは登録済みです")
      } else {
        toast.success("Googleカレンダーに登録しました")
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "カレンダー登録に失敗しました"
      )
    } finally {
      setCalendarLoadingId(null)
    }
  }

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

  // カラム定義マップ（ヘッダーラベル・ソート対象・セル描画）
  // ※ ハンドラ／状態をクロージャで参照するためコンポーネント内で定義
  const columnMap: Record<ColumnId, ColumnDef> = {
    type: {
      id: "type",
      label: "種別",
      sortField: "type",
      renderCell: (doc) => doc.type,
    },
    vendor_name: {
      id: "vendor_name",
      label: "取引先",
      sortField: "vendor_name",
      cellClassName: "max-w-[200px] truncate",
      renderCell: (doc) => doc.vendor_name,
    },
    amount: {
      id: "amount",
      label: "金額",
      sortField: "amount",
      cellClassName: "text-right",
      renderCell: (doc) =>
        doc.amount === null || doc.amount === 0 ? (
          <span
            className="inline-flex items-center justify-end gap-1 font-medium text-red-600 dark:text-red-400"
            title="金額が未抽出です。再解析または手動修正してください"
          >
            <AlertTriangle className="size-3.5" />
            {formatAmount(doc.amount)}
          </span>
        ) : (
          formatAmount(doc.amount)
        ),
    },
    created_at: {
      id: "created_at",
      label: "取り込み日",
      sortField: "created_at",
      renderCell: (doc) => formatDate(doc.created_at),
    },
    registrant: {
      id: "registrant",
      label: "登録者",
      cellClassName: "text-sm",
      renderCell: (doc) => doc.registrant?.name ?? "—",
    },
    issue_date: {
      id: "issue_date",
      label: "発行日",
      sortField: "issue_date",
      renderCell: (doc) => formatDate(doc.issue_date),
    },
    due_date: {
      id: "due_date",
      label: "支払期日",
      sortField: "due_date",
      renderCell: (doc) => formatDate(doc.due_date),
    },
    tax_category: {
      id: "tax_category",
      label: "税区分",
      headClassName: "hidden lg:table-cell",
      cellClassName: "hidden lg:table-cell text-xs",
      renderCell: (doc) => doc.tax_category || "-",
    },
    account_title: {
      id: "account_title",
      label: "勘定科目",
      headClassName: "hidden lg:table-cell",
      cellClassName: "hidden lg:table-cell text-xs",
      renderCell: (doc) => doc.account_title || "-",
    },
    payment_purpose: {
      id: "payment_purpose",
      label: "支払い内容",
      cellClassName: "max-w-[220px] align-top",
      renderCell: (doc) => <PaymentPurposeCell value={doc.payment_purpose} />,
    },
    status: {
      id: "status",
      label: "ステータス",
      sortField: "status",
      renderCell: (doc) => (
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
      ),
    },
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
    <div className="space-y-2">
      {/* 列操作ツールバー：既定に戻す */}
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={resetColumnOrder}
          disabled={isDefaultOrder}
          className="h-7 gap-1 text-xs text-muted-foreground"
          title="列の並び順を既定に戻す"
        >
          <RotateCcw className="size-3.5" />
          列を既定に戻す
        </Button>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <Table>
          <TableHeader>
            <TableRow>
              {/* 固定列：選択（先頭） */}
              {hasSelection && (
                <TableHead className="w-[40px]">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={toggleSelectAll}
                    aria-label="全選択"
                  />
                </TableHead>
              )}
              {/* 並べ替え可能な列 */}
              <SortableContext items={columnOrder} strategy={horizontalListSortingStrategy}>
                {columnOrder.map((id) => (
                  <SortableHeaderCell
                    key={id}
                    column={columnMap[id]}
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={onSort}
                  />
                ))}
              </SortableContext>
              {/* 固定列：操作（右端） */}
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.map((doc) => (
              <TableRow
                key={doc.id}
                className={hasSelection && selectedIds?.has(doc.id) ? "bg-muted/50" : undefined}
              >
                {/* 固定列：選択（先頭） */}
                {hasSelection && (
                  <TableCell>
                    <Checkbox
                      checked={selectedIds?.has(doc.id) ?? false}
                      onCheckedChange={() => toggleSelect(doc.id)}
                      aria-label={`${doc.vendor_name}を選択`}
                    />
                  </TableCell>
                )}
                {/* 並べ替え可能な列（ヘッダーと同じ順序で描画） */}
                {columnOrder.map((id) => {
                  const col = columnMap[id]
                  return (
                    <TableCell key={id} className={col.cellClassName}>
                      {col.renderCell(doc)}
                    </TableCell>
                  )
                })}
                {/* 固定列：操作（右端） */}
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon-xs" asChild>
                      <Link href={`/documents/${doc.id}`}>
                        <Eye className="size-4" />
                      </Link>
                    </Button>
                    {doc.due_date && (() => {
                      const registered =
                        !!doc.calendar_event_id || !!registeredEventIds[doc.id]
                      const isLoading = calendarLoadingId === doc.id
                      return (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => handleCalendarRegister(doc)}
                          disabled={isLoading || registered}
                          aria-label={registered ? "カレンダー登録済み" : "カレンダーに登録"}
                          title={registered ? "カレンダー登録済み" : "Googleカレンダーに登録"}
                          className={registered ? "text-green-600" : "text-red-600"}
                        >
                          {isLoading ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : registered ? (
                            <Check className="size-4" />
                          ) : (
                            <Calendar className="size-4" />
                          )}
                        </Button>
                      )
                    })()}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DndContext>
    </div>
  )
}
