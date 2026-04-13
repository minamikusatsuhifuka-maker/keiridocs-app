"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Loader2,
  Upload,
  Camera,
  Search,
  Trash2,
  Pencil,
  Building2,
  Mail,
  Phone,
  Smartphone,
  MapPin,
  Globe,
  UserRound,
} from "lucide-react"
import { toast } from "sonner"

interface BusinessCard {
  id: string
  company_name: string | null
  department: string | null
  name: string | null
  title: string | null
  email: string | null
  phone: string | null
  mobile: string | null
  address: string | null
  website: string | null
  memo: string | null
  dropbox_path: string | null
  file_name: string | null
  created_at: string
}

type FormState = {
  company_name: string
  department: string
  name: string
  title: string
  email: string
  phone: string
  mobile: string
  address: string
  website: string
  memo: string
}

const EMPTY_FORM: FormState = {
  company_name: "",
  department: "",
  name: "",
  title: "",
  email: "",
  phone: "",
  mobile: "",
  address: "",
  website: "",
  memo: "",
}

export default function BusinessCardsPage() {
  const [cards, setCards] = useState<BusinessCard[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isUploading, setIsUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [searchCompany, setSearchCompany] = useState("")
  const [searchName, setSearchName] = useState("")

  // 編集ダイアログ
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingCard, setEditingCard] = useState<BusinessCard | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [isSaving, setIsSaving] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  /* ---------- データ取得 ---------- */
  const fetchCards = useCallback(async () => {
    setIsLoading(true)
    try {
      const params = new URLSearchParams()
      if (searchCompany) params.set("company_name", searchCompany)
      if (searchName) params.set("name", searchName)
      const res = await fetch(`/api/business-cards?${params.toString()}`)
      if (!res.ok) throw new Error("取得失敗")
      const json = await res.json() as { data: BusinessCard[] }
      setCards(json.data || [])
    } catch {
      toast.error("名刺の取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }, [searchCompany, searchName])

  useEffect(() => { fetchCards() }, [fetchCards])

  /* ---------- アップロード処理 ---------- */
  const handleFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (list.length === 0) return

    setIsUploading(true)
    try {
      for (const file of list) {
        const formData = new FormData()
        formData.append("file", file)

        const res = await fetch("/api/business-cards", {
          method: "POST",
          body: formData,
        })

        if (!res.ok) {
          const json = await res.json().catch(() => ({})) as { error?: string }
          throw new Error(json.error || "アップロード失敗")
        }

        const json = await res.json() as { data: BusinessCard }
        toast.success(`${json.data.name || "名刺"} を登録しました`)

        // 登録直後の名刺を編集ダイアログで開く（1件のみの場合）
        if (list.length === 1) {
          openEditDialog(json.data)
        }
      }
      fetchCards()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "アップロードに失敗しました")
    } finally {
      setIsUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
      if (cameraInputRef.current) cameraInputRef.current.value = ""
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files)
    }
  }

  /* ---------- 編集 ---------- */
  const openEditDialog = (card: BusinessCard) => {
    setEditingCard(card)
    setForm({
      company_name: card.company_name || "",
      department: card.department || "",
      name: card.name || "",
      title: card.title || "",
      email: card.email || "",
      phone: card.phone || "",
      mobile: card.mobile || "",
      address: card.address || "",
      website: card.website || "",
      memo: card.memo || "",
    })
    setDialogOpen(true)
  }

  const handleSave = async () => {
    if (!editingCard) return
    setIsSaving(true)
    try {
      const res = await fetch("/api/business-cards", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingCard.id, ...form }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(json.error || "更新失敗")
      }
      toast.success("更新しました")
      setDialogOpen(false)
      fetchCards()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "更新に失敗しました")
    } finally {
      setIsSaving(false)
    }
  }

  /* ---------- 削除 ---------- */
  const handleDelete = async (id: string) => {
    if (!confirm("この名刺を削除しますか？ (Dropboxのファイルも削除されます)")) return
    try {
      const res = await fetch(`/api/business-cards?id=${id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("削除失敗")
      toast.success("削除しました")
      fetchCards()
    } catch {
      toast.error("削除に失敗しました")
    }
  }

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold" style={{ color: "var(--dusk-text-main)" }}>
          名刺管理
        </h1>
        <div className="flex gap-2 flex-wrap">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
            disabled={isUploading}
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
            disabled={isUploading}
          />
          <Button
            variant="outline"
            onClick={() => cameraInputRef.current?.click()}
            disabled={isUploading}
            className="md:hidden"
          >
            <Camera className="mr-2 size-4" />
            撮影
          </Button>
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="btn-dusk-primary text-white"
          >
            {isUploading ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <Upload className="mr-2 size-4" />
            )}
            アップロード
          </Button>
        </div>
      </div>

      {/* ドラッグ&ドロップゾーン */}
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => !isUploading && fileInputRef.current?.click()}
        className="rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition-colors"
        style={{
          borderColor: isDragging ? "var(--dusk-primary)" : "var(--dusk-border)",
          background: isDragging ? "var(--dusk-primary-light)" : "var(--dusk-bg-card)",
          color: "var(--dusk-text-muted)",
        }}
      >
        {isUploading ? (
          <div className="flex items-center justify-center gap-2">
            <Loader2 className="size-5 animate-spin" />
            <span>AI解析中...</span>
          </div>
        ) : (
          <>
            <Upload className="mx-auto size-8 mb-2" />
            <p className="text-sm">
              名刺画像をドラッグ&ドロップ、またはクリックして選択
            </p>
            <p className="text-xs mt-1">JPG / PNG / PDF 対応（複数可）</p>
          </>
        )}
      </div>

      {/* 検索 */}
      <Card className="card-dusk">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Search className="size-4" />
            検索
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>会社名</Label>
              <Input
                value={searchCompany}
                onChange={(e) => setSearchCompany(e.target.value)}
                placeholder="会社名で検索"
              />
            </div>
            <div className="space-y-1">
              <Label>氏名</Label>
              <Input
                value={searchName}
                onChange={(e) => setSearchName(e.target.value)}
                placeholder="氏名で検索"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 件数 */}
      <div className="text-sm" style={{ color: "var(--dusk-text-muted)" }}>
        {cards.length}件の名刺
      </div>

      {/* 一覧（カード形式） */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin" style={{ color: "var(--dusk-text-muted)" }} />
        </div>
      ) : cards.length === 0 ? (
        <div className="py-12 text-center" style={{ color: "var(--dusk-text-muted)" }}>
          名刺がありません。上のエリアから登録してください。
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {cards.map((card) => (
            <Card key={card.id} className="card-dusk">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--dusk-text-muted)" }}>
                      <Building2 className="size-3" />
                      <span className="truncate">{card.company_name || "—"}</span>
                    </div>
                    {card.department && (
                      <div className="text-xs truncate" style={{ color: "var(--dusk-text-muted)" }}>
                        {card.department}
                      </div>
                    )}
                    <CardTitle className="text-base flex items-center gap-1.5 mt-1" style={{ color: "var(--dusk-text-main)" }}>
                      <UserRound className="size-4" />
                      {card.name || "—"}
                    </CardTitle>
                    {card.title && (
                      <div className="text-xs mt-0.5" style={{ color: "var(--dusk-text-muted)" }}>
                        {card.title}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => openEditDialog(card)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => handleDelete(card.id)}
                    >
                      <Trash2 className="size-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-1 text-xs" style={{ color: "var(--dusk-text-main)" }}>
                {card.email && (
                  <div className="flex items-center gap-1.5 truncate">
                    <Mail className="size-3 shrink-0" />
                    <a href={`mailto:${card.email}`} className="truncate hover:underline">{card.email}</a>
                  </div>
                )}
                {card.phone && (
                  <div className="flex items-center gap-1.5 truncate">
                    <Phone className="size-3 shrink-0" />
                    <a href={`tel:${card.phone}`} className="hover:underline">{card.phone}</a>
                  </div>
                )}
                {card.mobile && (
                  <div className="flex items-center gap-1.5 truncate">
                    <Smartphone className="size-3 shrink-0" />
                    <a href={`tel:${card.mobile}`} className="hover:underline">{card.mobile}</a>
                  </div>
                )}
                {card.address && (
                  <div className="flex items-start gap-1.5">
                    <MapPin className="size-3 shrink-0 mt-0.5" />
                    <span className="line-clamp-2">{card.address}</span>
                  </div>
                )}
                {card.website && (
                  <div className="flex items-center gap-1.5 truncate">
                    <Globe className="size-3 shrink-0" />
                    <a href={card.website} target="_blank" rel="noopener noreferrer" className="truncate hover:underline">
                      {card.website}
                    </a>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 編集ダイアログ */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>名刺情報を編集</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>会社名</Label>
                <Input
                  value={form.company_name}
                  onChange={(e) => setForm({ ...form, company_name: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>部署</Label>
                <Input
                  value={form.department}
                  onChange={(e) => setForm({ ...form, department: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>氏名</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>役職</Label>
                <Input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </div>
              <div className="space-y-1 col-span-2">
                <Label>メール</Label>
                <Input
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>電話</Label>
                <Input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>携帯</Label>
                <Input
                  value={form.mobile}
                  onChange={(e) => setForm({ ...form, mobile: e.target.value })}
                />
              </div>
              <div className="space-y-1 col-span-2">
                <Label>住所</Label>
                <Input
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                />
              </div>
              <div className="space-y-1 col-span-2">
                <Label>ウェブサイト</Label>
                <Input
                  value={form.website}
                  onChange={(e) => setForm({ ...form, website: e.target.value })}
                />
              </div>
              <div className="space-y-1 col-span-2">
                <Label>メモ</Label>
                <textarea
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={form.memo}
                  onChange={(e) => setForm({ ...form, memo: e.target.value })}
                  placeholder="自由記述"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                キャンセル
              </Button>
              <Button onClick={handleSave} disabled={isSaving} className="btn-dusk-primary text-white">
                {isSaving && <Loader2 className="mr-2 size-4 animate-spin" />}
                保存
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
