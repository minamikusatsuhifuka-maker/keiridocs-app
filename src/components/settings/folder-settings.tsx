"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Plus, Trash2, Pencil, Check, X, Loader2, FolderOpen } from "lucide-react"
import { toast } from "sonner"
import type { Database } from "@/types/database"

type CustomFolder = Database["public"]["Tables"]["custom_folders"]["Row"]

// 基準日ラベルの定義
const DATE_FIELD_LABELS: Record<string, string> = {
  issueDate: "発行日",
  dueDate: "支払期日",
  createdAt: "登録日",
}

// フォルダ設定
export function FolderSettings() {
  const [folders, setFolders] = useState<CustomFolder[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isAdding, setIsAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  // 新規追加フォーム
  const [newName, setNewName] = useState("")
  const [newMonthly, setNewMonthly] = useState(false)
  const [newStatusSplit, setNewStatusSplit] = useState(false)
  const [newDateField, setNewDateField] = useState("issueDate")

  // 編集フォーム
  const [editName, setEditName] = useState("")
  const [editMonthly, setEditMonthly] = useState(false)
  const [editStatusSplit, setEditStatusSplit] = useState(false)
  const [editDateField, setEditDateField] = useState("issueDate")

  // Dropboxルートフォルダ
  const [rootFolder, setRootFolder] = useState("/経理書類")
  const [isSavingRoot, setIsSavingRoot] = useState(false)

  // フォルダ一覧を取得
  const fetchFolders = useCallback(async () => {
    try {
      const res = await fetch("/api/settings?table=custom_folders")
      const json = await res.json() as { data?: CustomFolder[]; error?: string }
      if (json.error) throw new Error(json.error)
      setFolders(json.data ?? [])
    } catch {
      toast.error("フォルダの取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }, [])

  // ルートフォルダ設定を取得
  const fetchRootFolder = useCallback(async () => {
    try {
      const res = await fetch("/api/settings?table=settings&key=dropbox_root_folder")
      const json = await res.json() as { data?: { value: unknown } | null; error?: string }
      if (json.error) throw new Error(json.error)
      if (json.data?.value && typeof json.data.value === "string") {
        setRootFolder(json.data.value)
      }
    } catch {
      // 初期値を使用
    }
  }, [])

  useEffect(() => {
    fetchFolders()
    fetchRootFolder()
  }, [fetchFolders, fetchRootFolder])

  // ルートフォルダを保存
  async function handleSaveRootFolder() {
    setIsSavingRoot(true)
    try {
      const res = await fetch("/api/settings?table=settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "dropbox_root_folder", value: rootFolder }),
      })
      const json = await res.json() as { data?: unknown; error?: string }
      if (json.error) throw new Error(json.error)
      toast.success("ルートフォルダを保存しました")
    } catch {
      toast.error("ルートフォルダの保存に失敗しました")
    } finally {
      setIsSavingRoot(false)
    }
  }

  // フォルダを追加
  async function handleAdd() {
    if (!newName.trim()) {
      toast.error("フォルダ名を入力してください")
      return
    }

    setIsAdding(true)
    try {
      const res = await fetch("/api/settings?table=custom_folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          monthly: newMonthly,
          status_split: newStatusSplit,
          date_field: newDateField,
        }),
      })
      const json = await res.json() as { data?: CustomFolder; error?: string }
      if (json.error) throw new Error(json.error)
      setFolders((prev) => [...prev, json.data!])
      setNewName("")
      setNewMonthly(false)
      setNewStatusSplit(false)
      setNewDateField("issueDate")
      toast.success("フォルダを追加しました")
    } catch {
      toast.error("フォルダの追加に失敗しました")
    } finally {
      setIsAdding(false)
    }
  }

  // 編集モードを開始
  function startEditing(folder: CustomFolder) {
    setEditingId(folder.id)
    setEditName(folder.name)
    setEditMonthly(folder.monthly)
    setEditStatusSplit(folder.status_split)
    setEditDateField(folder.date_field)
  }

  // 編集を保存
  async function handleSaveEdit() {
    if (!editingId || !editName.trim()) return

    try {
      const res = await fetch(`/api/settings?table=custom_folders&id=${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          monthly: editMonthly,
          status_split: editStatusSplit,
          date_field: editDateField,
        }),
      })
      const json = await res.json() as { data?: CustomFolder; error?: string }
      if (json.error) throw new Error(json.error)
      setFolders((prev) =>
        prev.map((f) => (f.id === editingId ? json.data! : f))
      )
      setEditingId(null)
      toast.success("フォルダを更新しました")
    } catch {
      toast.error("フォルダの更新に失敗しました")
    }
  }

  // フォルダを削除
  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/settings?table=custom_folders&id=${id}`, {
        method: "DELETE",
      })
      const json = await res.json() as { success?: boolean; error?: string }
      if (json.error) throw new Error(json.error)
      setFolders((prev) => prev.filter((f) => f.id !== id))
      toast.success("フォルダを削除しました")
    } catch {
      toast.error("フォルダの削除に失敗しました")
    }
  }

  return (
    <div className="space-y-6">
      {/* Dropbox ルートフォルダ設定 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderOpen className="size-5" />
            Dropbox ルートフォルダ
          </CardTitle>
          <CardDescription>
            Dropboxの保存先ルートフォルダを指定します
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-2">
              <Label htmlFor="root-folder">ルートフォルダパス</Label>
              <Input
                id="root-folder"
                placeholder="/経理書類"
                value={rootFolder}
                onChange={(e) => setRootFolder(e.target.value)}
              />
            </div>
            <Button onClick={handleSaveRootFolder} disabled={isSavingRoot}>
              {isSavingRoot ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* カスタムフォルダ一覧 */}
      <Card>
        <CardHeader>
          <CardTitle>カスタムフォルダ</CardTitle>
          <CardDescription>
            書類の種別ごとにDropboxのフォルダ構造を設定します
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 追加フォーム */}
          <div className="rounded-lg border p-4 space-y-4">
            <h4 className="text-sm font-medium">新規フォルダ追加</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="folder-name">フォルダ名</Label>
                <Input
                  id="folder-name"
                  placeholder="例: 見積書"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="folder-date-field">基準日</Label>
                <Select value={newDateField} onValueChange={setNewDateField}>
                  <SelectTrigger id="folder-date-field">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="issueDate">発行日</SelectItem>
                    <SelectItem value="dueDate">支払期日</SelectItem>
                    <SelectItem value="createdAt">登録日</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <div className="flex items-center gap-2">
                <Switch
                  id="folder-monthly"
                  checked={newMonthly}
                  onCheckedChange={setNewMonthly}
                />
                <Label htmlFor="folder-monthly">月別分類</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="folder-status"
                  checked={newStatusSplit}
                  onCheckedChange={setNewStatusSplit}
                />
                <Label htmlFor="folder-status">ステータス分類</Label>
              </div>
              <div className="sm:ml-auto">
                <Button onClick={handleAdd} disabled={isAdding || !newName.trim()}>
                  {isAdding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  追加
                </Button>
              </div>
            </div>
          </div>

          {/* 一覧テーブル */}
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : folders.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              カスタムフォルダが登録されていません
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>フォルダ名</TableHead>
                  <TableHead>月別</TableHead>
                  <TableHead>ステータス分類</TableHead>
                  <TableHead>基準日</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {folders.map((folder) =>
                  editingId === folder.id ? (
                    <TableRow key={folder.id}>
                      <TableCell>
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="h-8"
                        />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={editMonthly}
                          onCheckedChange={setEditMonthly}
                        />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={editStatusSplit}
                          onCheckedChange={setEditStatusSplit}
                        />
                      </TableCell>
                      <TableCell>
                        <Select value={editDateField} onValueChange={setEditDateField}>
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="issueDate">発行日</SelectItem>
                            <SelectItem value="dueDate">支払期日</SelectItem>
                            <SelectItem value="createdAt">登録日</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={handleSaveEdit}
                            className="text-green-600 hover:text-green-600"
                          >
                            <Check className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setEditingId(null)}
                          >
                            <X className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    <TableRow key={folder.id}>
                      <TableCell className="font-medium">{folder.name}</TableCell>
                      <TableCell>{folder.monthly ? "ON" : "OFF"}</TableCell>
                      <TableCell>{folder.status_split ? "ON" : "OFF"}</TableCell>
                      <TableCell>{DATE_FIELD_LABELS[folder.date_field] ?? folder.date_field}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => startEditing(folder)}
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(folder.id)}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
