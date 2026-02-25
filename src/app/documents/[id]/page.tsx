"use client"

import { useCallback, useEffect, useState } from "react"
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
import { ArrowLeft, Loader2, Pencil, Trash2, Save, X } from "lucide-react"
import type { Database } from "@/types/database"
import type { DocumentStatus } from "@/types"
import { toast } from "sonner"

type Document = Database["public"]["Tables"]["documents"]["Row"]

const statuses: DocumentStatus[] = ["未処理", "処理済み", "アーカイブ"]

const typeOptions = ["請求書", "領収書", "契約書"]

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
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  // 編集フォーム
  const [editType, setEditType] = useState("")
  const [editVendor, setEditVendor] = useState("")
  const [editAmount, setEditAmount] = useState("")
  const [editIssueDate, setEditIssueDate] = useState("")
  const [editDueDate, setEditDueDate] = useState("")
  const [editDescription, setEditDescription] = useState("")
  const [editStatus, setEditStatus] = useState<DocumentStatus>("未処理")

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

  // 編集モード開始時にフォームを初期化
  function startEditing() {
    if (!doc) return
    setEditType(doc.type)
    setEditVendor(doc.vendor_name)
    setEditAmount(doc.amount !== null ? String(doc.amount) : "")
    setEditIssueDate(doc.issue_date ?? "")
    setEditDueDate(doc.due_date ?? "")
    setEditDescription(doc.description ?? "")
    setEditStatus(doc.status as DocumentStatus)
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
        status: editStatus,
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
              <Button variant="outline" size="sm" onClick={startEditing}>
                <Pencil className="size-4" />
                編集
              </Button>
              <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                <DialogTrigger asChild>
                  <Button variant="destructive" size="sm">
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

      {/* 書類情報 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {doc.type}
            <StatusBadge status={doc.status as DocumentStatus} />
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
                <Label>ステータス</Label>
                <Select value={editStatus} onValueChange={(v) => setEditStatus(v as DocumentStatus)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {statuses.map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>発行日</Label>
                <Input type="date" value={editIssueDate} onChange={(e) => setEditIssueDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>支払期日</Label>
                <Input type="date" value={editDueDate} onChange={(e) => setEditDueDate(e.target.value)} />
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
