"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2, Search, Upload, FileText, Link2 } from "lucide-react"
import { toast } from "sonner"

/** 紐づけ対象の支払項目（モーダルが必要とする最小情報） */
interface TargetItem {
  id: string
  vendor_name: string | null
  amount: number | null
  due_date: string | null
  note: string | null
}

/** documents 検索結果の1件 */
interface DocCandidate {
  id: string
  type: string
  vendor_name: string
  amount: number | null
  issue_date: string | null
  due_date: string | null
  created_at: string
}

/** Gemini解析結果（必要な項目のみ） */
interface OcrResult {
  vendor_name: string
  amount: number | null
  issue_date: string | null
  due_date: string | null
  description: string | null
  tax_category: string | null
  account_title: string | null
  items?: unknown[]
}

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  item: TargetItem | null
  onLinked: () => void
}

function formatYen(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—"
  return `¥${n.toLocaleString("ja-JP")}`
}

export function LinkDocumentModal({ open, onOpenChange, item, onLinked }: Props) {
  // ---- 方式A: 既存検索 ----
  const [search, setSearch] = useState("")
  const [candidates, setCandidates] = useState<DocCandidate[]>([])
  const [searching, setSearching] = useState(false)
  const [linkingId, setLinkingId] = useState<string | null>(null)

  // ---- 方式B: 新規アップロード ----
  const [uploading, setUploading] = useState(false)
  const [uploadStep, setUploadStep] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 既存請求書を検索（type=請求書、取引先名で絞り込み）
  const runSearch = useCallback(async (q: string) => {
    setSearching(true)
    try {
      const url = `/api/documents?type=${encodeURIComponent("請求書")}&limit=20${
        q.trim() ? `&search=${encodeURIComponent(q.trim())}` : ""
      }`
      const res = await fetch(url)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "検索に失敗しました")
      setCandidates((data.data || []) as DocCandidate[])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "検索に失敗しました")
    } finally {
      setSearching(false)
    }
  }, [])

  // モーダルを開いたら、メモの支払先で初期検索
  useEffect(() => {
    if (open && item) {
      const initial = item.vendor_name || ""
      setSearch(initial)
      runSearch(initial)
    } else {
      setSearch("")
      setCandidates([])
      setUploadStep("")
    }
  }, [open, item, runSearch])

  // リンクAPI呼び出し
  const linkTo = useCallback(
    async (documentId: string) => {
      if (!item) return
      const res = await fetch(`/api/payment-memo-items/${item.id}/link`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "紐づけに失敗しました")
    },
    [item]
  )

  // 方式A: 既存を選択して紐づけ
  const handleSelect = async (doc: DocCandidate) => {
    setLinkingId(doc.id)
    try {
      await linkTo(doc.id)
      toast.success("請求書と紐づけました")
      onOpenChange(false)
      onLinked()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "紐づけに失敗しました")
    } finally {
      setLinkingId(null)
    }
  }

  // 方式B: ファイルをアップロード → documents化 → 紐づけ
  const handleUpload = async (file: File) => {
    if (!item) return
    if (file.size > 10 * 1024 * 1024) {
      toast.error("ファイルは10MB以下にしてください")
      return
    }
    setUploading(true)
    try {
      // ファイル → base64
      setUploadStep("ファイルを読み込み中…")
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = reader.result as string
          resolve(result.includes(",") ? result.split(",")[1] : result)
        }
        reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました"))
        reader.readAsDataURL(file)
      })
      const mimeType = file.type || "application/octet-stream"

      // 1. Gemini解析（既存 /api/gemini を流用）
      setUploadStep("AIで解析中…")
      const aiRes = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base64, mimeType, fileName: file.name }),
      })
      const aiJson = await aiRes.json()
      if (!aiRes.ok) throw new Error(aiJson.error || "AI解析に失敗しました")
      const ocr = (aiJson.data || {}) as OcrResult

      // 解析できなければメモの値で補完
      const vendorName = ocr.vendor_name || item.vendor_name || "不明"
      const amount = ocr.amount ?? item.amount ?? null
      const issueDate = ocr.issue_date || null
      const dueDate = ocr.due_date || item.due_date || null

      // 2. Dropboxアップロード（既存 /api/dropbox/upload を流用）
      setUploadStep("Dropboxに保存中…")
      const upRes = await fetch("/api/dropbox/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base64,
          fileName: file.name,
          type: "請求書",
          date: issueDate,
          status: "未処理",
          vendorName,
        }),
      })
      const upJson = await upRes.json()
      if (!upRes.ok) throw new Error(upJson.error || "Dropbox保存に失敗しました")
      const { path: dropboxPath, file_hash: fileHash } = upJson.data as {
        path: string
        file_hash: string
      }

      // 3. documents へ登録（既存 /api/documents を流用。重複チェックはスキップ）
      setUploadStep("書類を登録中…")
      const docRes = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "請求書",
          vendor_name: vendorName,
          amount,
          issue_date: issueDate,
          due_date: dueDate,
          description: ocr.description || item.note || null,
          input_method: "upload",
          dropbox_path: dropboxPath,
          ocr_raw: ocr,
          tax_category: ocr.tax_category || "未判定",
          account_title: ocr.account_title || "",
          file_hash: fileHash,
          skip_duplicate_check: true,
          items: ocr.items ?? [],
        }),
      })
      const docJson = await docRes.json()
      if (!docRes.ok) throw new Error(docJson.error || "書類の登録に失敗しました")
      const newDoc = docJson.data as { id: string } | null
      if (!newDoc?.id) throw new Error("書類IDの取得に失敗しました")

      // 4. 作成した documents と紐づけ
      setUploadStep("紐づけ中…")
      await linkTo(newDoc.id)

      toast.success("請求書を登録して紐づけました")
      onOpenChange(false)
      onLinked()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "アップロードに失敗しました")
    } finally {
      setUploading(false)
      setUploadStep("")
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="size-5" style={{ color: "var(--dusk-primary)" }} />
            請求書と紐づける
          </DialogTitle>
        </DialogHeader>

        {item && (
          <div className="rounded-md bg-muted px-3 py-2 text-sm">
            <span className="font-medium">{item.vendor_name || "（支払先不明）"}</span>
            <span className="ml-2 font-bold">{formatYen(item.amount)}</span>
            {item.note && <span className="ml-2 text-muted-foreground">/ {item.note}</span>}
          </div>
        )}

        <Tabs defaultValue="existing" className="mt-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="existing" className="gap-1.5">
              <Search className="size-4" />
              既存から選ぶ
            </TabsTrigger>
            <TabsTrigger value="upload" className="gap-1.5">
              <Upload className="size-4" />
              新規アップロード
            </TabsTrigger>
          </TabsList>

          {/* 方式A: 既存の請求書から選ぶ */}
          <TabsContent value="existing" className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="取引先名・摘要で検索"
                onKeyDown={(e) => {
                  if (e.key === "Enter") runSearch(search)
                }}
              />
              <Button
                variant="outline"
                onClick={() => runSearch(search)}
                disabled={searching}
              >
                {searching ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Search className="size-4" />
                )}
              </Button>
            </div>

            <div className="max-h-72 space-y-2 overflow-y-auto">
              {searching ? (
                <div className="flex justify-center py-6">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : candidates.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  該当する請求書がありません
                </p>
              ) : (
                candidates.map((doc) => (
                  <button
                    key={doc.id}
                    type="button"
                    onClick={() => handleSelect(doc)}
                    disabled={linkingId !== null}
                    className="flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{doc.vendor_name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {doc.issue_date || doc.created_at.slice(0, 10)}
                        </span>
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="font-bold">{formatYen(doc.amount)}</span>
                      {linkingId === doc.id && (
                        <Loader2 className="size-4 animate-spin" />
                      )}
                    </span>
                  </button>
                ))
              )}
            </div>
          </TabsContent>

          {/* 方式B: その場でアップロードして documents 化＋リンク */}
          <TabsContent value="upload" className="space-y-3">
            <div
              onClick={() => !uploading && fileInputRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-muted-foreground/30 p-8 text-sm text-muted-foreground hover:border-muted-foreground/50"
            >
              {uploading ? (
                <>
                  <Loader2 className="size-6 animate-spin" />
                  {uploadStep || "処理中…"}
                </>
              ) : (
                <>
                  <Upload className="size-6" />
                  クリックして請求書（PDF/画像）を選択
                  <span className="text-xs">AI解析→書類登録→自動で紐づけ</span>
                </>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleUpload(file)
              }}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
