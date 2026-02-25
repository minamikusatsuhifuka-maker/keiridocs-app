"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, Trash2, Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { Database } from "@/types/database"

type NotifyRecipient = Database["public"]["Tables"]["notify_recipients"]["Row"]

// 通知先リスト
export function NotifyList() {
  const [recipients, setRecipients] = useState<NotifyRecipient[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isAdding, setIsAdding] = useState(false)
  const [email, setEmail] = useState("")
  const [displayName, setDisplayName] = useState("")

  // 通知先一覧を取得
  const fetchRecipients = useCallback(async () => {
    try {
      const res = await fetch("/api/settings?table=notify_recipients")
      const json = await res.json() as { data?: NotifyRecipient[]; error?: string }
      if (json.error) throw new Error(json.error)
      setRecipients(json.data ?? [])
    } catch {
      toast.error("通知先の取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchRecipients()
  }, [fetchRecipients])

  // 通知先を追加
  async function handleAdd() {
    if (!email.includes("@")) {
      toast.error("有効なメールアドレスを入力してください")
      return
    }

    setIsAdding(true)
    try {
      const res = await fetch("/api/settings?table=notify_recipients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, display_name: displayName || null }),
      })
      const json = await res.json() as { data?: NotifyRecipient; error?: string }
      if (json.error) throw new Error(json.error)
      setRecipients((prev) => [...prev, json.data!])
      setEmail("")
      setDisplayName("")
      toast.success("通知先を追加しました")
    } catch {
      toast.error("通知先の追加に失敗しました")
    } finally {
      setIsAdding(false)
    }
  }

  // 通知先を削除
  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/settings?table=notify_recipients&id=${id}`, {
        method: "DELETE",
      })
      const json = await res.json() as { success?: boolean; error?: string }
      if (json.error) throw new Error(json.error)
      setRecipients((prev) => prev.filter((r) => r.id !== id))
      toast.success("通知先を削除しました")
    } catch {
      toast.error("通知先の削除に失敗しました")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>通知先</CardTitle>
        <CardDescription>
          書類登録や期日のリマインドなどの通知を送信するメールアドレスを管理します
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 追加フォーム */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2">
            <Label htmlFor="notify-email">メールアドレス</Label>
            <Input
              id="notify-email"
              type="email"
              placeholder="keiri@company.co.jp"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="flex-1 space-y-2">
            <Label htmlFor="notify-name">表示名</Label>
            <Input
              id="notify-name"
              placeholder="経理担当 田中"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <Button onClick={handleAdd} disabled={isAdding || !email}>
            {isAdding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            追加
          </Button>
        </div>

        {/* 一覧テーブル */}
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : recipients.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            通知先が登録されていません
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>メールアドレス</TableHead>
                <TableHead>表示名</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {recipients.map((recipient) => (
                <TableRow key={recipient.id}>
                  <TableCell className="font-mono text-sm">{recipient.email}</TableCell>
                  <TableCell>{recipient.display_name ?? "—"}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(recipient.id)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
