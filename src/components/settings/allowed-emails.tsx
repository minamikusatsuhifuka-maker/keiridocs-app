"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react"

/**
 * ログインできるメールアドレスの管理。
 *
 * ここに無いアドレスは、ログインしても「このアカウントでは利用できません」
 * の画面になり、何も操作できない。
 */

interface Row {
  id: string
  email: string
  display_name: string | null
  note: string | null
  created_at: string
  created_by: string | null
}

export function AllowedEmails() {
  const [rows, setRows] = useState<Row[]>([])
  const [currentEmail, setCurrentEmail] = useState("")
  const [email, setEmail] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [isLoading, setIsLoading] = useState(true)
  const [isAdding, setIsAdding] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch("/api/allowed-emails")
      const json = (await res.json().catch(() => ({}))) as {
        data?: Row[]
        currentEmail?: string
        error?: string
      }
      if (!res.ok) throw new Error(json.error || "取得できませんでした")
      setRows(json.data ?? [])
      setCurrentEmail(json.currentEmail ?? "")
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得できませんでした")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function handleAdd() {
    if (!email.trim()) return
    setIsAdding(true)
    try {
      const res = await fetch("/api/allowed-emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), display_name: displayName.trim() || null }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || "追加できませんでした")
      toast.success("追加しました")
      setEmail("")
      setDisplayName("")
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "追加できませんでした")
    } finally {
      setIsAdding(false)
    }
  }

  async function handleDelete(row: Row) {
    if (!confirm(`${row.email} のログインを取り消します。\n\nこのアドレスではアプリを開けなくなります。\n\nよろしいですか？`)) {
      return
    }
    setDeletingId(row.id)
    try {
      const res = await fetch(`/api/allowed-emails?id=${row.id}`, { method: "DELETE" })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || "削除できませんでした")
      toast.success("取り消しました")
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除できませんでした")
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <ShieldCheck className="size-4" style={{ color: "var(--dusk-primary)" }} />
          ログイン許可
          <Badge variant="outline">{rows.length} 件</Badge>
        </CardTitle>
        <CardDescription>
          ここに登録したメールアドレスだけがアプリにログインできます。
          登録していないアドレスは、ログインしても「このアカウントでは利用できません」と表示され、
          何も見られません。
          <br />
          <strong>スタッフのLINEには関係ありません。</strong>
          LINEはQRコードから誰でも登録でき、この一覧とは別です。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="rounded-md border border-amber-500 p-3 text-sm text-amber-700 dark:text-amber-400">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="ae-email">メールアドレス（Googleアカウント）</Label>
            <Input
              id="ae-email"
              type="email"
              placeholder="例: kawamura@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isAdding) handleAdd()
              }}
            />
          </div>
          <div className="space-y-1.5 sm:w-48">
            <Label htmlFor="ae-name">名前（任意）</Label>
            <Input
              id="ae-name"
              placeholder="例: 河村"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <Button className="btn-dusk-primary" onClick={handleAdd} disabled={isAdding || !email.trim()}>
            {isAdding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            追加
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm" style={{ color: "var(--muted-foreground)" }}>
            <Loader2 className="size-4 animate-spin" />
            読み込み中…
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm" style={{ color: "var(--muted-foreground)" }}>
            登録がありません
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">メールアドレス</TableHead>
                  <TableHead className="whitespace-nowrap">名前</TableHead>
                  <TableHead className="whitespace-nowrap text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const isSelf = r.email.toLowerCase() === currentEmail
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap font-medium">
                        {r.email}
                        {isSelf && (
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            ご自身
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {r.display_name || "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          disabled={deletingId === r.id || isSelf}
                          title={isSelf ? "ご自身のアドレスは削除できません" : undefined}
                          onClick={() => handleDelete(r)}
                        >
                          {deletingId === r.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Trash2 className="size-4" />
                          )}
                          取り消す
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
