"use client"

import { useState } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Check, X, Loader2 } from "lucide-react"
import type { Database } from "@/types/database"

type MailPending = Database["public"]["Tables"]["mail_pending"]["Row"]

interface MailListProps {
  items: MailPending[]
  onApprove: (ids: string[]) => void
  onReject: (ids: string[]) => void
  isProcessing: boolean
}

/** 日時を yyyy/MM/dd HH:mm でフォーマット */
function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return "-"
  const d = new Date(dateStr)
  return d.toLocaleDateString("ja-JP") + " " + d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
}

/** 確信度を表示用にフォーマット */
function formatConfidence(confidence: number | null): string {
  if (confidence === null) return "-"
  return `${Math.round(confidence * 100)}%`
}

/** 確信度に応じたバッジの色 */
function getConfidenceBadgeVariant(confidence: number | null): "default" | "secondary" | "destructive" {
  if (confidence === null) return "secondary"
  if (confidence >= 0.8) return "default"
  if (confidence >= 0.5) return "secondary"
  return "destructive"
}

export function MailList({ items, onApprove, onReject, isProcessing }: MailListProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // 全選択/全解除
  const allSelected = items.length > 0 && selectedIds.size === items.length
  const someSelected = selectedIds.size > 0 && selectedIds.size < items.length

  function handleSelectAll(checked: boolean) {
    if (checked) {
      setSelectedIds(new Set(items.map((item) => item.id)))
    } else {
      setSelectedIds(new Set())
    }
  }

  function handleSelectOne(id: string, checked: boolean) {
    const newSet = new Set(selectedIds)
    if (checked) {
      newSet.add(id)
    } else {
      newSet.delete(id)
    }
    setSelectedIds(newSet)
  }

  function handleBulkApprove() {
    if (selectedIds.size === 0) return
    onApprove(Array.from(selectedIds))
    setSelectedIds(new Set())
  }

  function handleBulkReject() {
    if (selectedIds.size === 0) return
    onReject(Array.from(selectedIds))
    setSelectedIds(new Set())
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        未承認のメール添付ファイルはありません
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 一括操作バー */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg bg-muted p-3">
          <span className="text-sm font-medium">
            {selectedIds.size}件を選択中
          </span>
          <Button
            size="sm"
            onClick={handleBulkApprove}
            disabled={isProcessing}
          >
            {isProcessing ? (
              <Loader2 className="mr-1 size-4 animate-spin" />
            ) : (
              <Check className="mr-1 size-4" />
            )}
            一括承認
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleBulkReject}
            disabled={isProcessing}
          >
            <X className="mr-1 size-4" />
            一括却下
          </Button>
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={allSelected ? true : someSelected ? "indeterminate" : false}
                onCheckedChange={(checked) => handleSelectAll(checked === true)}
                aria-label="全選択"
              />
            </TableHead>
            <TableHead>ファイル名</TableHead>
            <TableHead>差出人</TableHead>
            <TableHead>受信日時</TableHead>
            <TableHead>AI判定種別</TableHead>
            <TableHead>確信度</TableHead>
            <TableHead>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.id}>
              <TableCell>
                <Checkbox
                  checked={selectedIds.has(item.id)}
                  onCheckedChange={(checked) => handleSelectOne(item.id, checked === true)}
                  aria-label={`${item.file_name}を選択`}
                />
              </TableCell>
              <TableCell className="max-w-[200px] truncate font-medium">
                {item.file_name}
              </TableCell>
              <TableCell className="max-w-[150px] truncate">
                {item.sender}
              </TableCell>
              <TableCell>{formatDateTime(item.received_at)}</TableCell>
              <TableCell>
                {item.ai_type ? (
                  <Badge variant="outline">{item.ai_type}</Badge>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </TableCell>
              <TableCell>
                <Badge variant={getConfidenceBadgeVariant(item.ai_confidence)}>
                  {formatConfidence(item.ai_confidence)}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onApprove([item.id])}
                    disabled={isProcessing}
                  >
                    <Check className="mr-1 size-4 text-green-600" />
                    承認
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onReject([item.id])}
                    disabled={isProcessing}
                  >
                    <X className="mr-1 size-4 text-red-600" />
                    却下
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
