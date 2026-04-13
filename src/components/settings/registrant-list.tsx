"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, Trash2, Loader2, Pencil, Check, X } from "lucide-react"
import { toast } from "sonner"
import type { Database } from "@/types/database"

type Registrant = Database["public"]["Tables"]["registrants"]["Row"]

// 登録者管理
export function RegistrantList() {
  const [registrants, setRegistrants] = useState<Registrant[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isAdding, setIsAdding] = useState(false)
  const [name, setName] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState("")

  // 一覧取得
  const fetchRegistrants = useCallback(async () => {
    try {
      const res = await fetch("/api/registrants")
      const json = await res.json() as { data?: Registrant[]; error?: string }
      if (json.error) throw new Error(json.error)
      setRegistrants(json.data ?? [])
    } catch {
      toast.error("登録者一覧の取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchRegistrants()
  }, [fetchRegistrants])

  // 追加
  async function handleAdd() {
    if (!name.trim()) {
      toast.error("登録者名を入力してください")
      return
    }

    setIsAdding(true)
    try {
      const res = await fetch("/api/registrants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      })
      const json = await res.json() as { data?: Registrant; error?: string }
      if (json.error) throw new Error(json.error)
      if (json.data) setRegistrants((prev) => [...prev, json.data!])
      setName("")
      toast.success("登録者を追加しました")
    } catch {
      toast.error("登録者の追加に失敗しました")
    } finally {
      setIsAdding(false)
    }
  }

  // 編集開始
  function startEdit(r: Registrant) {
    setEditingId(r.id)
    setEditingName(r.name)
  }

  // 編集キャンセル
  function cancelEdit() {
    setEditingId(null)
    setEditingName("")
  }

  // 編集保存
  async function handleUpdate() {
    if (!editingId || !editingName.trim()) {
      toast.error("登録者名を入力してください")
      return
    }
    try {
      const res = await fetch("/api/registrants", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingId, name: editingName.trim() }),
      })
      const json = await res.json() as { data?: Registrant; error?: string }
      if (json.error) throw new Error(json.error)
      setRegistrants((prev) =>
        prev.map((r) => (r.id === editingId ? { ...r, name: editingName.trim() } : r))
      )
      cancelEdit()
      toast.success("登録者名を更新しました")
    } catch {
      toast.error("登録者の更新に失敗しました")
    }
  }

  // 削除
  async function handleDelete(id: string) {
    if (!confirm("この登録者を削除しますか？")) return
    try {
      const res = await fetch(`/api/registrants?id=${id}`, { method: "DELETE" })
      const json = await res.json() as { success?: boolean; error?: string }
      if (json.error) throw new Error(json.error)
      setRegistrants((prev) => prev.filter((r) => r.id !== id))
      toast.success("登録者を削除しました")
    } catch {
      toast.error("登録者の削除に失敗しました")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle style={{ color: "#1A1A1A" }}>登録者管理</CardTitle>
        <CardDescription style={{ color: "#4A4A4A" }}>
          書類を取り込む登録者（運用者）を管理します
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 追加フォーム */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2">
            <Label htmlFor="registrant-name" style={{ color: "#1A1A1A" }}>登録者名</Label>
            <Input
              id="registrant-name"
              placeholder="例: 管理者、スタッフA"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Button
            onClick={handleAdd}
            disabled={isAdding || !name.trim()}
            className="btn-dusk-primary"
            style={{ background: "var(--dusk-accent-gradient)", color: "#FFFFFF" }}
          >
            {isAdding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            追加
          </Button>
        </div>

        {/* 一覧テーブル */}
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin" style={{ color: "#4A4A4A" }} />
          </div>
        ) : registrants.length === 0 ? (
          <p className="py-8 text-center text-sm" style={{ color: "#4A4A4A" }}>
            登録者が登録されていません
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead style={{ color: "#1A1A1A" }}>登録者名</TableHead>
                <TableHead className="w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {registrants.map((r) => (
                <TableRow key={r.id}>
                  <TableCell style={{ color: "#1A1A1A" }}>
                    {editingId === r.id ? (
                      <Input
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleUpdate()
                          if (e.key === "Escape") cancelEdit()
                        }}
                        autoFocus
                      />
                    ) : (
                      r.name
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {editingId === r.id ? (
                        <>
                          <Button variant="ghost" size="icon" onClick={handleUpdate}>
                            <Check className="size-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={cancelEdit}>
                            <X className="size-4" />
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button variant="ghost" size="icon" onClick={() => startEdit(r)}>
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(r.id)}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </>
                      )}
                    </div>
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
