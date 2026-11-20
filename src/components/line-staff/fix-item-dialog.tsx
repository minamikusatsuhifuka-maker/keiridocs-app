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
 * 確認待ちの明細の「内訳」「講座」「費用区分」を直す画面。
 *
 * スタッフが「その他」で申請した宿泊費のように、内訳が実態と違うと
 * 支給率も上限（交通費＋宿泊費 合計30,000円／講座）も正しく当たらない。
 *
 * 保存の前に、必ず変更後の支給額を確認できるようにする。
 * 支払年月日と立替額は変更しない（受講日と支払日は別のため）。
 */

export interface FixItemTarget {
  /** petty_cash_transactions.id */
  id: string
  staffName: string
  label: string
  amount: number
  date: string | null
  courseId?: string | null
  expenseItem?: string | null
}

interface CourseOption {
  id: string
  name: string
  kind: string
}

interface Preview {
  before: number
  after: number
  courseName: string | null
  holdReason: string | null
  excess: number
  rate: number
}

const yen = (v: number) => `¥${v.toLocaleString("ja-JP")}`

const HOLD_LABELS: Record<string, string> = {
  excess: "上限超過の確認待ちになります",
  history: "受講回数の確認待ちになります",
  undecided: "支給率が未定のため確認待ちになります",
  detail: "内訳の確認待ちのままです",
  course: "講座の確認待ちのままです",
}

export function FixItemDialog({
  target,
  onClose,
  onSaved,
}: {
  target: FixItemTarget | null
  onClose: () => void
  onSaved: () => void
}) {
  const [courses, setCourses] = useState<CourseOption[]>([])
  const [courseId, setCourseId] = useState("")
  const [expenseItem, setExpenseItem] = useState("")
  const [detailKey, setDetailKey] = useState("")
  const [preview, setPreview] = useState<Preview | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!target) return
    setCourseId(target.courseId ?? "")
    setExpenseItem(target.expenseItem ?? "")
    setDetailKey("")
    setPreview(null)
    ;(async () => {
      try {
        const res = await fetch("/api/courses")
        if (!res.ok) return
        const json = (await res.json()) as { courses?: CourseOption[] }
        setCourses(json.courses ?? [])
      } catch {
        // 取れなくても内訳だけは直せる
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

  // 内訳や講座を変えたら、確認し直してもらう（古い金額で保存しないため）
  useEffect(() => {
    setPreview(null)
  }, [courseId, expenseItem, detailKey])

  async function call(dryRun: boolean) {
    if (!target) return null
    const res = await fetch("/api/staff-reimburse/assign-course", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: target.id,
        courseId: courseId || undefined,
        expenseItem: expenseItem || undefined,
        detailKey: detailKey || undefined,
        dryRun,
      }),
    })
    const json = (await res.json().catch(() => ({}))) as Preview & { error?: string }
    if (!res.ok) throw new Error(json.error || "処理できませんでした")
    return json
  }

  async function check() {
    if (!expenseItem && !courseId) {
      toast.error("内訳または講座を選んでください")
      return
    }
    setChecking(true)
    try {
      const json = await call(true)
      if (json) setPreview(json)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "確認できませんでした")
    } finally {
      setChecking(false)
    }
  }

  async function save() {
    if (!preview) {
      toast.error("先に支給額を確認してください")
      return
    }
    setSaving(true)
    try {
      await call(false)
      toast.success("保存しました")
      onClose()
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存できませんでした")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>内訳・講座を直す</DialogTitle>
          <DialogDescription>
            {target?.staffName}さん／{target?.label}／{target && yen(target.amount)}
            <br />
            支払年月日（{target?.date || "未設定"}）と立替額は変更しません。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="space-y-1">
            <Label>講座</Label>
            <Select value={courseId} onValueChange={setCourseId}>
              <SelectTrigger>
                <SelectValue placeholder="登録済みの講座から選ぶ" />
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
            <Label>内訳</Label>
            <Select value={expenseItem} onValueChange={setExpenseItem}>
              <SelectTrigger>
                <SelectValue placeholder="選択してください" />
              </SelectTrigger>
              <SelectContent>
                {itemOptions.map((it) => (
                  <SelectItem key={it} value={it}>
                    {EXPENSE_ITEM_LABELS[it]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              交通費・宿泊費を選ぶと、講座ごとの合計30,000円の上限が適用されます。
            </p>
          </div>

          <div className="space-y-1">
            <Label>費用区分の表示（任意）</Label>
            <Select value={detailKey} onValueChange={setDetailKey}>
              <SelectTrigger>
                <SelectValue placeholder="変更しない" />
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

          <Button variant="outline" onClick={check} disabled={checking || saving}>
            {checking && <Loader2 className="size-4 animate-spin" />}
            支給額を確認する
          </Button>

          {preview && (
            <div className="rounded-lg border p-3">
              <p className="text-sm">
                いまの支給額 <strong>{yen(preview.before)}</strong> →{" "}
                <strong
                  className={
                    preview.after > preview.before
                      ? "text-emerald-700 dark:text-emerald-400"
                      : preview.after < preview.before
                        ? "text-red-700 dark:text-red-400"
                        : ""
                  }
                >
                  {yen(preview.after)}
                </strong>
              </p>
              <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
                {preview.courseName && <li>・講座：{preview.courseName}</li>}
                <li>・支給率：{Math.round(preview.rate * 100)}%</li>
                {preview.excess > 0 && <li>・上限を超えた分：{yen(preview.excess)}</li>}
                <li>
                  ・保存後：
                  {preview.holdReason
                    ? HOLD_LABELS[preview.holdReason] ?? "確認待ちになります"
                    : "確定します（給与返金待ちに入ります）"}
                </li>
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            キャンセル
          </Button>
          <Button onClick={save} disabled={saving || !preview}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            この内容で保存する
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
