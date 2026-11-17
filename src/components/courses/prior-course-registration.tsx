"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { AlertTriangle, Check, Loader2 } from "lucide-react"
import {
  academyStartDate,
  hasSeparateLegalName,
  parseLineProfile,
  payrollName,
} from "@/lib/line-staff-profile"
import { COURSE_RULE_LABELS, academyTermEnd, type CourseRule } from "@/lib/subsidy-rules"

/**
 * 既受講の登録（アプリ導入前・旧LINEでの受講回数）。
 *
 * ATC方式は「これまでに何回受講したか」で支給率が変わる。
 * アプリ導入前の受講や旧LINEからの申請は講座の情報を持たないため自動では数えられず、
 * 登録しないと既受講者が「初受講＝全額支給」と判定されて過大支給になる。
 *
 * 未登録のままATCの受講料が申請されると「要対応」に上がるので、
 * 入力を忘れても過大支給にはならない。ただし河村さんの確認作業が増えるため、
 * 本番公開の前にここで登録しておく。
 *
 * 回数は「アプリ導入前に受講した回数」。初受講だけ済んでいるなら 1 を入れる。
 */

interface CourseOption {
  id: string
  name: string
  kind: string
  kindLabel: string
  rule: string
}

interface StaffRow {
  id: string
  name: string
  /** 給与・行政上の氏名（旧姓で勤務している場合のみ入る） */
  legal_name?: string | null
  is_test?: boolean
  retired_at?: string | null
  line_profile?: unknown
}

