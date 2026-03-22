"use client"

import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Loader2, Plus, Pencil, Trash2, Upload, Search } from "lucide-react"
import { toast } from "sonner"

interface ManualCategory {
  id: string
  name: string
  emoji: string
  description: string | null
}

interface Manual {
  id: string
  category_id: string | null
  title: string
  content: string
  source: string | null
  created_at: string
}

export default function ManualsPage() {
  const [categories, setCategories] = useState<ManualCategory[]>([])
  const [manuals, setManuals] = useState<Manual[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedCategory, setSelectedCategory] = useState<string>("all")

  // 編集ダイアログ
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingManual, setEditingManual] = useState<Manual | null>(null)
  const [formTitle, setFormTitle] = useState("")
  const [formContent, setFormContent] = useState("")
  const [formCategory, setFormCategory] = useState<string>("")
  const [formSource, setFormSource] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  // PDF解析
  const [isAnalyzing, setIsAnalyzing] = useState(false)

  // 検索テスト
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResult, setSearchResult] = useState<string>("")
  const [isSearching, setIsSearching] = useState(false)

  const fetchCategories = useCallback(async () => {
    try {
      const res = await fetch("/api/manuals/categories")
      if (!res.ok) throw new Error("取得失敗")
      const json = await res.json() as { data: ManualCategory[] }
      setCategories(json.data || [])
    } catch {
      toast.error("カテゴリの取得に失敗しました")
    }
  }, [])

  const fetchManuals = useCallback(async () => {
    setIsLoading(true)
    try {
      const params = new URLSearchParams()
      if (selectedCategory !== "all") params.set("category_id", selectedCategory)
      const res = await fetch(`/api/manuals?${params.toString()}`)
      if (!res.ok) throw new Error("取得失敗")
      const json = await res.json() as { data: Manual[] }
      setManuals(json.data || [])
    } catch {
      toast.error("マニュアルの取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }, [selectedCategory])

  useEffect(() => { fetchCategories() }, [fetchCategories])
  useEffect(() => { fetchManuals() }, [fetchManuals])

  const getCategoryName = (categoryId: string | null) => {
    if (!categoryId) return "未分類"
    const cat = categories.find((c) => c.id === categoryId)
    return cat ? `${cat.emoji} ${cat.name}` : "未分類"
  }

  const handleNew = () => {
    setEditingManual(null)
    setFormTitle("")
    setFormContent("")
    setFormCategory("")
    setFormSource("")
    setDialogOpen(true)
  }

  const handleEdit = (manual: Manual) => {
    setEditingManual(manual)
    setFormTitle(manual.title)
    setFormContent(manual.content)
    setFormCategory(manual.category_id || "")
    setFormSource(manual.source || "")
    setDialogOpen(true)
  }

  const handleSave = async () => {
    if (!formTitle || !formContent) {
      toast.error("タイトルと内容は必須です")
      return
    }
    setIsSaving(true)
    try {
      const payload = {
        ...(editingManual ? { id: editingManual.id } : {}),
        category_id: formCategory || null,
        title: formTitle,
        content: formContent,
        source: formSource || null,
      }
      const res = await fetch("/api/manuals", {
        method: editingManual ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const json = await res.json() as { error?: string }
        throw new Error(json.error || "保存失敗")
      }
      toast.success(editingManual ? "更新しました" : "追加しました")
      setDialogOpen(false)
      fetchManuals()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存に失敗しました")
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm("このマニュアルを削除しますか？")) return
    try {
      const res = await fetch(`/api/manuals?id=${id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("削除失敗")
      toast.success("削除しました")
      fetchManuals()
    } catch {
      toast.error("削除に失敗しました")
    }
  }

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.type !== "application/pdf") {
      toast.error("PDFファイルを選択してください")
      return
    }

    setIsAnalyzing(true)
    try {
      const arrayBuffer = await file.arrayBuffer()
      const base64 = Buffer.from(arrayBuffer).toString("base64")

      const res = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base64,
          mimeType: "application/pdf",
        }),
      })

      if (!res.ok) throw new Error("PDF解析に失敗しました")
      const json = await res.json() as { description?: string; vendor_name?: string }

      // 解析結果をフォームに反映
      setFormTitle(file.name.replace(/\.pdf$/i, ""))
      setFormContent(json.description || "（解析結果なし）")
      setFormSource(`PDF: ${file.name}`)
      setDialogOpen(true)
      toast.success("PDFを解析しました。内容を確認・編集してください。")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "PDF解析に失敗しました")
    } finally {
      setIsAnalyzing(false)
      e.target.value = ""
    }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    setIsSearching(true)
    setSearchResult("")
    try {
      const res = await fetch("/api/manuals/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery }),
      })
      if (!res.ok) throw new Error("検索失敗")
      const json = await res.json() as { answer: string }
      setSearchResult(json.answer)
    } catch {
      toast.error("検索に失敗しました")
    } finally {
      setIsSearching(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">マニュアル管理</h1>
        <div className="flex gap-2">
          <label>
            <input
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={handlePdfUpload}
              disabled={isAnalyzing}
            />
            <Button variant="outline" asChild disabled={isAnalyzing}>
              <span>
                {isAnalyzing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Upload className="mr-2 size-4" />}
                PDFから追加
              </span>
            </Button>
          </label>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={handleNew}>
                <Plus className="mr-2 size-4" />
                新規追加
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{editingManual ? "マニュアル編集" : "マニュアル追加"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-1">
                  <Label>カテゴリ</Label>
                  <Select value={formCategory} onValueChange={setFormCategory}>
                    <SelectTrigger>
                      <SelectValue placeholder="カテゴリを選択" />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.emoji} {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>タイトル</Label>
                  <Input
                    value={formTitle}
                    onChange={(e) => setFormTitle(e.target.value)}
                    placeholder="マニュアルのタイトル"
                  />
                </div>
                <div className="space-y-1">
                  <Label>内容</Label>
                  <textarea
                    className="flex min-h-[200px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={formContent}
                    onChange={(e) => setFormContent(e.target.value)}
                    placeholder="マニュアルの内容を入力"
                  />
                </div>
                <div className="space-y-1">
                  <Label>出典（任意）</Label>
                  <Input
                    value={formSource}
                    onChange={(e) => setFormSource(e.target.value)}
                    placeholder="例: 院内マニュアル2024年版"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setDialogOpen(false)}>
                    キャンセル
                  </Button>
                  <Button onClick={handleSave} disabled={isSaving}>
                    {isSaving && <Loader2 className="mr-2 size-4 animate-spin" />}
                    {editingManual ? "更新" : "追加"}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* AI検索テスト */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI検索テスト</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="質問を入力（例: 受付の手順は？）"
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            />
            <Button onClick={handleSearch} disabled={isSearching}>
              {isSearching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            </Button>
          </div>
          {searchResult && (
            <div className="mt-3 rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">
              {searchResult}
            </div>
          )}
        </CardContent>
      </Card>

      {/* フィルター */}
      <div className="flex gap-4">
        <div className="space-y-1">
          <Label>カテゴリ</Label>
          <Select value={selectedCategory} onValueChange={setSelectedCategory}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">すべて</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.emoji} {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* マニュアル数 */}
      <div className="text-sm text-muted-foreground">
        {manuals.length}件のマニュアル
      </div>

      {/* マニュアル一覧 */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : manuals.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          マニュアルがありません
        </div>
      ) : (
        <div className="grid gap-4">
          {manuals.map((manual) => (
            <Card key={manual.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div>
                    <span className="text-xs text-muted-foreground">
                      {getCategoryName(manual.category_id)}
                    </span>
                    <CardTitle className="text-base">{manual.title}</CardTitle>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEdit(manual)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(manual.id)}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap line-clamp-4">
                  {manual.content}
                </p>
                {manual.source && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    出典: {manual.source}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
