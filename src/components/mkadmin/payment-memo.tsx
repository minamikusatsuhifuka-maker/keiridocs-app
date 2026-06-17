"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Loader2,
  Sparkles,
  ImagePlus,
  X,
  Trash2,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  RotateCcw,
  AlertTriangle,
  Save,
  Link2,
} from "lucide-react"
import { toast } from "sonner"
import { LinkDocumentModal } from "@/components/mkadmin/link-document-modal"

/** 支払方法の表示ラベル */
const METHOD_LABELS: Record<string, string> = {
  bank_transfer: "振込",
  credit_card: "カード",
  auto_debit: "口座振替",
  unknown: "不明",
}
const METHOD_OPTIONS = ["bank_transfer", "credit_card", "auto_debit", "unknown"] as const

/** AI抽出 or 編集中の支払項目（プレビュー用） */
interface DraftItem {
  vendor_name: string
  amount: string // 入力欄なので文字列で保持
  due_date: string
  payment_method: string
  note: string
}

/** 保存済みの支払項目（一覧用） */
interface SavedItem {
  id: string
  memo_id: string | null
  vendor_name: string | null
  amount: number | null
  due_date: string | null
  payment_method: string | null
  note: string | null
  payment_status: string
  linked_document_id: string | null
  created_at: string
  memo: {
    id: string
    raw_text: string | null
    image_url: string | null
    ai_summary: string | null
    created_at: string
  } | null
}

/** 金額を「¥1,234」形式に */
function formatYen(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—"
  return `¥${n.toLocaleString("ja-JP")}`
}

/** 期限の状態を判定（期限切れ / 間近 / 通常） */
function dueState(due: string | null): "overdue" | "soon" | "normal" | "none" {
  if (!due) return "none"
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const d = new Date(due + "T00:00:00")
  const diffDays = Math.floor((d.getTime() - today.getTime()) / 86400000)
  if (diffDays < 0) return "overdue"
  if (diffDays <= 3) return "soon"
  return "normal"
}

