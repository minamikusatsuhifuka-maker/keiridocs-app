"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Loader2 } from "lucide-react"
import type { Database } from "@/types/database"

type MailPending = Database["public"]["Tables"]["mail_pending"]["Row"]

const DOCUMENT_TYPES = ["請求書", "領収書", "契約書"] as const

interface ApproveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: MailPending[]
  onConfirm: (ids: string[], type: string) => Promise<void>
  isProcessing: boolean
}

interface RejectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: MailPending[]
  onConfirm: (ids: string[]) => Promise<void>
  isProcessing: boolean
}

/** 承認ダイアログ — AI再解析して情報確認、種別選択してから承認 */
export function ApproveDialog({
  open,
  onOpenChange,
  items,
  onConfirm,
  isProcessing,
}: ApproveDialogProps) {
  // AI判定種別がある場合はそれをデフォルトに、なければ「請求書」
  const defaultType = items.length === 1 && items[0].ai_type
    ? items[0].ai_type
    : "請求書"
  const [selectedType, setSelectedType] = useState<string>(defaultType)

  // ダイアログが開かれるたびにデフォルト値をリセット
  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      const type = items.length === 1 && items[0].ai_type
        ? items[0].ai_type
        : "請求書"
      setSelectedType(type)
    }
    onOpenChange(nextOpen)
  }

  async function handleConfirm() {
    const ids = items.map((item) => item.id)
    await onConfirm(ids, selectedType)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>メール添付ファイルの承認</DialogTitle>
          <DialogDescription>
            以下のファイルを経理書類として登録します。種別を確認してから承認してください。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 対象ファイル一覧 */}
          <div className="space-y-2">
            <Label>対象ファイル（{items.length}件）</Label>
            <div className="max-h-40 overflow-y-auto rounded-md border p-3 space-y-2">
              {items.map((item) => (
                <div key={item.id} className="flex items-center justify-between text-sm">
                  <span className="truncate mr-2">{item.file_name}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-muted-foreground">{item.sender}</span>
                    {item.ai_type && (
                      <Badge variant="outline" className="text-xs">
                        AI: {item.ai_type}
                        {item.ai_confidence !== null && ` (${Math.round(item.ai_confidence * 100)}%)`}
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 種別選択 */}
          <div className="space-y-2">
            <Label htmlFor="doc-type">書類種別</Label>
            <Select value={selectedType} onValueChange={setSelectedType}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="種別を選択" />
              </SelectTrigger>
              <SelectContent>
                {DOCUMENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              承認時にAI再解析を実行し、書類情報を自動抽出します。
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isProcessing}
          >
            キャンセル
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={isProcessing}
          >
            {isProcessing ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                処理中...
              </>
            ) : (
              `${items.length}件を承認`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 却下確認ダイアログ */
export function RejectDialog({
  open,
  onOpenChange,
  items,
  onConfirm,
  isProcessing,
}: RejectDialogProps) {
  async function handleConfirm() {
    const ids = items.map((item) => item.id)
    await onConfirm(ids)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>却下の確認</DialogTitle>
          <DialogDescription>
            以下のメール添付ファイルを却下します。この操作は取り消せません。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label>対象ファイル（{items.length}件）</Label>
          <div className="max-h-40 overflow-y-auto rounded-md border p-3 space-y-2">
            {items.map((item) => (
              <div key={item.id} className="flex items-center justify-between text-sm">
                <span className="truncate mr-2">{item.file_name}</span>
                <span className="text-muted-foreground shrink-0">{item.sender}</span>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isProcessing}
          >
            キャンセル
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={isProcessing}
          >
            {isProcessing ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                処理中...
              </>
            ) : (
              `${items.length}件を却下`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
