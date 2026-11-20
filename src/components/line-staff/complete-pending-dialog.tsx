"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2 } from "lucide-react"
import { STAFF_EXPENSE_DETAILS } from "@/lib/subsidy"
import { EXPENSE_ITEM_LABELS, availableItems } from "@/lib/subsidy-rules"
import type { CourseKind, ExpenseItem } from "@/lib/subsidy-rules"

/**
 * 未完了の申請を、担当が代わりに完了させるダイアログ。
 *
 * スタッフが区分を選ばずに離脱すると明細が作られず給与に入らない。
 * これまでは本人が最後まで進めるしかなく、締め日に本人の操作を待っていた。
 *
 * 本人の申請をそのまま使って明細を作るため、写真も申請日も変わらず、
 * 本人のLINEの「申請履歴」でも同じ1件が「登録済み」に変わる。
 */

export interface CompleteTarget {
  /** staff_receipts.id */
  id: string
  staffName: string
  amount: number
  storeName: string | null
  /** 領収書の日付（YYYY-MM-DD） */
  date: string | null
}

interface CourseOption {
  id: string
  name: string
  kind: string
  kindLabel?: string
}

export function CompletePendingDialog({
  target,
  onClose,
  onDone,
}: {
  target: CompleteTarget | null
  onClose: () => void
  onDone: () => void
}) {
  const [detailKey, setDetailKey] = useState("")
  const [amount, setAmount] = useState("")
  const [storeName, setStoreName] = useState("")
  const [paymentDate, setPaymentDate] = useState("")
  const [courseId, setCourseId] = useState("")
  const [expenseItem, setExpenseItem] = useState("")
  const [courses, setCourses] = useState<CourseOption[]>([])
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (!target) return
    setDetailKey("")
    setCourseId("")
    setExpenseItem("")
    setAmount(target.amount > 0 ? String(target.amount) : "")
    setStoreName(target.storeName ?? "")
    setPaymentDate(target.date ?? "")
  }, [target])

  useEffect(() => {
    if (!target) return
    ;(async () => {
      try {
        const res = await fetch("/api/courses")
        if (!res.ok) return
        const json = (await res.json()) as { courses?: CourseOption[]; items?: CourseOption[] }
        setCourses(json.courses ?? json.items ?? [])
      } catch {
        // 講座が取れなくても区分だけで登録できる
      }
    })()
  }, [target])

  const selectedCourse = useMemo(
    () => courses.find((c) => c.id === courseId) ?? null,
    [courses, courseId]
  )
  const itemOptions = useMemo<ExpenseItem[]>(() => {
    if (selectedCourse) return availableItems(selectedCourse.kind as CourseKind)
    return ["books", "medical", "exam", "commute", "other"]
  }, [selectedCourse])

  async function save() {
    if (!target) return
    const amountNum = Number(amount)
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      toast.error("立替額を正しく入力してください")
      return
    }
    if (!detailKey) {
      toast.error("費用区分を選択してください")
      return
    }
    if (courseId && !expenseItem) {
      toast.error("講座を選んだ場合は内訳も選んでください")
      return
    }
    setIsSaving(true)
    try {
      const res = await fetch("/api/staff-reimburse/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          receiptId: target.id,
          detailKey,
          amount: amountNum,
          storeName,
          paymentDate: paymentDate || undefined,
          courseId: courseId || undefined,
          expenseItem: expenseItem || undefined,
        }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string; amount?: number | null }
      if (!res.ok) throw new Error(json.error || "登録できませんでした")
      toast.success(
        typeof json.amount === "number"
          ? `登録しました（支給額 ¥${json.amount.toLocaleString("ja-JP")}）`
          : "登録しました"
      )
      onClose()
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "登録できませんでした")
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>担当が代わりに登録する</DialogTitle>
          <DialogDescription>
            {target?.staffName}さんの申請です。本人が送った写真と申請日はそのまま残り、
            本人のLINEの「申請履歴」でも「登録済み」に変わります。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="space-y-1">
            <Label htmlFor="cp-store">支払先（店名）</Label>
            <Input
              id="cp-store"
              value={storeName}
              onChange={(e) => setStoreName(e.target.value)}
              placeholder="読み取れていない場合は入力してください"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="cp-amount">立替額</Label>
              <Input
                id="cp-amount"
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cp-date">支払年月日</Label>
              <Input
                id="cp-date"
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label>費用区分 *</Label>
            <Select value={detailKey} onValueChange={setDetailKey}>
              <SelectTrigger>
                <SelectValue placeholder="選択してください" />
              </SelectTrigger>
              <SelectContent>
                {STAFF_EXPENSE_DETAILS.map((d) => (
                  <SelectItem key={d.key} value={d.key}>
                    {d.fullLabel}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>講座（交通費・宿泊費のときは選ぶ）</Label>
              <Select value={courseId} onValueChange={setCourseId}>
                <SelectTrigger>
                  <SelectValue placeholder="任意" />
                </SelectTrigger>
                <SelectContent>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>内訳{courseId ? " *" : ""}</Label>
              <Select value={expenseItem} onValueChange={setExpenseItem}>
                <SelectTrigger>
                  <SelectValue placeholder="任意" />
                </SelectTrigger>
                <SelectContent>
                  {itemOptions.map((it) => (
                    <SelectItem key={it} value={it}>
                      {EXPENSE_ITEM_LABELS[it]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            講座と内訳を選ぶと、上限（交通費＋宿泊費 合計30,000円／書籍代・診療費 月5,000円）と
            支給率が自動で適用されます。
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            キャンセル
          </Button>
          <Button onClick={save} disabled={isSaving}>
            {isSaving && <Loader2 className="size-4 animate-spin" />}
            この内容で登録する
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