export function PriorCourseRegistration() {
  const [courses, setCourses] = useState<CourseOption[]>([])
  const [staff, setStaff] = useState<StaffRow[]>([])
  const [courseId, setCourseId] = useState("")
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)
  /** 入力中の値（スタッフID → 文字列） */
  const [draft, setDraft] = useState<Record<string, string>>({})
  /** アカデミー会員のサービス開始日の入力中の値 */
  const [academyDraft, setAcademyDraft] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [cRes, sRes] = await Promise.all([fetch("/api/courses?all=1"), fetch("/api/line-staff")])
      const cJson = (await cRes.json().catch(() => ({}))) as { courses?: CourseOption[] }
      const sJson = (await sRes.json().catch(() => ({}))) as { data?: StaffRow[] }
      const courseList = cJson.courses ?? []
      setCourses(courseList)
      setStaff(sJson.data ?? [])
      // 回数が意味を持つのはATC方式だけなので、既定でそれを選ぶ
      setCourseId((prev) => prev || courseList.find((c) => c.rule === "atc")?.id || "")
    } catch {
      toast.error("講座とスタッフを取得できませんでした")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const selectedCourse = useMemo(() => courses.find((c) => c.id === courseId) ?? null, [courses, courseId])

  /** 在籍中かつテストでないスタッフ（登録が必要なのはこの人たち） */
  const targets = useMemo(
    () => staff.filter((m) => !m.retired_at && !m.is_test),
    [staff]
  )

  /** そのスタッフの登録済み回数（未登録は null） */
  function registeredCount(member: StaffRow): number | null {
    if (!courseId) return null
    const entry = (parseLineProfile(member.line_profile).prior_courses ?? []).find(
      (p) => p.course_id === courseId
    )
    return entry ? entry.count : null
  }

  async function save(member: StaffRow, count: number | null) {
    if (!courseId) return
    setSavingId(member.id)
    try {
      const res = await fetch("/api/line-staff", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: member.id, priorCourse: { courseId, count } }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || "登録に失敗しました")
      toast.success(
        count === null
          ? `${member.name}さんの登録を取り消しました`
          : `${member.name}さんの受講済み回数を ${count} 回で登録しました`
      )
      setDraft((d) => {
        const next = { ...d }
        delete next[member.id]
        return next
      })
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "登録に失敗しました")
    } finally {
      setSavingId(null)
    }
  }

  /**
   * アカデミー会員のサービス開始日を保存する。
   *
   * 本人はLINEで1回登録するだけで変更できないため、間違いの修正はここで行う。
   */
  async function saveAcademy(member: StaffRow, date: string | null) {
    setSavingId(member.id)
    try {
      const res = await fetch("/api/line-staff", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: member.id, academyStart: date }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || "保存に失敗しました")
      toast.success(
        date
          ? `${member.name}さんのサービス開始日を ${date} にしました`
          : `${member.name}さんの登録を取り消しました`
      )
      setAcademyDraft((d) => {
        const next = { ...d }
        delete next[member.id]
        return next
      })
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存に失敗しました")
    } finally {
      setSavingId(null)
    }
  }

  const unregistered = targets.filter((m) => registeredCount(m) === null).length

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          既受講の登録
          {courseId && unregistered > 0 && (
            <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
              未登録 {unregistered} 名
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          アプリを使う前に受講した回数を登録します。登録しないと既受講の方が
          「初受講＝全額支給」と判定され、過大支給になります。
          <br />
          回数は<strong>アプリ導入前に受講した回数</strong>です。初受講だけ済んでいる方は <strong>1</strong> を入れてください。
          <br />
          ここに並ぶのは<strong>上の「スタッフ一覧」と同じ在籍スタッフ</strong>です（別の名簿ではありません）。
          氏名を直すときは「スタッフ一覧」の「編集」から行ってください。
          受講回数を1回以上登録すると、そのスタッフのLINEから「初回ATC＋アカデミー会員費」が自動で消えます。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="flex min-w-[320px] flex-col gap-1.5">
            <Label htmlFor="prior-course">講座</Label>
            <Select value={courseId} onValueChange={setCourseId}>
              <SelectTrigger id="prior-course">
                <SelectValue placeholder="講座を選択" />
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
        </div>

        {!courseId ? (
          <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
            講座マスタに講座を登録すると、ここで既受講回数を入力できます。
          </p>
        ) : selectedCourse && selectedCourse.rule !== "atc" ? (
          <p className="flex items-start gap-2 text-sm" style={{ color: "var(--muted-foreground)" }}>
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <span>
              この講座の支給率は「{COURSE_RULE_LABELS[selectedCourse.rule as CourseRule]}」で、
              受講回数によって支給額が変わりません。登録は不要です。
              <br />
              回数の登録が必要なのは「ATC方式」の講座だけです。
            </span>
          </p>
        ) : loading ? (
          <div className="flex items-center gap-2 py-4 text-sm" style={{ color: "var(--muted-foreground)" }}>
            <Loader2 className="size-4 animate-spin" />
            読み込み中…
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">スタッフ</TableHead>
                  <TableHead className="whitespace-nowrap">受講済み回数</TableHead>
                  <TableHead className="whitespace-nowrap">アカデミー会員</TableHead>
                  <TableHead className="whitespace-nowrap">次回の申請</TableHead>
                  <TableHead className="whitespace-nowrap text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {targets.map((m) => {
                  const saved = registeredCount(m)
                  const value = draft[m.id] ?? (saved === null ? "" : String(saved))
                  const parsed = value === "" ? null : Number(value)
                  const next = saved === null ? null : saved === 0 ? "初受講（全額）" : `再受講${saved}回目（半額）`
                  return (
                    <TableRow key={m.id}>
                      {/* 氏名の表示はスタッフ一覧と揃える（別の名簿に見えて混乱しないように） */}
                      <TableCell className="whitespace-nowrap font-medium">
                        <div className="flex flex-col gap-0.5">
                          <span>{m.name}</span>
                          {hasSeparateLegalName(m) && (
                            <span className="flex items-center gap-1.5">
                              <Badge
                                variant="outline"
                                className="border-violet-500 text-[10px] text-violet-700 dark:text-violet-300"
                              >
                                院内は旧姓
                              </Badge>
                              <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                                給与・手続き：{payrollName(m)}
                              </span>
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            min={0}
                            max={99}
                            className="w-24"
                            placeholder="未登録"
                            value={value}
                            onChange={(e) => setDraft((d) => ({ ...d, [m.id]: e.target.value }))}
                          />
                          <span className="text-sm">回</span>
                          {saved !== null && (
                            <span className="inline-flex items-center gap-1 text-xs text-green-600">
                              <Check className="size-3.5" />
                              登録済み
                            </span>
                          )}
                        </div>
                      </TableCell>
                      {/* アカデミー会員の期間（本人がLINEの「設定」から登録する）。
                          未登録・期限切れの受講料申請は自動で支給せず要対応に上げる */}
                      <TableCell className="whitespace-nowrap text-sm">
                        {(() => {
                          const start = academyStartDate(m.line_profile)
                          const end = academyTermEnd(start)
                          const expired = !!end && end < new Date().toISOString().slice(0, 10)
                          const value = academyDraft[m.id] ?? start ?? ""
                          return (
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-1.5">
                                <Input
                                  type="date"
                                  className="w-40"
                                  value={value}
                                  onChange={(e) =>
                                    setAcademyDraft((d) => ({ ...d, [m.id]: e.target.value }))
                                  }
                                />
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={savingId === m.id || value === (start ?? "")}
                                  onClick={() => saveAcademy(m, value || null)}
                                >
                                  保存
                                </Button>
                              </div>
                              {start ? (
                                <span
                                  className={`text-xs ${expired ? "text-amber-700 dark:text-amber-400" : ""}`}
                                  style={expired ? undefined : { color: "var(--muted-foreground)" }}
                                >
                                  期限 {end ?? "?"}
                                  {expired && "（期限切れ）"}
                                </span>
                              ) : (
                                <span className="text-xs text-amber-700 dark:text-amber-400">
                                  未登録（本人がLINEの「設定」から登録できます）
                                </span>
                              )}
                            </div>
                          )
                        })()}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {next ?? (
                          <span className="text-amber-700 dark:text-amber-400">
                            未登録（申請は要対応に上がります）
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            disabled={savingId === m.id || parsed === null || Number.isNaN(parsed)}
                            onClick={() => save(m, parsed)}
                          >
                            {savingId === m.id ? <Loader2 className="size-3.5 animate-spin" /> : "保存"}
                          </Button>
                          {saved !== null && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={savingId === m.id}
                              onClick={() => save(m, null)}
                            >
                              取り消す
                            </Button>
                          )}
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
  )
}
