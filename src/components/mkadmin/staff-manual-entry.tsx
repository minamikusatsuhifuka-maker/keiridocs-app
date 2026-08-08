"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Loader2, UserPlus, Upload, Sparkles, Pencil, Trash2, ClipboardList } from "lucide-react"
import { toast } from "sonner"
import {
  STAFF_EXPENSE_DETAILS,
  EXPENSE_GROUP_LABELS,
  getExpenseDetail,
  calcSubsidy,
  type ExpenseGroup,
} from "@/lib/subsidy"

/* ---------- 型 ---------- */
interface StaffMember {
  id: string
  name: string
  is_test?: boolean | null
  seminar_repeat_claimed_at?: string | null
}

interface ManualEntry {
  receiptId: string
  transactionId: string
  staffMemberId: string | null
  staffName: string
  isTest: boolean
  storeName: string
  amount: number
  paymentDate: string
  submitDate: string
  detailKey: string
  expenseDetail: string
  subsidyCategory: string
  note: string
  hasFile: boolean
}

/* ---------- ユーティリティ ---------- */
/** 今日（JST）の YYYY-MM-DD */
function todayJst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

/** 費用区分の第1階層グループ（ach は弁当代も含める＝手動登録では選択可） */
const GROUPS: ExpenseGroup[] = ["ach", "other"]
function detailsOfGroup(group: ExpenseGroup) {
  return STAFF_EXPENSE_DETAILS.filter((d) => d.group === group)
}

function yen(n: number): string {
  return `¥${n.toLocaleString("ja-JP")}`
}

