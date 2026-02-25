"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Plus, Trash2, Loader2, Wand2, Pencil, Check, X } from "lucide-react"
import { toast } from "sonner"
import type { Database } from "@/types/database"

type DownloadSource = Database["public"]["Tables"]["download_sources"]["Row"]

// 医療法人向けプリセット
const PRESET_SOURCES = [
  { name: "関西電力", url: "https://www.kepco.co.jp/", description: "電気料金" },
  { name: "大阪ガス", url: "https://www.osakagas.co.jp/", description: "ガス料金" },
  { name: "NTT西日本", url: "https://www.ntt-west.co.jp/", description: "固定電話・回線" },
  { name: "NTTドコモ", url: "https://www.docomo.ne.jp/", description: "携帯電話" },
  { name: "au", url: "https://www.au.com/", description: "携帯電話" },
  { name: "水道局", url: "", description: "水道料金" },
]

// 自動取得ソース設定
export function DownloadSourceSettings() {
  const [sources, setSources] = useState<DownloadSource[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isAdding, setIsAdding] = useState(false)
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [description, setDescription] = useState("")
  const [schedule, setSchedule] = useState("manual")

  // 編集中の行
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editUrl, setEditUrl] = useState("")
  const [editDescription, setEditDescription] = useState("")
  const [editSchedule, setEditSchedule] = useState("manual")

  // ソース一覧を取得
  const fetchSources = useCallback(async () => {
    try {
      const res = await fetch("/api/settings?table=download_sources")
      const json = await res.json() as { data?: DownloadSource[]; error?: string }
      if (json.error) throw new Error(json.error)
      setSources(json.data ?? [])
    } catch {
      toast.error("自動取得ソースの取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSources()
  }, [fetchSources])

  // ソースを追加
  async function handleAdd() {
    if (!name.trim()) {
      toast.error("ソース名を入力してください")
      return
    }

    setIsAdding(true)
    try {
      const res = await fetch("/api/settings?table=download_sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          url: url.trim() || null,
          description: description.trim() || null,
          schedule,
        }),
      })
      const json = await res.json() as { data?: DownloadSource; error?: string }
      if (json.error) throw new Error(json.error)
      setSources((prev) => [...prev, json.data!])
      setName("")
      setUrl("")
      setDescription("")
      setSchedule("manual")
      toast.success("ソースを追加しました")
    } catch (e) {
      const msg = e instanceof Error ? e.message : "ソースの追加に失敗しました"
      toast.error(msg)
    } finally {
      setIsAdding(false)
    }
  }

  // ソースを削除
  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/settings?table=download_sources&id=${id}`, {
        method: "DELETE",
      })
      const json = await res.json() as { success?: boolean; error?: string }
      if (json.error) throw new Error(json.error)
      setSources((prev) => prev.filter((s) => s.id !== id))
      toast.success("ソースを削除しました")
    } catch {
      toast.error("ソースの削除に失敗しました")
    }
  }

  // 有効/無効トグル
  async function handleToggle(source: DownloadSource) {
    try {
      const res = await fetch(`/api/settings?table=download_sources&id=${source.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !source.is_active }),
      })
      const json = await res.json() as { data?: DownloadSource; error?: string }
      if (json.error) throw new Error(json.error)
      setSources((prev) =>
        prev.map((s) => (s.id === source.id ? { ...s, is_active: !s.is_active } : s))
      )
    } catch {
      toast.error("ソースの更新に失敗しました")
    }
  }

  // 編集開始
  function startEdit(source: DownloadSource) {
    setEditingId(source.id)
    setEditName(source.name)
    setEditUrl(source.url ?? "")
    setEditDescription(source.description ?? "")
    setEditSchedule(source.schedule)
  }

  // 編集保存
  async function handleSaveEdit(id: string) {
    if (!editName.trim()) return

    try {
      const res = await fetch(`/api/settings?table=download_sources&id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          url: editUrl.trim() || null,
          description: editDescription.trim() || null,
          schedule: editSchedule,
        }),
      })
      const json = await res.json() as { data?: DownloadSource; error?: string }
      if (json.error) throw new Error(json.error)
      setSources((prev) =>
        prev.map((s) =>
          s.id === id
            ? {
                ...s,
                name: editName.trim(),
                url: editUrl.trim() || null,
                description: editDescription.trim() || null,
                schedule: editSchedule,
              }
            : s
        )
      )
      setEditingId(null)
      toast.success("ソースを更新しました")
    } catch {
      toast.error("ソースの更新に失敗しました")
    }
  }

  // プリセット一括追加
  async function handleAddPresets() {
    const existingNames = new Set(sources.map((s) => s.name))
    const toAdd = PRESET_SOURCES.filter((p) => !existingNames.has(p.name))

    if (toAdd.length === 0) {
      toast.info("すべてのプリセットが既に登録されています")
      return
    }

    let added = 0
    for (const preset of toAdd) {
      try {
        const res = await fetch("/api/settings?table=download_sources", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(preset),
        })
        const json = await res.json() as { data?: DownloadSource; error?: string }
        if (json.data) {
          setSources((prev) => [...prev, json.data!])
          added++
        }
      } catch {
        // 個別のエラーは無視して続行
      }
    }

    if (added > 0) {
      toast.success(`${added}件のプリセットを追加しました`)
    }
  }

  // 最終取得日のフォーマット
  function formatDate(dateStr: string | null) {
    if (!dateStr) return "未取得"
    return new Date(dateStr).toLocaleDateString("ja-JP")
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>自動取得ソース</CardTitle>
        <CardDescription>
          請求書を定期的に取得するサイトを登録します。登録後は「自動取得」ページからファイルをアップロードして取り込めます。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* プリセット一括追加 */}
        <div className="space-y-2">
          <Label>医療法人向けプリセット</Label>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={handleAddPresets}>
              <Wand2 className="size-3.5" />
              プリセットを一括追加
            </Button>
            <div className="flex flex-wrap gap-1">
              {PRESET_SOURCES.map((preset) => (
                <Badge key={preset.name} variant="secondary" className="text-xs">
                  {preset.name}
                </Badge>
              ))}
            </div>
          </div>
        </div>

        {/* 追加フォーム */}
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="source-name">ソース名 *</Label>
              <Input
                id="source-name"
                placeholder="例: 関西電力"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="source-url">サイトURL</Label>
              <Input
                id="source-url"
                placeholder="https://..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="source-desc">メモ</Label>
              <Input
                id="source-desc"
                placeholder="例: 電気料金"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="source-schedule">スケジュール</Label>
              <Select value={schedule} onValueChange={setSchedule}>
                <SelectTrigger id="source-schedule">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">手動</SelectItem>
                  <SelectItem value="monthly">月次</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button onClick={handleAdd} disabled={isAdding || !name.trim()}>
            {isAdding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            追加
          </Button>
        </div>

        {/* 一覧テーブル */}
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : sources.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            自動取得ソースが登録されていません
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ソース名</TableHead>
                  <TableHead className="hidden sm:table-cell">URL</TableHead>
                  <TableHead>スケジュール</TableHead>
                  <TableHead className="hidden sm:table-cell">最終取得日</TableHead>
                  <TableHead className="w-20">有効</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.map((source) => (
                  <TableRow key={source.id}>
                    <TableCell>
                      {editingId === source.id ? (
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="h-8"
                        />
                      ) : (
                        <div>
                          <span className="font-medium">{source.name}</span>
                          {source.description && (
                            <p className="text-xs text-muted-foreground">{source.description}</p>
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {editingId === source.id ? (
                        <Input
                          value={editUrl}
                          onChange={(e) => setEditUrl(e.target.value)}
                          className="h-8"
                          placeholder="https://..."
                        />
                      ) : source.url ? (
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-600 hover:underline"
                        >
                          {new URL(source.url).hostname}
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {editingId === source.id ? (
                        <Select value={editSchedule} onValueChange={setEditSchedule}>
                          <SelectTrigger className="h-8 w-24">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="manual">手動</SelectItem>
                            <SelectItem value="monthly">月次</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant={source.schedule === "monthly" ? "default" : "secondary"} className="text-xs">
                          {source.schedule === "monthly" ? "月次" : "手動"}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <span className="text-xs text-muted-foreground">
                        {formatDate(source.last_downloaded_at)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={source.is_active}
                        onCheckedChange={() => handleToggle(source)}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {editingId === source.id ? (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleSaveEdit(source.id)}
                              className="size-8"
                            >
                              <Check className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setEditingId(null)}
                              className="size-8"
                            >
                              <X className="size-4" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => startEdit(source)}
                              className="size-8"
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDelete(source.id)}
                              className="size-8 text-destructive hover:text-destructive"
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
          </div>
        )}
      </CardContent>
    </Card>
  )
}
