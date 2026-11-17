"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
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
import { AlertTriangle, Loader2, Plus, Trash2 } from "lucide-react"
import {
  COURSE_KIND_LABELS,
  COURSE_RULE_LABELS,
  type CourseKind,
  type CourseRule,
} from "@/lib/subsidy-rules"

/**
 * 講座マスタの管理画面。
 *
 * スタッフはLINEで講座名を1タップ選ぶだけにしたい。
 * そのために担当がここで講座を登録し、区分（頂点への道／その他のアチーブメント講座／
 * アチーブメント以外）を紐づけておく。支給率と30,000円の上限は区分から自動で決まる。
 *
 * 講座を同じものとして束ねる台帳がないと、上限（交通費＋宿泊費 合計30,000円／講座）の
 * 合算ができず過大支給になるため、このマスタが支給の正しさを支えている。
 */

interface Course {
  id: string
  name: string
  kind: string
  kindLabel: string
  /** 支給率の方式（full / atc / undecided） */
  rule: string
  is_active: boolean
  note: string | null
  created_at: string
  /** この講座で申請された件数（0件なら削除できる） */
  useCount: number
}

/** 分類ごとの説明（どの講座をここに入れるか） */
const KIND_SUMMARY: Record<CourseKind, string> = {
  apex: "アチーブメントテクノロジーコースは「ATC方式」、ダイナミックコース／ダイナミックアドバンスコース／ピークパフォーマンスコースは「常に半額」を選びます。弁当代とアカデミー会費を申請できます",
  ach_other: "頂点への道以外のアチーブメント講座。弁当代を申請できます",
  jpsa: "JPSAの講座。弁当代とアカデミー会費は対象外です",
  exam: "検定・試験。弁当代とアカデミー会費は対象外です",
  non_ach: "アチーブメント以外のセミナー・研修。弁当代とアカデミー会費は対象外です",
}

/** 支給率の方式ごとの説明（担当が選ぶときの判断材料） */
const RULE_SUMMARY: Record<CourseRule, string> = {
  full: "受講料は常に全額。交通費＋宿泊費は合計30,000円まで（超えた分は要対応で承認）",
  half: "受講料・交通費・宿泊費がいつでも半額。弁当代とアカデミー会費は全額。ダイナミックコース／ダイナミックアドバンスコース／ピークパフォーマンスコースがこれです",
  atc: "受講料は初回が全額、再受講1〜6回目は半額。7回目以降は規程が未定のため担当の判断待ちになります。交通費・宿泊費も半額の回は半額",
  undecided:
    "支給率が決まっていない講座に使います。申請は受け付けますが自動では確定せず、すべて要対応に上がって担当が金額を決めます",
}