/** ファイルを dataURL(base64) に変換 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export function StaffManualEntry() {
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [entries, setEntries] = useState<ManualEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [ocrLoading, setOcrLoading] = useState(false)

  /* フォーム状態 */
  const [staffMemberId, setStaffMemberId] = useState("")
  const [storeName, setStoreName] = useState("")
  const [amount, setAmount] = useState("")
  const [paymentDate, setPaymentDate] = useState(todayJst())
  const [group, setGroup] = useState<ExpenseGroup>("other")
  const [detailKey, setDetailKey] = useState("")
  const [submitDate, setSubmitDate] = useState(todayJst())
  const [note, setNote] = useState("")
  const [file, setFile] = useState<{ base64: string; mimeType: string; fileName: string } | null>(null)
  const [fileLabel, setFileLabel] = useState("")

  /* 重複確認ダイアログ */
  const [dupOpen, setDupOpen] = useState(false)
  const [dupMessage, setDupMessage] = useState("")

  /* 編集ダイアログ */
  const [editTarget, setEditTarget] = useState<ManualEntry | null>(null)
  const [editSaving, setEditSaving] = useState(false)

  const selectedStaff = useMemo(() => staff.find((s) => s.id === staffMemberId), [staff, staffMemberId])
  const seminarClaimed = !!selectedStaff?.seminar_repeat_claimed_at

  /* ---------- データ読み込み ---------- */
  const loadStaff = useCallback(async () => {
    try {
      const res = await fetch("/api/line-staff")
      const json = (await res.json()) as { data?: StaffMember[]; error?: string }
      if (!res.ok) throw new Error(json.error || "取得失敗")
      setStaff(json.data ?? [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "スタッフ一覧の取得に失敗しました")
    }
  }, [])

  const loadEntries = useCallback(async () => {
    try {
      const res = await fetch("/api/staff-refund/manual-entry")
      const json = (await res.json()) as { data?: ManualEntry[]; error?: string }
      if (!res.ok) throw new Error(json.error || "取得失敗")
      setEntries(json.data ?? [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "登録分の取得に失敗しました")
    }
  }, [])

  useEffect(() => {
    ;(async () => {
      setLoading(true)
      await Promise.all([loadStaff(), loadEntries()])
      setLoading(false)
    })()
  }, [loadStaff, loadEntries])

  /* 初回ATCがセミナー2回目登録済みで選ばれていたら区分をリセット */
  useEffect(() => {
    if (seminarClaimed && detailKey === "ach_first") setDetailKey("")
  }, [seminarClaimed, detailKey])

  /* グループ変更時は詳細区分をクリア */
  function handleGroupChange(g: ExpenseGroup) {
    setGroup(g)
    setDetailKey("")
  }

  /* ---------- ファイル選択 → OCRで初期値プリフィル ---------- */
  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    if (f.size > 10 * 1024 * 1024) {
      toast.error("ファイルサイズが10MBを超えています")
      return
    }
    const dataUrl = await fileToBase64(f)
    setFile({ base64: dataUrl, mimeType: f.type || "image/jpeg", fileName: f.name })
    setFileLabel(f.name)

    // Gemini解析で店名・金額・日付を初期値に入れる（手入力で修正可）
    setOcrLoading(true)
    try {
      const res = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base64: dataUrl, mimeType: f.type || "image/jpeg", fileName: f.name }),
      })
      const json = (await res.json()) as {
        data?: { vendor_name?: string | null; amount?: number | null; issue_date?: string | null }
        error?: string
      }
      if (res.ok && json.data) {
        if (json.data.vendor_name) setStoreName(json.data.vendor_name)
        if (typeof json.data.amount === "number") setAmount(String(json.data.amount))
        if (json.data.issue_date) setPaymentDate(json.data.issue_date.slice(0, 10))
        toast.success("AI解析で初期値を入力しました（修正できます）")
      } else if (!res.ok) {
        toast.error(json.error || "AI解析に失敗しました（手入力してください）")
      }
    } catch {
      toast.error("AI解析に失敗しました（手入力してください）")
    } finally {
      setOcrLoading(false)
    }
  }

  function clearFile() {
    setFile(null)
    setFileLabel("")
  }

  /* ---------- 支給額プレビュー ---------- */
  const detail = getExpenseDetail(detailKey)
  const amountNum = Number(amount)
  const preview =
    detail && Number.isFinite(amountNum) && amountNum > 0
      ? calcSubsidy(amountNum, detail.subsidyCategory)
      : null
  const isHalf = detail?.subsidyCategory === "achievement_repeat"

  /* ---------- 登録 ---------- */
  function resetForm() {
    setStoreName("")
    setAmount("")
    setPaymentDate(todayJst())
    setGroup("other")
    setDetailKey("")
    setSubmitDate(todayJst())
    setNote("")
    clearFile()
  }

  async function submit(force: boolean) {
    if (!staffMemberId) return toast.error("対象スタッフを選んでください")
    if (!detail) return toast.error("費用区分を選んでください")
    if (!Number.isFinite(amountNum) || amountNum <= 0) return toast.error("金額を正しく入力してください")
    if (!paymentDate) return toast.error("支払年月日を入力してください")

    setSubmitting(true)
    try {
      const res = await fetch("/api/staff-refund/manual-entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffMemberId,
          storeName,
          amount: amountNum,
          paymentDate,
          detailKey,
          submitDate,
          note,
          file: file ?? null,
          force,
        }),
      })
      const json = (await res.json()) as { ok?: boolean; error?: string; code?: string }
      if (res.status === 409 && json.code === "duplicate") {
        setDupMessage(json.error || "同じ内容の立替が既に登録されています。")
        setDupOpen(true)
        return
      }
      if (!res.ok) throw new Error(json.error || "登録に失敗しました")
      toast.success("立替を登録しました")
      setDupOpen(false)
      resetForm()
      await loadEntries()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "登録に失敗しました")
    } finally {
      setSubmitting(false)
    }
  }

  /* ---------- 削除 ---------- */
  async function handleDelete(entry: ManualEntry) {
    if (!window.confirm(`${entry.staffName}さんの立替（${entry.storeName || "不明"} / ${yen(entry.amount)}）を削除しますか？`))
      return
    try {
      const res = await fetch(`/api/staff-refund/manual-entry?receiptId=${encodeURIComponent(entry.receiptId)}`, {
        method: "DELETE",
      })
      const json = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok) throw new Error(json.error || "削除に失敗しました")
      toast.success("削除しました")
      await loadEntries()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除に失敗しました")
    }
  }

  /* ---------- 編集保存 ---------- */
  async function saveEdit() {
    if (!editTarget) return
    const a = Number(editTarget.amount)
    if (!Number.isFinite(a) || a <= 0) return toast.error("金額を正しく入力してください")
    if (!editTarget.paymentDate) return toast.error("支払年月日を入力してください")
    setEditSaving(true)
    try {
      const res = await fetch("/api/staff-refund/manual-entry", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          receiptId: editTarget.receiptId,
          storeName: editTarget.storeName,
          amount: a,
          paymentDate: editTarget.paymentDate,
          detailKey: editTarget.detailKey,
          submitDate: editTarget.submitDate,
          note: editTarget.note,
        }),
      })
      const json = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok) throw new Error(json.error || "編集に失敗しました")
      toast.success("更新しました")
      setEditTarget(null)
      await loadEntries()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "編集に失敗しました")
    } finally {
      setEditSaving(false)
    }
  }

  /* 編集ダイアログ内: 選択中スタッフのセミナー判定 */
  const editStaff = editTarget ? staff.find((s) => s.id === editTarget.staffMemberId) : undefined
  const editSeminarClaimed = !!editStaff?.seminar_repeat_claimed_at

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 登録フォーム */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <UserPlus className="size-5" />
            立替経費の手動登録
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            LINEを使わないケース（LINE未登録スタッフ・紙の領収書・LINE申請の失敗分など）の立替を登録します。
            LINE申請と同じ支給ルール（アチーブメント初回＝全額／セミナー2回目以降＝半額・弁当代は全額 等）で計算され、
            税理士提出リスト・立替明細CSV・立替まとめに反映されます。
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            {/* 対象スタッフ */}
            <div className="space-y-2">
              <Label>対象スタッフ *</Label>
              <Select value={staffMemberId} onValueChange={setStaffMemberId}>
                <SelectTrigger>
                  <SelectValue placeholder="スタッフを選択" />
                </SelectTrigger>
                <SelectContent>
                  {staff.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                      {s.is_test ? "（テスト）" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedStaff?.is_test && (
                <p className="text-xs text-amber-600">
                  テストスタッフです。保存先はテストフォルダ、集計・提出からは除外されます。
                </p>
              )}
            </div>

            {/* 領収書ファイル（任意） */}
            <div className="space-y-2">
              <Label>領収書ファイル（任意）</Label>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" asChild>
                  <label className="cursor-pointer">
                    <Upload className="mr-1 size-4" />
                    ファイルを選択
                    <input
                      type="file"
                      accept="image/*,application/pdf"
                      className="hidden"
                      onChange={handleFile}
                    />
                  </label>
                </Button>
                {ocrLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                {fileLabel && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {fileLabel}
                    <button type="button" className="text-red-500 underline" onClick={clearFile}>
                      解除
                    </button>
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                <Sparkles className="mr-0.5 inline size-3" />
                アップロードすると店名・金額・日付をAIが自動入力します（領収書なしの交通費等は空欄でOK）。
              </p>
            </div>

            {/* 支払先 */}
            <div className="space-y-2">
              <Label>支払先（店名）</Label>
              <Input value={storeName} onChange={(e) => setStoreName(e.target.value)} placeholder="例：〇〇書店" />
            </div>

            {/* 金額 */}
            <div className="space-y-2">
              <Label>金額 *</Label>
              <Input
                type="number"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="例：3000"
              />
            </div>

            {/* 支払年月日 */}
            <div className="space-y-2">
              <Label>支払年月日 *</Label>
              <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
              <p className="text-xs text-muted-foreground">領収書に記載の支払日（会計士CSVの集計基準）。</p>
            </div>

            {/* 提出日 */}
            <div className="space-y-2">
              <Label>提出日 *</Label>
              <Input type="date" value={submitDate} onChange={(e) => setSubmitDate(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                既定＝当日。税理士フォルダの20日締め月割りに使われます（過去分は変更可）。
              </p>
            </div>

            {/* 費用区分（2階層） */}
            <div className="space-y-2">
              <Label>費用区分（大分類） *</Label>
              <Select value={group} onValueChange={(v) => handleGroupChange(v as ExpenseGroup)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GROUPS.map((g) => (
                    <SelectItem key={g} value={g}>
                      {EXPENSE_GROUP_LABELS[g]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>費用区分（詳細） *</Label>
              <Select value={detailKey} onValueChange={setDetailKey}>
                <SelectTrigger>
                  <SelectValue placeholder="詳細区分を選択" />
                </SelectTrigger>
                <SelectContent>
                  {detailsOfGroup(group).map((d) => {
                    const disabled = d.key === "ach_first" && seminarClaimed
                    return (
                      <SelectItem key={d.key} value={d.key} disabled={disabled}>
                        {d.fullLabel}
                        {disabled ? "（セミナー2回目登録済のため不可）" : ""}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
              {group === "ach" && seminarClaimed && (
                <p className="text-xs text-amber-600">
                  このスタッフはセミナー2回目以降を登録済みのため「初回ATC」は選べません。
                </p>
              )}
            </div>

            {/* 摘要 */}
            <div className="space-y-2 sm:col-span-2">
              <Label>摘要（任意）</Label>
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="補足があれば入力" />
            </div>
          </div>

          {/* 支給額プレビュー */}
          {preview !== null && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              支給額プレビュー：<span className="font-bold">{yen(preview)}</span>{" "}
              <Badge variant={isHalf ? "destructive" : "secondary"}>{isHalf ? "半額" : "全額"}</Badge>
              <span className="ml-2 text-muted-foreground">給与支給</span>
            </div>
          )}

          <div className="flex justify-end">
            <Button className="btn-dusk-primary" onClick={() => submit(false)} disabled={submitting}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              立替を登録
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 登録済み一覧 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ClipboardList className="size-5" />
            手動登録した立替（{entries.length}件）
          </CardTitle>
        </CardHeader>
        <CardContent>
          {entries.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">まだ手動登録はありません。</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>スタッフ</TableHead>
                    <TableHead>支払先</TableHead>
                    <TableHead className="text-right">立替額</TableHead>
                    <TableHead className="text-right">支給額</TableHead>
                    <TableHead>区分</TableHead>
                    <TableHead>支払年月日</TableHead>
                    <TableHead>提出日</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((e) => {
                    const sub = calcSubsidy(e.amount, e.subsidyCategory)
                    const half = e.subsidyCategory === "achievement_repeat"
                    return (
                      <TableRow key={e.transactionId}>
                        <TableCell className="whitespace-nowrap">
                          {e.staffName}
                          {e.isTest && <Badge variant="outline" className="ml-1 text-[10px]">テスト</Badge>}
                        </TableCell>
                        <TableCell className="max-w-[160px] truncate">{e.storeName || "—"}</TableCell>
                        <TableCell className="text-right">{yen(e.amount)}</TableCell>
                        <TableCell className="text-right">
                          {yen(sub)}
                          {half && <Badge variant="destructive" className="ml-1 text-[10px]">半額</Badge>}
                        </TableCell>
                        <TableCell className="max-w-[140px] truncate text-xs">{e.expenseDetail || "—"}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">{e.paymentDate || "—"}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">{e.submitDate || "—"}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="icon" variant="ghost" onClick={() => setEditTarget({ ...e })}>
                              <Pencil className="size-4" />
                            </Button>
                            <Button size="icon" variant="ghost" onClick={() => handleDelete(e)}>
                              <Trash2 className="size-4 text-red-500" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 重複確認ダイアログ */}
      <Dialog open={dupOpen} onOpenChange={setDupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重複の可能性があります</DialogTitle>
            <DialogDescription>{dupMessage}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDupOpen(false)}>
              キャンセル
            </Button>
            <Button className="btn-dusk-primary" onClick={() => submit(true)} disabled={submitting}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              重複を承知で登録
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 編集ダイアログ */}
      <Dialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>立替を編集</DialogTitle>
            <DialogDescription>
              {editTarget?.staffName} さんの立替を修正します（支給額は自動で再計算されます）。
            </DialogDescription>
          </DialogHeader>
          {editTarget && (
            <div className="grid gap-3">
              <div className="space-y-1">
                <Label>支払先</Label>
                <Input
                  value={editTarget.storeName}
                  onChange={(ev) => setEditTarget({ ...editTarget, storeName: ev.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>金額</Label>
                  <Input
                    type="number"
                    value={editTarget.amount}
                    onChange={(ev) => setEditTarget({ ...editTarget, amount: Number(ev.target.value) })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>支払年月日</Label>
                  <Input
                    type="date"
                    value={editTarget.paymentDate}
                    onChange={(ev) => setEditTarget({ ...editTarget, paymentDate: ev.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>費用区分</Label>
                <Select
                  value={editTarget.detailKey}
                  onValueChange={(v) => setEditTarget({ ...editTarget, detailKey: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="区分を選択" />
                  </SelectTrigger>
                  <SelectContent>
                    {STAFF_EXPENSE_DETAILS.map((d) => {
                      const disabled = d.key === "ach_first" && editSeminarClaimed && editTarget.detailKey !== "ach_first"
                      return (
                        <SelectItem key={d.key} value={d.key} disabled={disabled}>
                          {EXPENSE_GROUP_LABELS[d.group]}／{d.fullLabel}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>提出日</Label>
                <Input
                  type="date"
                  value={editTarget.submitDate}
                  onChange={(ev) => setEditTarget({ ...editTarget, submitDate: ev.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>摘要</Label>
                <Textarea
                  rows={2}
                  value={editTarget.note}
                  onChange={(ev) => setEditTarget({ ...editTarget, note: ev.target.value })}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              キャンセル
            </Button>
            <Button className="btn-dusk-primary" onClick={saveEdit} disabled={editSaving}>
              {editSaving && <Loader2 className="mr-2 size-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
