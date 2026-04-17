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

type DocumentStaff = Database["public"]["Tables"]["document_staff"]["Row"]

// 書類登録スタッフ管理
export function DocumentStaffList() {
  const [staffList, setStaffList] = useState<DocumentStaff[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isAdding, setIsAdding] = useState(false)
  const [name, setName] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState("")

  // 一覧取得
  const fetchStaff = useCallback(async () => {
    try {
      const res = await fetch("/api/document-staff")
      const json = await res.json() as { data?: DocumentStaff[]; error?: string }
      if (json.error) throw new Error(json.error)
      setStaffList(json.data ?? [])
    } catch {
      toast.error("書類スタッフ一覧の取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStaff()
  }, [fetchStaff])

  // 追加
  async function handleAdd() {
    if (!name.trim()) {
      toast.error("スタッフ名を入力してください")
      return
    }

    setIsAdding(true)
    try {
      const res = await fetch("/api/document-staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      })
      const json = await res.json() as { data?: DocumentStaff; error?: string }
      if (json.error) throw new Error(json.error)
      if (json.data) setStaffList((prev) => [...prev, json.data!])
      setName("")
      toast.success("スタッフを追加しました")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "追加に失敗しました")
    } finally {
      setIsAdding(false)
    }
  }

  function startEdit(r: DocumentStaff) {
    setEditingId(r.id)
    setEditingName(r.name)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditingName("")
  }

  async function handleUpdate() {
    if (!editingId || !editingName.trim()) {
      toast.error("スタッフ名を入力してください")
      return
    }
    try {
      const res = await fetch("/api/document-staff", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingId, name: editingName.trim() }),
      })
      const json = await res.json() as { data?: DocumentStaff; error?: string }
      if (json.error) throw new Error(json.error)
      setStaffList((prev) =>
        prev.map((r) => (r.id === editingId ? { ...r, name: editingName.trim() } : r))
      )
      cancelEdit()
      toast.success("スタッフ名を更新しました")
    } catch {
      toast.error("更新に失敗しました")
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("このスタッフを削除しますか？")) return
    try {
      const res = await fetch(`/api/document-staff?id=${id}`, { method: "DELETE" })
      const json = await res.json() as { success?: boolean; error?: string }
      if (json.error) throw new Error(json.error)
      setStaffList((prev) => prev.filter((r) => r.id !== id))
      toast.success("スタッフを削除しました")
    } catch {
      toast.error("削除に失敗しました")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle style={{ color: "#1A1A1A" }}>書類登録スタッフ管理</CardTitle>
        <CardDescription style={{ color: "#4A4A4A" }}>
          書類登録時に選択するスタッフを管理します
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2">
            <Label htmlFor="document-staff-name" style={{ color: "#1A1A1A" }}>スタッフ名</Label>
            <Input
              id="document-staff-name"
              placeholder="例: 管理者、伊藤"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd()
              }}
            />
          </div>
          <Button
            onClick={handleAdd}
            disabled={isAdding || !name.trim()}
            style={{ background: "var(--dusk-accent-gradient)", color: "#FFFFFF" }}
          >
            {isAdding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            追加
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin" style={{ color: "#4A4A4A" }} />
          </div>
        ) : staffList.length === 0 ? (
          <p className="py-8 text-center text-sm" style={{ color: "#4A4A4A" }}>
            スタッフが登録されていません
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead style={{ color: "#1A1A1A" }}>スタッフ名</TableHead>
                <TableHead className="w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {staffList.map((r) => (
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