export function PaymentMemo() {
  // ---- 入力エリア ----
  const [rawText, setRawText] = useState("")
  const [imageBase64, setImageBase64] = useState<string | null>(null)
  const [imageMime, setImageMime] = useState<string | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ---- AI抽出結果（編集可能なプレビュー） ----
  const [drafts, setDrafts] = useState<DraftItem[]>([])
  const [aiSummary, setAiSummary] = useState("")
  const [saving, setSaving] = useState(false)

  // ---- 保存済み一覧 ----
  const [savedItems, setSavedItems] = useState<SavedItem[]>([])
  const [unpaidTotal, setUnpaidTotal] = useState(0)
  const [loadingList, setLoadingList] = useState(true)
  const [expandedMemo, setExpandedMemo] = useState<string | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  // ---- 請求書紐づけモーダル ----
  const [linkTarget, setLinkTarget] = useState<SavedItem | null>(null)
  const [linkModalOpen, setLinkModalOpen] = useState(false)

  // ---- 一覧取得 ----
  const fetchList = useCallback(async () => {
    setLoadingList(true)
    try {
      const res = await fetch("/api/payment-memos")
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "一覧の取得に失敗しました")
      setSavedItems(data.items || [])
      setUnpaidTotal(data.unpaidTotal || 0)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "一覧の取得に失敗しました")
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    fetchList()
  }, [fetchList])

  // ---- 画像選択（ファイル → base64） ----
  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("画像ファイルを選択してください")
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("画像は10MB以下にしてください")
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // data:image/png;base64,XXXX → base64部分のみ抽出
      const base64 = result.includes(",") ? result.split(",")[1] : result
      setImageBase64(base64)
      setImageMime(file.type)
      setImagePreview(result)
    }
    reader.readAsDataURL(file)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer.files?.[0]
      if (file) handleFile(file)
    },
    [handleFile]
  )

  const clearImage = () => {
    setImageBase64(null)
    setImageMime(null)
    setImagePreview(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  // ---- AIで仕分け ----
  const handleAnalyze = async () => {
    if (!rawText.trim() && !imageBase64) {
      toast.error("テキストまたは画像を入力してください")
      return
    }
    setAnalyzing(true)
    try {
      const res = await fetch("/api/payment-memos/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raw_text: rawText,
          image_base64: imageBase64,
          image_mime_type: imageMime,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "AI抽出に失敗しました")

      const items = (data.items || []) as Array<{
        vendor_name: string
        amount: number | null
        due_date: string | null
        payment_method: string
        note: string | null
      }>
      setDrafts(
        items.map((it) => ({
          vendor_name: it.vendor_name || "",
          amount: it.amount === null || it.amount === undefined ? "" : String(it.amount),
          due_date: it.due_date || "",
          payment_method: it.payment_method || "unknown",
          note: it.note || "",
        }))
      )
      setAiSummary(data.ai_summary || "")
      if (items.length === 0) {
        toast.info("支払い項目は見つかりませんでした")
      } else {
        toast.success(`${items.length}件の支払い項目を抽出しました`)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "AI抽出に失敗しました")
    } finally {
      setAnalyzing(false)
    }
  }

  // ---- プレビュー項目の編集 ----
  const updateDraft = (index: number, field: keyof DraftItem, value: string) => {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, [field]: value } : d)))
  }
  const removeDraft = (index: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== index))
  }
  const addDraft = () => {
    setDrafts((prev) => [
      ...prev,
      { vendor_name: "", amount: "", due_date: "", payment_method: "unknown", note: "" },
    ])
  }

  // ---- 保存 ----
  const handleSave = async () => {
    if (drafts.length === 0) {
      toast.error("保存する項目がありません")
      return
    }
    setSaving(true)
    try {
      const items = drafts.map((d) => ({
        vendor_name: d.vendor_name.trim() || null,
        amount: d.amount.trim() === "" ? null : Number(d.amount.replace(/[,，]/g, "")),
        due_date: d.due_date.trim() || null,
        payment_method: d.payment_method || "unknown",
        note: d.note.trim() || null,
      }))
      const res = await fetch("/api/payment-memos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raw_text: rawText,
          ai_summary: aiSummary,
          image_base64: imageBase64,
          image_mime_type: imageMime,
          items,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "保存に失敗しました")

      toast.success("支払いメモを保存しました")
      // 入力リセット
      setRawText("")
      clearImage()
      setDrafts([])
      setAiSummary("")
      fetchList()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存に失敗しました")
    } finally {
      setSaving(false)
    }
  }

  // ---- 状態切替（未払い⇄支払済み） ----
  const toggleStatus = async (item: SavedItem) => {
    const next = item.payment_status === "未払い" ? "支払済み" : "未払い"
    setUpdatingId(item.id)
    try {
      const res = await fetch(`/api/payment-memo-items/${item.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payment_status: next }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "更新に失敗しました")
      toast.success(next === "支払済み" ? "支払済みにしました" : "未払いに戻しました")
      fetchList()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "更新に失敗しました")
    } finally {
      setUpdatingId(null)
    }
  }

  // ---- 紐づけモーダルを開く ----
  const openLinkModal = (item: SavedItem) => {
    setLinkTarget(item)
    setLinkModalOpen(true)
  }

  // ---- 紐づけ解除 ----
  const unlinkDocument = async (item: SavedItem) => {
    if (!confirm("この支払項目の請求書との紐づけを解除します。よろしいですか？")) return
    try {
      const res = await fetch(`/api/payment-memo-items/${item.id}/link`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: null }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "解除に失敗しました")
      toast.success("紐づけを解除しました")
      fetchList()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "解除に失敗しました")
    }
  }

  // ---- メモ削除 ----
  const deleteMemo = async (memoId: string) => {
    if (!confirm("このメモと紐づく支払項目をすべて削除します。よろしいですか？")) return
    try {
      const res = await fetch(`/api/payment-memos/${memoId}`, { method: "DELETE" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "削除に失敗しました")
      toast.success("メモを削除しました")
      fetchList()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除に失敗しました")
    }
  }

  return (
    <div className="space-y-6">
      {/* ============ 入力エリア ============ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="size-5" style={{ color: "var(--dusk-primary)" }} />
            支払いメモを作成
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="memo-text">メール本文・テキストを貼り付け</Label>
            <Textarea
              id="memo-text"
              placeholder="支払い依頼のメール本文などを貼り付けてください。複数の支払いが含まれていてもOKです。"
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              rows={6}
            />
          </div>

          {/* 画像アップロード */}
          <div className="space-y-2">
            <Label>スクリーンショット画像（任意）</Label>
            {imagePreview ? (
              <div className="relative inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imagePreview}
                  alt="アップロード画像"
                  className="max-h-48 rounded-md border"
                />
                <button
                  type="button"
                  onClick={clearImage}
                  className="absolute -right-2 -top-2 rounded-full bg-red-500 p-1 text-white shadow"
                  aria-label="画像を削除"
                >
                  <X className="size-4" />
                </button>
              </div>
            ) : (
              <div
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
                className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-muted-foreground/30 p-6 text-sm text-muted-foreground hover:border-muted-foreground/50"
              >
                <ImagePlus className="size-6" />
                クリックまたはドラッグ＆ドロップで画像を追加
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleFile(file)
              }}
            />
          </div>

          <Button
            className="btn-dusk-primary"
            onClick={handleAnalyze}
            disabled={analyzing || (!rawText.trim() && !imageBase64)}
          >
            {analyzing ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 size-4" />
            )}
            AIで仕分け
          </Button>
        </CardContent>
      </Card>

      {/* ============ AI抽出結果プレビュー ============ */}
      {drafts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">抽出結果（保存前に編集できます）</CardTitle>
            {aiSummary && <p className="text-sm text-muted-foreground">{aiSummary}</p>}
          </CardHeader>
          <CardContent className="space-y-3">
            {drafts.map((d, i) => (
              <div
                key={i}
                className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
              >
                {/* 1段目（狭い画面では折り返す）: 支払先・金額・期限・方法 */}
                <Input
                  value={d.vendor_name}
                  onChange={(e) => updateDraft(i, "vendor_name", e.target.value)}
                  placeholder="支払先"
                  className="h-8 min-w-[8rem] flex-[2]"
                />
                <Input
                  type="number"
                  value={d.amount}
                  onChange={(e) => updateDraft(i, "amount", e.target.value)}
                  placeholder="金額"
                  className="h-8 w-24 flex-1"
                />
                <Input
                  type="date"
                  value={d.due_date}
                  onChange={(e) => updateDraft(i, "due_date", e.target.value)}
                  className="h-8 w-[9.5rem]"
                  title="支払期限"
                />
                <Select
                  value={d.payment_method}
                  onValueChange={(v) => updateDraft(i, "payment_method", v)}
                >
                  <SelectTrigger className="h-8 w-24" aria-label="支払方法">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {METHOD_OPTIONS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {METHOD_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* 内容メモ＋削除（横幅が足りなければ2段目に回る） */}
                <Input
                  value={d.note}
                  onChange={(e) => updateDraft(i, "note", e.target.value)}
                  placeholder="内容メモ"
                  className="h-8 min-w-[8rem] flex-[2]"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeDraft(i)}
                  className="size-8 shrink-0 text-red-500 hover:text-red-600"
                  aria-label={`支払い${i + 1}を削除`}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={addDraft}>
                ＋ 項目を追加
              </Button>
              <Button className="btn-dusk-primary" onClick={handleSave} disabled={saving}>
                {saving ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Save className="mr-2 size-4" />
                )}
                保存
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ============ 保存済み一覧 ============ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-lg">
            <span>支払いメモ一覧</span>
            <span className="text-base font-bold" style={{ color: "var(--dusk-primary)" }}>
              未払い合計: {formatYen(unpaidTotal)}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loadingList ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : savedItems.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              まだ支払いメモはありません
            </p>
          ) : (
            <div className="space-y-3">
              {savedItems.map((item) => {
                const ds = dueState(item.due_date)
                const isPaid = item.payment_status === "支払済み"
                const memoExpanded = expandedMemo === item.id
                return (
                  <div
                    key={item.id}
                    className={`rounded-md border px-3 py-2 ${isPaid ? "opacity-60" : ""}`}
                  >
                    {/* 1行目: 支払先・金額・各バッジ・操作ボタンを横並び */}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium">
                        {item.vendor_name || "（支払先不明）"}
                      </span>
                      <span className="font-bold">{formatYen(item.amount)}</span>
                      <Badge variant="outline" className="px-1.5 py-0 text-xs">
                        {METHOD_LABELS[item.payment_method || "unknown"]}
                      </Badge>
                      {isPaid ? (
                        <Badge variant="secondary" className="px-1.5 py-0 text-xs">
                          支払済み
                        </Badge>
                      ) : (
                        <Badge variant="destructive" className="px-1.5 py-0 text-xs">
                          未払い
                        </Badge>
                      )}
                      {!isPaid && ds === "overdue" && (
                        <Badge variant="destructive" className="gap-0.5 px-1.5 py-0 text-xs">
                          <AlertTriangle className="size-3" />
                          期限切れ
                        </Badge>
                      )}
                      {!isPaid && ds === "soon" && (
                        <Badge className="gap-0.5 bg-amber-500 px-1.5 py-0 text-xs text-white hover:bg-amber-600">
                          <AlertTriangle className="size-3" />
                          期限間近
                        </Badge>
                      )}
                      {/* 紐づけ済みバッジ（リンク先documentsへ飛べる） */}
                      {item.linked_document_id && (
                        <a
                          href={`/documents/${item.linked_document_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Badge className="gap-0.5 bg-emerald-600 px-1.5 py-0 text-xs text-white hover:bg-emerald-700">
                            <CheckCircle2 className="size-3" />
                            請求書と紐づけ済み
                          </Badge>
                        </a>
                      )}

                      <div className="ml-auto flex items-center gap-1">
                        {/* 紐づけ導線（支払済みかつ未紐づけのとき）／解除（紐づけ済みのとき） */}
                        {item.linked_document_id ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs text-muted-foreground"
                            onClick={() => unlinkDocument(item)}
                          >
                            紐づけ解除
                          </Button>
                        ) : (
                          isPaid && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              onClick={() => openLinkModal(item)}
                            >
                              <Link2 className="mr-1 size-3.5" />
                              請求書と紐づける
                            </Button>
                          )
                        )}
                        <Button
                          size="sm"
                          variant={isPaid ? "outline" : "default"}
                          className={`h-7 px-2 text-xs ${isPaid ? "" : "btn-dusk-primary"}`}
                          onClick={() => toggleStatus(item)}
                          disabled={updatingId === item.id}
                        >
                          {updatingId === item.id ? (
                            <Loader2 className="mr-1 size-3.5 animate-spin" />
                          ) : isPaid ? (
                            <RotateCcw className="mr-1 size-3.5" />
                          ) : (
                            <CheckCircle2 className="mr-1 size-3.5" />
                          )}
                          {isPaid ? "未払いに戻す" : "支払済みにする"}
                        </Button>
                      </div>
                    </div>

                    {/* 2行目: 期限・内容メモ（薄い文字で1行）＋元メモ展開リンク */}
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span>期限 {item.due_date || "—"}</span>
                      {item.note && <span>・{item.note}</span>}
                      {item.memo && (item.memo.raw_text || item.memo.image_url) && (
                        <button
                          type="button"
                          onClick={() => setExpandedMemo(memoExpanded ? null : item.id)}
                          className="ml-auto flex items-center gap-0.5 hover:text-foreground"
                        >
                          {memoExpanded ? (
                            <ChevronDown className="size-3.5" />
                          ) : (
                            <ChevronRight className="size-3.5" />
                          )}
                          元メモ
                        </button>
                      )}
                    </div>

                    {/* 元メモの展開（閉じている時は高さを取らない） */}
                    {item.memo && (item.memo.raw_text || item.memo.image_url) && memoExpanded && (
                      <div className="mt-2 space-y-2 border-t pt-2">
                        {item.memo.raw_text && (
                          <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                            {item.memo.raw_text}
                          </pre>
                        )}
                        {item.memo.image_url && (
                          <p className="text-xs text-muted-foreground">
                            添付画像: {item.memo.image_url}
                          </p>
                        )}
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs text-red-500 hover:text-red-600"
                            onClick={() => deleteMemo(item.memo!.id)}
                          >
                            <Trash2 className="mr-1 size-3.5" />
                            このメモを削除
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 請求書紐づけモーダル */}
      <LinkDocumentModal
        open={linkModalOpen}
        onOpenChange={setLinkModalOpen}
        item={linkTarget}
        onLinked={fetchList}
      />
    </div>
  )
}
