"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import Link from "next/link"
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { StatusBadge } from "@/components/documents/status-badge"
import { SplitPaymentsConfirm } from "@/components/documents/split-payments-confirm"
import { ArrowLeft, Loader2, Pencil, Trash2, Save, X, RefreshCw, AlertTriangle, Upload } from "lucide-react"
import type { Database } from "@/types/database"
import { TAX_CATEGORIES, ACCOUNT_TITLES, type SplitPayment } from "@/lib/gemini"
import { toast } from "sonner"

type Document = Database["public"]["Tables"]["documents"]["Row"]

const typeOptions = ["請求書", "領収書", "契約書", "売上記録"]

/** 金額をカンマ区切りでフォーマット */
function formatAmount(amount: number | null): string {
  if (amount === null) return "-"
  return `¥${amount.toLocaleString()}`
}

/** 日付を yyyy/MM/dd でフォーマット */
function formatDate(date: string | null): string {
  if (!date) return "-"
  return new Date(date).toLocaleDateString("ja-JP")
}

/** 入力経路の表示名 */
function inputMethodLabel(method: string): string {
  switch (method) {
    case "camera": return "カメラ撮影"
    case "upload": return "ファイルアップロード"
    case "email": return "メール取込"
    default: return method
  }
}

export default function DocumentDetailPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string

  const [doc, setDoc] = useState<Document | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isEditing, setIsEditing] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isReanalyzing, setIsReanalyzing] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  // 再解析で検出した複数支払いの分割候補（確認UIを経て分割する）
  const [splitCandidates, setSplitCandidates] = useState<SplitPayment[] | null>(null)
  const [splitTotalAmount, setSplitTotalAmount] = useState<number | null>(null)
  const [isSplitting, setIsSplitting] = useState(false)

  // ファイル欠損チェック・再アップロード
  const [fileMissing, setFileMissing] = useState<boolean | null>(null) // null=未確認
  const [isReuploading, setIsReuploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 編集フォーム
  const [editType, setEditType] = useState("")
  const [editVendor, setEditVendor] = useState("")
  const [editAmount, setEditAmount] = useState("")
  const [editIssueDate, setEditIssueDate] = useState("")
  const [editDueDate, setEditDueDate] = useState("")
  const [editDescription, setEditDescription] = useState("")
  const [editTaxCategory, setEditTaxCategory] = useState("")
  const [editAccountTitle, setEditAccountTitle] = useState("")

  // データ取得
  const fetchDocument = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch(`/api/documents?id=${id}`)
      if (!res.ok) throw new Error("データの取得に失敗しました")
      const json = await res.json() as { data: Document }
      setDoc(json.data)
    } catch {
      toast.error("書類の取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }, [id])

  useEffect(() => {
    fetchDocument()
  }, [fetchDocument])

  // Dropbox実ファイルの存在確認（メタデータ確認のみ・軽量）
  const checkFileExists = useCallback(async () => {
    try {
      const res = await fetch(`/api/documents/${id}/reupload`)
      if (!res.ok) return
      const json = await res.json() as { exists?: boolean }
      setFileMissing(json.exists === false)
    } catch {
      // 確認に失敗した場合はバナーを出さない（誤検知を避ける）
    }
  }, [id])

  // 書類取得後にファイル存在を確認
  useEffect(() => {
    if (doc?.dropbox_path) {
      checkFileExists()
    } else if (doc) {
      // Dropboxパスが無い書類はファイル欠損扱いにしない
      setFileMissing(false)
    }
  }, [doc, checkFileExists])

  // ファイルを選択 or ドロップして同じパスに再アップロード
  async function handleReupload(file: File) {
    if (!doc) return
    // クライアント側の簡易バリデーション
    const allowed = ["image/jpeg", "image/jpg", "image/png", "application/pdf"]
    if (file.type && !allowed.includes(file.type)) {
      toast.error("対応形式は JPG / PNG / PDF です")
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("ファイルサイズが大きすぎます（最大10MB）")
      return
    }

    setIsReuploading(true)
    try {
      const form = new FormData()
      form.append("file", file)
      const res = await fetch(`/api/documents/${id}/reupload`, {
        method: "POST",
        body: form,
      })
      const json = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) {
        throw new Error(json.error || "再アップロードに失敗しました")
      }
      toast.success("ファイルを再アップロードしました。AIで再解析します…")
      setFileMissing(false)
      // アップロード後は自動で再解析して金額・取引先などを更新
      await handleReanalyze()
      // 念のため存在を再確認
      checkFileExists()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "再アップロードに失敗しました")
    } finally {
      setIsReuploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  // 編集モード開始時にフォームを初期化
  function startEditing() {
    if (!doc) return
    setEditType(doc.type)
    setEditVendor(doc.vendor_name)
    setEditAmount(doc.amount !== null ? String(doc.amount) : "")
    setEditIssueDate(doc.issue_date ?? "")
    setEditDueDate(doc.due_date ?? "")
    setEditDescription(doc.description ?? "")
    setEditTaxCategory(doc.tax_category ?? "")
    setEditAccountTitle(doc.account_title ?? "")
    setIsEditing(true)
  }

  // 保存
  async function handleSave() {
    if (!doc) return
    setIsSaving(true)
    try {
      const body: Record<string, unknown> = {
        type: editType,
        vendor_name: editVendor,
        amount: editAmount ? Number(editAmount) : null,
        issue_date: editIssueDate || null,
        due_date: editDueDate || null,
        description: editDescription || null,
        tax_category: editTaxCategory,
        account_title: editAccountTitle,
      }

      const res = await fetch(`/api/documents?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(data.error ?? "保存に失敗しました")
      }

      const json = await res.json() as { data: Document }
      setDoc(json.data)
      setIsEditing(false)
      toast.success("書類情報を更新しました")
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存に失敗しました"
      toast.error(message)
    } finally {
      setIsSaving(false)
    }
  }

  // 再解析（この1件をDropboxから取得し直してAI再解析→結果を反映）
  // forceSingle=true のときは分割検出をせず従来どおり1件のまま更新する
  async function handleReanalyze(forceSingle = false) {
    if (!doc) return
    setIsReanalyzing(true)
    try {
      const res = await fetch(
        `/api/documents/${id}/reanalyze${forceSingle ? "?force_single=1" : ""}`,
        { method: "POST" }
      )
      const json = await res.json().catch(() => ({})) as {
        data?: Document
        error?: string
        reason?: string
        split_candidates?: SplitPayment[]
        total_amount?: number | null
      }
      if (!res.ok) {
        // ファイル欠損なら警告バナーを表示して再アップロードを促す
        if (res.status === 404 && json.reason === "file_not_found") {
          setFileMissing(true)
        }
        throw new Error(json.error || "再解析に失敗しました")
      }
      // 複数支払いの分割候補を検出 → 確認ダイアログを表示（DBはまだ更新されていない）
      if (json.split_candidates && json.split_candidates.length >= 2) {
        setSplitCandidates(json.split_candidates)
        setSplitTotalAmount(json.total_amount ?? doc.amount)
        return
      }
      if (json.data) {
        setDoc(json.data)
        // 編集中ならフォームにも反映
        if (isEditing) {
          setEditVendor(json.data.vendor_name)
          setEditAmount(json.data.amount !== null ? String(json.data.amount) : "")
          setEditIssueDate(json.data.issue_date ?? "")
          setEditDescription(json.data.description ?? "")
          setEditTaxCategory(json.data.tax_category ?? "")
          setEditAccountTitle(json.data.account_title ?? "")
        }
      }
      toast.success("再解析しました。抽出結果を反映しました")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "再解析に失敗しました")
    } finally {
      setIsReanalyzing(false)
    }
  }

  // 分割を確定: 元レコードを1件目に更新し、2件目以降を新規レコードとして追加する
  async function handleConfirmSplit(payments: SplitPayment[]) {
    if (!doc) return
    setIsSplitting(true)
    try {
      const res = await fetch(`/api/documents/${id}/split`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payments }),
      })
      const json = await res.json().catch(() => ({})) as { data?: Document[]; error?: string }
      if (!res.ok) {
        throw new Error(json.error || "分割に失敗しました")
      }
      toast.success(`${payments.length}件に分割しました（ファイルは1つのまま共有されます）`)
      setSplitCandidates(null)
      setSplitTotalAmount(null)
      // このページは1件目（元レコード）の詳細として再読み込み
      await fetchDocument()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "分割に失敗しました")
    } finally {
      setIsSplitting(false)
    }
  }

  // 削除
  async function handleDelete() {
    setIsDeleting(true)
    try {
      const res = await fetch(`/api/documents?id=${id}`, { method: "DELETE" })
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(data.error ?? "削除に失敗しました")
      }
      toast.success("書類を削除しました")
      router.push("/documents")
    } catch (error) {
      const message = error instanceof Error ? error.message : "削除に失敗しました"
      toast.error(message)
      setIsDeleting(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!doc) {
    return (
      <div className="space-y-4">
        <div className="text-center py-12 text-muted-foreground">書類が見つかりません</div>
        <div className="text-center">
          <Button variant="outline" asChild>
            <Link href="/documents">
              <ArrowLeft className="size-4" />
              一覧に戻る
            </Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/documents">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <h1 className="text-2xl font-bold">書類詳細</h1>
        </div>
        <div className="flex gap-2">
          {isEditing ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setIsEditing(false)} disabled={isSaving}>
                <X className="size-4" />
                キャンセル
              </Button>
              <Button size="sm" onClick={handleSave} disabled={isSaving}>
                <Save className="size-4" />
                {isSaving ? "保存中..." : "保存"}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleReanalyze()}
                disabled={isReanalyzing || !doc.dropbox_path}
                className="btn-float"
                title={doc.dropbox_path ? "DropboxのファイルをAIで再解析します" : "Dropboxパスがないため再解析できません"}
              >
                {isReanalyzing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                {isReanalyzing ? "再解析中..." : "再解析"}
              </Button>
              <Button variant="outline" size="sm" onClick={startEditing} className="btn-float">
                <Pencil className="size-4" />
                編集
              </Button>
              <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                <DialogTrigger asChild>
                  <Button variant="destructive" size="sm" className="btn-float-danger">
                    <Trash2 className="size-4" />
                    削除
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>書類を削除しますか？</DialogTitle>
                    <DialogDescription>
                      「{doc.vendor_name}」の{doc.type}を削除します。この操作は取り消せません。
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setDeleteDialogOpen(false)} disabled={isDeleting}>
                      キャンセル
                    </Button>
                    <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
                      {isDeleting ? "削除中..." : "削除する"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          )}
        </div>
      </div>

      {/* 再解析で複数支払いを検出したときの分割確認UI */}
      {splitCandidates && splitCandidates.length >= 2 && (
        <SplitPaymentsConfirm
          payments={splitCandidates}
          totalAmount={splitTotalAmount}
          isSubmitting={isSplitting || isReanalyzing}
          confirmLabel="分割して置き換える"
          singleLabel="分割せず1件のまま反映"
          onConfirmSplit={handleConfirmSplit}
          onRegisterAsOne={async () => {
            // 分割せず従来どおり1件のまま再解析結果を反映する
            setSplitCandidates(null)
            setSplitTotalAmount(null)
            await handleReanalyze(true)
          }}
        />
      )}

      {/* ファイル欠損時の警告バナー＋再アップロード導線 */}
      {fileMissing && (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setIsDragging(false)
            if (isReuploading) return
            const f = e.dataTransfer.files?.[0]
            if (f) handleReupload(f)
          }}
          className="rounded-xl border p-4 transition-colors"
          style={{
            borderColor: isDragging ? "var(--dusk-primary)" : "#E0B080",
            background: isDragging ? "var(--dusk-primary-light)" : "rgba(245, 230, 200, 0.55)",
          }}
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="size-5 shrink-0" style={{ color: "#A0703A" }} />
            <div className="flex-1 space-y-3">
              <div>
                <p className="font-semibold" style={{ color: "var(--dusk-text-main)" }}>
                  この書類のファイルがDropboxに見つかりません
                </p>
                <p className="text-sm" style={{ color: "var(--dusk-text-muted)" }}>
                  削除・移動された可能性があります。原本を再アップロードしてください（同じ保存先に上書きします）。
                  ここにファイルをドラッグ＆ドロップするか、ボタンから選択できます（PDF / JPG / PNG）。
                </p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) handleReupload(f)
                }}
              />
              <Button
                size="sm"
                className="btn-float-primary"
                disabled={isReuploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {isReuploading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Upload className="size-4" />
                )}
                {isReuploading ? "アップロード中..." : "ファイルを再アップロード"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 書類情報 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {doc.type}
            {/* 銀行振込が必要な請求書だけにマークを表示（ステータス管理は廃止） */}
            {doc.status === "要振込" && <StatusBadge status="要振込" />}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isEditing ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>種別</Label>
                <Select value={editType} onValueChange={setEditType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {typeOptions.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>取引先名</Label>
                <Input value={editVendor} onChange={(e) => setEditVendor(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>金額</Label>
                <Input type="number" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>発行日</Label>
                <Input type="date" value={editIssueDate} onChange={(e) => setEditIssueDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>支払期日</Label>
                <Input type="date" value={editDueDate} onChange={(e) => setEditDueDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>税区分</Label>
                <Select value={editTaxCategory} onValueChange={setEditTaxCategory}>
                  <SelectTrigger>
                    <SelectValue placeholder="税区分を選択" />
                  </SelectTrigger>
                  <SelectContent>
                    {TAX_CATEGORIES.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>勘定科目</Label>
                <Select value={editAccountTitle} onValueChange={setEditAccountTitle}>
                  <SelectTrigger>
                    <SelectValue placeholder="勘定科目を選択" />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_TITLES.map((a) => (
                      <SelectItem key={a} value={a}>{a}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>摘要</Label>
                <Input value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
              </div>
            </div>
          ) : (
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-muted-foreground">取引先名</dt>
                <dd className="font-medium">{doc.vendor_name}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">金額</dt>
                <dd className="font-medium">{formatAmount(doc.amount)}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">発行日</dt>
                <dd className="font-medium">{formatDate(doc.issue_date)}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">支払期日</dt>
                <dd className="font-medium">{formatDate(doc.due_date)}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">税区分</dt>
                <dd className="font-medium">{doc.tax_category || "-"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">勘定科目</dt>
                <dd className="font-medium">{doc.account_title || "-"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">摘要</dt>
                <dd className="font-medium">{doc.description ?? "-"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">入力経路</dt>
                <dd className="font-medium">{inputMethodLabel(doc.input_method)}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Dropboxパス</dt>
                <dd className="font-medium text-sm break-all">{doc.dropbox_path ?? "-"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">登録日時</dt>
                <dd className="font-medium">{new Date(doc.created_at).toLocaleString("ja-JP")}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
