"use client"

import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { MailList } from "@/components/mail/mail-list"
import { ApproveDialog, RejectDialog } from "@/components/mail/approve-dialog"
import { RefreshCw, Loader2, Mail } from "lucide-react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import type { Database } from "@/types/database"

type MailPending = Database["public"]["Tables"]["mail_pending"]["Row"]

// メール確認・承認ページ
export default function MailPage() {
  const [items, setItems] = useState<MailPending[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isFetching, setIsFetching] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)

  // ダイアログ状態
  const [approveDialogOpen, setApproveDialogOpen] = useState(false)
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false)
  const [targetItems, setTargetItems] = useState<MailPending[]>([])

  // 未承認メール一覧を取得
  const loadPendingMails = useCallback(async () => {
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("mail_pending")
        .select("id, file_name, sender, received_at, ai_type, ai_confidence, temp_path, status, user_id, created_at")
        .eq("status", "pending")
        .order("created_at", { ascending: false })

      if (error) throw error
      setItems((data ?? []) as MailPending[])
    } catch {
      toast.error("メール一覧の取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPendingMails()
  }, [loadPendingMails])

  // 手動メール取込
  async function handleFetchMails() {
    setIsFetching(true)
    try {
      const res = await fetch("/api/mail/fetch", { method: "POST" })
      const data = await res.json() as { message?: string; error?: string; count?: number }

      if (!res.ok) {
        throw new Error(data.error ?? "メール取込に失敗しました")
      }

      toast.success(data.message ?? `${data.count ?? 0}件を取り込みました`)
      await loadPendingMails()
    } catch (error) {
      const message = error instanceof Error ? error.message : "メール取込に失敗しました"
      toast.error(message)
    } finally {
      setIsFetching(false)
    }
  }

  // 承認ボタン押下 → ダイアログ表示
  function handleApprove(ids: string[]) {
    const targets = items.filter((item) => ids.includes(item.id))
    setTargetItems(targets)
    setApproveDialogOpen(true)
  }

  // 却下ボタン押下 → ダイアログ表示
  function handleReject(ids: string[]) {
    const targets = items.filter((item) => ids.includes(item.id))
    setTargetItems(targets)
    setRejectDialogOpen(true)
  }

  // 承認確定
  async function handleApproveConfirm(ids: string[], type: string) {
    setIsProcessing(true)
    try {
      const res = await fetch("/api/mail/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve", ids, type }),
      })

      const data = await res.json() as { message?: string; error?: string }

      if (!res.ok) {
        throw new Error(data.error ?? "承認処理に失敗しました")
      }

      toast.success(data.message ?? "承認しました")
      setApproveDialogOpen(false)
      await loadPendingMails()
    } catch (error) {
      const message = error instanceof Error ? error.message : "承認処理に失敗しました"
      toast.error(message)
    } finally {
      setIsProcessing(false)
    }
  }

  // 却下確定
  async function handleRejectConfirm(ids: string[]) {
    setIsProcessing(true)
    try {
      const res = await fetch("/api/mail/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject", ids }),
      })

      const data = await res.json() as { message?: string; error?: string }

      if (!res.ok) {
        throw new Error(data.error ?? "却下処理に失敗しました")
      }

      toast.success(data.message ?? "却下しました")
      setRejectDialogOpen(false)
      await loadPendingMails()
    } catch (error) {
      const message = error instanceof Error ? error.message : "却下処理に失敗しました"
      toast.error(message)
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">メール確認</h1>
          <p className="text-sm text-muted-foreground mt-1">
            メールから取り込んだ添付ファイルの確認・承認を行います
          </p>
        </div>
        <Button
          onClick={handleFetchMails}
          disabled={isFetching}
        >
          {isFetching ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 size-4" />
          )}
          メール取込
        </Button>
      </div>

      {/* メール一覧 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="size-5" />
            未承認一覧
            {items.length > 0 && (
              <span className="text-sm font-normal text-muted-foreground">
                （{items.length}件）
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <MailList
              items={items}
              onApprove={handleApprove}
              onReject={handleReject}
              isProcessing={isProcessing}
            />
          )}
        </CardContent>
      </Card>

      {/* 承認ダイアログ */}
      <ApproveDialog
        open={approveDialogOpen}
        onOpenChange={setApproveDialogOpen}
        items={targetItems}
        onConfirm={handleApproveConfirm}
        isProcessing={isProcessing}
      />

      {/* 却下ダイアログ */}
      <RejectDialog
        open={rejectDialogOpen}
        onOpenChange={setRejectDialogOpen}
        items={targetItems}
        onConfirm={handleRejectConfirm}
        isProcessing={isProcessing}
      />
    </div>
  )
}
