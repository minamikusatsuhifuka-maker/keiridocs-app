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

type AllowedSender = Database["public"]["Tables"]["allowed_senders"]["Row"]

// 許可送信元リスト
export function SenderList() {
  const [senders, setSenders] = useState<AllowedSender[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isAdding, setIsAdding] = useState(false)
  const [email, setEmail] = useState("")
  const [displayName, setDisplayName] = useState("")

  // 送信元一覧を取得
  const fetchSenders = useCallback(async () => {
    try {
      const res = await fetch("/api/settings?table=allowed_senders")
      const json = await res.json() as { data?: AllowedSender[]; error?: string }
      if (json.error) throw new Error(json.error)
      setSenders(json.data ?? [])
    } catch {
      toast.error("許可送信元の取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSenders()
  }, [fetchSenders])

  // 送信元を追加
  async function handleAdd() {
    if (!email.includes("@")) {
      toast.error("有効なメールアドレスを入力してください")
      return
    }

    setIsAdding(true)
    try {
      const res = await fetch("/api/settings?table=allowed_senders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, display_name: displayName || null }),
      })
      const json = await res.json() as { data?: AllowedSender; error?: string }
      if (json.error) throw new Error(json.error)
      setSenders((prev) => [...prev, json.data!])
      setEmail("")
      setDisplayName("")
      toast.success("許可送信元を追加しました")
    } catch {
      toast.error("許可送信元の追加に失敗しました")
    } finally {
      setIsAdding(false)
    }
  }

  // 送信元を削除
  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/settings?table=allowed_senders&id=${id}`, {
        method: "DELETE",
      })
      const json = await res.json() as { success?: boolean; error?: string }
      if (json.error) throw new Error(json.error)
      setSenders((prev) => prev.filter((s) => s.id !== id))
      toast.success("許可送信元を削除しました")
    } catch {
      toast.error("許可送信元の削除に失敗しました")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>許可送信元</CardTitle>
        <CardDescription>
          メール取込時に許可する送信元メールアドレスを管理します
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 追加フォーム */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2">
            <Label htmlFor="sender-email">メールアドレス</Label>
            <Input
              id="sender-email"
              type="email"
              placeholder="example@company.co.jp"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="flex-1 space-y-2">
            <Label htmlFor="sender-name">表示名</Label>
            <Input
              id="sender-name"
              placeholder="株式会社○○"
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
        ) : senders.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            許可送信元が登録されていません
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
              {senders.map((sender) => (
                <TableRow key={sender.id}>
                  <TableCell className="font-mono text-sm">{sender.email}</TableCell>
                  <TableCell>{sender.display_name ?? "—"}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(sender.id)}
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
