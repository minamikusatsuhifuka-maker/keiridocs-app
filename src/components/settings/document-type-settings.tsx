"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Loader2, Plus, Pencil, Trash2, GripVertical } from "lucide-react"
import { toast } from "sonner"
import type { Database } from "@/types/database"

type DocumentType = Database["public"]["Tables"]["document_types"]["Row"]

// デフォルト種別（削除不可）
const DEFAULT_TYPE_NAMES = ["請求書", "領収書", "契約書"]

// 追加提案リスト
const SUGGESTED_TYPES = ["給与明細", "社会保険料", "医薬品仕入", "医療機器", "保険請求", "税務関連", "その他"]

// 書類種別管理コンポーネント
export function DocumentTypeSettings() {
  const [types, setTypes] = useState<DocumentType[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isInitializing, setIsInitializing] = useState(false)

  // 追加・編集ダイアログ
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingType, setEditingType] = useState<DocumentType | null>(null)
  const [formName, setFormName] = useState("")
  const [formFolder, setFormFolder] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  // データ取得
  const fetchTypes = useCallback(async () => {
    try {
      const res = await fetch("/api/settings?table=document_types")
      if (!res.ok) throw new Error()
      const json = await res.json() as { data: DocumentType[] }
      setTypes(json.data ?? [])
    } catch {
      toast.error("書類種別の取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTypes()
  }, [fetchTypes])

  // デフォルト種別を初期化
  const initializeDefaults = async () => {
    setIsInitializing(true)
    try {
      for (let i = 0; i < DEFAULT_TYPE_NAMES.length; i++) {
        const name = DEFAULT_TYPE_NAMES[i]
        // 既に存在する場合はスキップ
        if (types.some((t) => t.name === name)) continue

        await fetch("/api/settings?table=document_types", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            is_default: true,
            sort_order: i,
          }),
        })
      }
      toast.success("デフォルト種別を初期化しました")
      await fetchTypes()
    } catch {
      toast.error("初期化に失敗しました")
    } finally {
      setIsInitializing(false)
    }
  }

  // 追加ダイアログを開く
  const openAddDialog = (suggestedName?: string) => {
    setEditingType(null)
    setFormName(suggestedName ?? "")
    setFormFolder("")
    setDialogOpen(true)
  }

  // 編集ダイアログを開く
  const openEditDialog = (type: DocumentType) => {
    setEditingType(type)
    setFormName(type.name)
    setFormFolder(type.dropbox_folder ?? "")
    setDialogOpen(true)
  }

  // 保存
  const handleSave = async () => {
    if (!formName.trim()) {
      toast.error("種別名を入力してください")
      return
    }

    setIsSaving(true)
    try {
      if (editingType) {
        // 更新
        const res = await fetch(`/api/settings?table=document_types&id=${editingType.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formName.trim(),
            dropbox_folder: formFolder.trim() || null,
          }),
        })
        if (!res.ok) throw new Error()
        toast.success("書類種別を更新しました")
      } else {
        // 追加
        const maxOrder = types.length > 0 ? Math.max(...types.map((t) => t.sort_order)) : -1
        const res = await fetch("/api/settings?table=document_types", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formName.trim(),
            dropbox_folder: formFolder.trim() || null,
            sort_order: maxOrder + 1,
          }),
        })
        if (!res.ok) throw new Error()
        toast.success("書類種別を追加しました")
      }

      setDialogOpen(false)
      await fetchTypes()
    } catch {
      toast.error("保存に失敗しました")
    } finally {
      setIsSaving(false)
    }
  }

  // 削除
  const handleDelete = async (type: DocumentType) => {
    if (type.is_default) {
      toast.error("デフォルト種別は削除できません")
      return
    }

    if (!confirm(`「${type.name}」を削除してもよいですか？`)) return

    try {
      const res = await fetch(`/api/settings?table=document_types&id=${type.id}`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error()
      toast.success("書類種別を削除しました")
      await fetchTypes()
    } catch {
      toast.error("削除に失敗しました")
    }
  }

  // 並び替え（上下移動）
  const handleMove = async (index: number, direction: "up" | "down") => {
    const newTypes = [...types]
    const targetIndex = direction === "up" ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= newTypes.length) return

    // sort_orderを入れ替え
    const tempOrder = newTypes[index].sort_order
    newTypes[index] = { ...newTypes[index], sort_order: newTypes[targetIndex].sort_order }
    newTypes[targetIndex] = { ...newTypes[targetIndex], sort_order: tempOrder }

    // 画面反映
    ;[newTypes[index], newTypes[targetIndex]] = [newTypes[targetIndex], newTypes[index]]
    setTypes(newTypes)

    // DB更新
    try {
      await Promise.all([
        fetch(`/api/settings?table=document_types&id=${newTypes[index].id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sort_order: newTypes[index].sort_order }),
        }),
        fetch(`/api/settings?table=document_types&id=${newTypes[targetIndex].id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sort_order: newTypes[targetIndex].sort_order }),
        }),
      ])
    } catch {
      toast.error("並び替えの保存に失敗しました")
      await fetchTypes()
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  // 未登録状態：初期化ボタンを表示
  if (types.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>書類種別管理</CardTitle>
          <CardDescription>
            書類の種別をカスタマイズできます。まずデフォルト種別を初期化してください。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={initializeDefaults} disabled={isInitializing}>
            {isInitializing ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <Plus className="mr-2 size-4" />
            )}
            デフォルト種別を初期化
          </Button>
        </CardContent>
      </Card>
    )
  }

  // 追加提案のうち未登録のもの
  const availableSuggestions = SUGGESTED_TYPES.filter(
    (s) => !types.some((t) => t.name === s)
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>書類種別管理</CardTitle>
        <CardDescription>
          書類の種別を管理します。デフォルト種別（請求書・領収書・契約書）は削除できません。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 種別一覧テーブル */}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10"></TableHead>
              <TableHead>種別名</TableHead>
              <TableHead>Dropboxフォルダ</TableHead>
              <TableHead className="w-10"></TableHead>
              <TableHead className="w-24 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {types.map((type, index) => (
              <TableRow key={type.id}>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <button
                      onClick={() => handleMove(index, "up")}
                      disabled={index === 0}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                      aria-label="上に移動"
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => handleMove(index, "down")}
                      disabled={index === types.length - 1}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                      aria-label="下に移動"
                    >
                      ▼
                    </button>
                  </div>
                </TableCell>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    <GripVertical className="size-4 text-muted-foreground" />
                    {type.name}
                    {type.is_default && (
                      <Badge variant="outline" className="text-xs">デフォルト</Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {type.dropbox_folder || "—"}
                </TableCell>
                <TableCell></TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEditDialog(type)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    {!type.is_default && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(type)}
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {/* 追加ボタン */}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => openAddDialog()}>
            <Plus className="mr-2 size-4" />
            種別を追加
          </Button>
        </div>

        {/* 追加提案 */}
        {availableSuggestions.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">クイック追加：</p>
            <div className="flex flex-wrap gap-2">
              {availableSuggestions.map((name) => (
                <Button
                  key={name}
                  variant="outline"
                  size="sm"
                  onClick={() => openAddDialog(name)}
                >
                  + {name}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* 追加・編集ダイアログ */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editingType ? "書類種別を編集" : "書類種別を追加"}
              </DialogTitle>
              <DialogDescription>
                種別名と対応するDropboxフォルダを設定します
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="type-name">種別名</Label>
                <Input
                  id="type-name"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="例: 給与明細"
                  disabled={editingType?.is_default}
                />
                {editingType?.is_default && (
                  <p className="text-xs text-muted-foreground">
                    デフォルト種別の名前は変更できません
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="type-folder">Dropboxフォルダ名（任意）</Label>
                <Input
                  id="type-folder"
                  value={formFolder}
                  onChange={(e) => setFormFolder(e.target.value)}
                  placeholder="例: 給与明細"
                />
                <p className="text-xs text-muted-foreground">
                  Dropbox内のフォルダ名を指定します。空の場合は種別名がフォルダ名になります。
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                キャンセル
              </Button>
              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving && <Loader2 className="mr-2 size-4 animate-spin" />}
                保存
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}