export function CourseMaster({ showHeader = true }: { showHeader?: boolean }) {
  const [courses, setCourses] = useState<Course[]>([])
  const [loading, setLoading] = useState(true)
  const [notReady, setNotReady] = useState<string | null>(null)
  const [showInactive, setShowInactive] = useState(false)

  // 追加フォーム
  const [newName, setNewName] = useState("")
  const [newKind, setNewKind] = useState<CourseKind>("apex")
  const [newRule, setNewRule] = useState<CourseRule>("undecided")
  const [adding, setAdding] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  /** 講座名を編集中の行 */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState("")

  const fetchCourses = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/courses?all=1`)
      const json = (await res.json().catch(() => ({}))) as { courses?: Course[]; error?: string }
      if (res.status === 409) {
        setNotReady(json.error ?? "DB更新が必要です")
        setCourses([])
        return
      }
      if (!res.ok) throw new Error(json.error || "講座マスタを取得できませんでした")
      setNotReady(null)
      setCourses(json.courses ?? [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "講座マスタを取得できませんでした")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCourses()
  }, [fetchCourses])

  async function handleAdd() {
    if (!newName.trim()) {
      toast.error("講座名を入力してください")
      return
    }
    setAdding(true)
    try {
      const res = await fetch("/api/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), kind: newKind, rule: newRule }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || "追加に失敗しました")
      toast.success(`「${newName.trim()}」を追加しました`)
      setNewName("")
      fetchCourses()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "追加に失敗しました")
    } finally {
      setAdding(false)
    }
  }

  /** 講座名を変更する（同じ名前が2つあると上限の判定が分かれるためAPI側で弾く） */
  async function saveName(course: { id: string; name: string }) {
    const name = editingName.trim()
    if (!name || name === course.name) {
      setEditingId(null)
      return
    }
    await handlePatch(course as never, { name })
    setEditingId(null)
  }

  async function handlePatch(course: Course, patch: Record<string, unknown>) {
    setBusyId(course.id)
    try {
      const res = await fetch("/api/courses", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: course.id, ...patch }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || "更新に失敗しました")
      fetchCourses()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "更新に失敗しました")
    } finally {
      setBusyId(null)
    }
  }

  async function handleDelete(course: Course) {
    if (
      !confirm(
        `「${course.name}」を削除しますか？\n\n` +
          `削除は登録ミスを消すためのものです。\n` +
          `終了した講座は「選択肢に出す」をOFFにしてください（過去の申請が残ります）。`
      )
    )
      return
    setBusyId(course.id)
    try {
      const res = await fetch(`/api/courses?id=${encodeURIComponent(course.id)}`, { method: "DELETE" })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || "削除に失敗しました")
      toast.success("削除しました")
      fetchCourses()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除に失敗しました")
    } finally {
      setBusyId(null)
    }
  }

  const visible = showInactive ? courses : courses.filter((c) => c.is_active)
  const inactiveCount = courses.length - courses.filter((c) => c.is_active).length

  return (
    <div className="flex flex-col gap-4">
      {showHeader && (
        <div>
          <h1 className="text-xl font-bold">講座マスタ</h1>
          <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
            スタッフが申請時に選ぶ講座の一覧
          </p>
        </div>
      )}

      {notReady && (
        <Card className="border-amber-500/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4 text-amber-600" />
              DB更新が必要です
            </CardTitle>
            <CardDescription>{notReady}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* 追加 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">講座を追加</CardTitle>
          <CardDescription>
            新しい講座が出てきたら1行追加してください。スタッフはこの名前を選ぶだけで、
            支給率と上限（交通費＋宿泊費 合計30,000円）は区分から自動で決まります。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-[240px] flex-1 flex-col gap-1.5">
              <Label htmlFor="course-name">講座名</Label>
              <Input
                id="course-name"
                placeholder="例：頂点への道 2026年11月期"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="flex min-w-[240px] flex-col gap-1.5">
              <Label htmlFor="course-kind">区分</Label>
              <Select value={newKind} onValueChange={(v) => setNewKind(v as CourseKind)}>
                <SelectTrigger id="course-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(COURSE_KIND_LABELS) as CourseKind[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {COURSE_KIND_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-w-[300px] flex-col gap-1.5">
              <Label htmlFor="course-rule">支給率の方式</Label>
              <Select value={newRule} onValueChange={(v) => setNewRule(v as CourseRule)}>
                <SelectTrigger id="course-rule">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(COURSE_RULE_LABELS) as CourseRule[]).map((r) => (
                    <SelectItem key={r} value={r}>
                      {COURSE_RULE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleAdd} disabled={adding || !!notReady}>
              {adding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              追加
            </Button>
          </div>
          <p className="mt-2.5 text-xs leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
            <strong>分類：</strong>
            {KIND_SUMMARY[newKind]}
          </p>
          <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
            <strong>支給率：</strong>
            {RULE_SUMMARY[newRule]}
          </p>
          <p className="mt-1.5 text-xs leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
            期ごとに分けて登録してください（30,000円の上限は講座1件ごとに判定します）。
          </p>
        </CardContent>
      </Card>

      {/* 一覧 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            登録済みの講座
            <Badge variant="outline">{courses.filter((c) => c.is_active).length} 件</Badge>
          </CardTitle>
          <CardDescription>
            終了した講座は「選択肢に出す」をOFFにしてください。スタッフの選択肢から消えますが、
            過去の申請と上限の合算はそのまま残ります。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {inactiveCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="mb-3"
              onClick={() => setShowInactive((v) => !v)}
            >
              {showInactive ? `終了した講座を隠す（${inactiveCount}件）` : `終了した講座も表示（${inactiveCount}件）`}
            </Button>
          )}

          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm" style={{ color: "var(--muted-foreground)" }}>
              <Loader2 className="size-4 animate-spin" />
              読み込み中…
            </div>
          ) : visible.length === 0 ? (
            <p className="py-6 text-sm" style={{ color: "var(--muted-foreground)" }}>
              まだ講座が登録されていません。上のフォームから追加してください。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap">講座名</TableHead>
                    <TableHead className="whitespace-nowrap">分類</TableHead>
                    <TableHead className="whitespace-nowrap">支給率</TableHead>
                    <TableHead className="whitespace-nowrap">申請</TableHead>
                    <TableHead className="whitespace-nowrap">選択肢に出す</TableHead>
                    <TableHead className="whitespace-nowrap text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((c) => (
                    <TableRow key={c.id} style={{ opacity: c.is_active ? 1 : 0.6 }}>
                      {/* 講座名は申請の集計単位。誤字などを直せるようにここで編集する */}
                      <TableCell className="font-medium">
                        {editingId === c.id ? (
                          <div className="flex items-center gap-1.5">
                            <Input
                              className="w-64"
                              value={editingName}
                              autoFocus
                              onChange={(e) => setEditingName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveName(c)
                                if (e.key === "Escape") setEditingId(null)
                              }}
                            />
                            <Button
                              size="sm"
                              disabled={busyId === c.id || !editingName.trim()}
                              onClick={() => saveName(c)}
                            >
                              保存
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                              やめる
                            </Button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="text-left underline decoration-dotted underline-offset-4"
                            title="クリックすると名前を変更できます"
                            onClick={() => {
                              setEditingId(c.id)
                              setEditingName(c.name)
                            }}
                          >
                            {c.name}
                          </button>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Select
                          value={c.kind}
                          onValueChange={(v) => handlePatch(c, { kind: v })}
                          disabled={busyId === c.id}
                        >
                          <SelectTrigger className="w-[260px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(Object.keys(COURSE_KIND_LABELS) as CourseKind[]).map((k) => (
                              <SelectItem key={k} value={k}>
                                {COURSE_KIND_LABELS[k]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Select
                          value={c.rule}
                          onValueChange={(v) => handlePatch(c, { rule: v })}
                          disabled={busyId === c.id}
                        >
                          <SelectTrigger className="w-[300px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(Object.keys(COURSE_RULE_LABELS) as CourseRule[]).map((r) => (
                              <SelectItem key={r} value={r}>
                                {COURSE_RULE_LABELS[r]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {c.rule === "undecided" && (
                          <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">
                            申請は要対応に上がります
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {c.useCount > 0 ? `${c.useCount}件` : "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={c.is_active}
                            onCheckedChange={(checked) => handlePatch(c, { is_active: checked })}
                            disabled={busyId === c.id}
                            aria-label="選択肢に出すかの切り替え"
                          />
                          <span className="text-sm">{c.is_active ? "出す" : "終了"}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(c)}
                          disabled={busyId === c.id || c.useCount > 0}
                          title={
                            c.useCount > 0
                              ? "申請が紐づいているため削除できません。「選択肢に出す」をOFFにしてください"
                              : "削除"
                          }
                        >
                          {busyId === c.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Trash2 className="size-4" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
