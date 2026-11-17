"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2, RotateCcw } from "lucide-react"
import { parseLineProfile, payrollName, hasSeparateLegalName } from "@/lib/line-staff-profile"
import { TRAVEL_CAP_PER_COURSE } from "@/lib/subsidy-rules"

/**
 * 交通費・宿泊費の枠（講座ごと 30,000円）の数え直し。
 *
 * ■ なぜ必要か
 * 枠は「講座ごと」に合計30,000円だが、講座マスタは同じ講座名を
 * 再受講でも使い回すため、1回目の受講で枠を使い切ると
 * 2回目以降の交通費が全額「上限超過・支給額0円」になってしまう。
 *
 * ■ 使うとき
 * スタッフが同じ講座を**次の回として受講する**とき、その人の枠を数え直す。
 * 押した日時より後の申請だけを枠に数えるようになる。
 *
 * ■ 確定済みの支給額は変わらない
 * 過去の明細は書き換えない。これまでに確定した支給額・会計士提出の内容は
 * そのまま残る（枠の数え方が次の申請から変わるだけ）。
 */

interface CourseOption {
  id: string
  name: string
}

interface StaffRow {
  id: string
  name: string
  legal_name?: string | null
  is_test?: boolean
  retired_at?: string | null
  line_profile?: unknown
}

export function TravelCapPanel() {
  const [courses, setCourses] = useState<CourseOption[]>([])
  const [staff, setStaff] = useState<StaffRow[]>([])
  const [courseId, setCourseId] = useState("")
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [cRes, sRes] = await Promise.all([fetch("/api/courses?all=1"), fetch("/api/line-staff")])
      const cJson = (await cRes.json().catch(() => ({}))) as { courses?: CourseOption[] }
      const sJson = (await sRes.json().catch(() => ({}))) as { data?: StaffRow[] }
      const list = cJson.courses ?? []
      setCourses(list)
      setStaff(sJson.data ?? [])
      setCourseId((prev) => prev || list[0]?.id || "")
    } catch {
      toast.error("講座とスタッフを取得できませんでした")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /** 在籍中かつテストでないスタッフ（テスト申請は枠を消費しないため対象外） */
  const targets = useMemo(() => staff.filter((m) => !m.retired_at && !m.is_test), [staff])

  /** その講座で最後に数え直した記録（いちばん新しい1件） */
  function latestReset(member: StaffRow) {
    if (!courseId) return null
    const hits = (parseLineProfile(member.line_profile).travel_cap_resets ?? [])
      .filter((r) => r?.course_id === courseId && r?.at)
      .sort((a, b) => a.at.localeCompare(b.at))
    return hits.length > 0 ? hits[hits.length - 1] : null
  }

  async function reset(member: StaffRow, undo: boolean) {
    if (!courseId) return
    setSavingId(member.id)
    try {
      const res = await fetch("/api/line-staff", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: member.id, travelCapReset: { courseId, undo } }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || "操作に失敗しました")
      toast.success(
        undo
          ? `${member.name}さんの数え直しを取り消しました`
          : `${member.name}さんの枠を数え直しました（次の申請から¥${TRAVEL_CAP_PER_COURSE.toLocaleString("ja-JP")}の枠で計算します）`
      )
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作に失敗しました")
    } finally {
      setSavingId(null)
    }
  }

  const resetCount = targets.filter((m) => latestReset(m)).length

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          交通費・宿泊費の枠
          {resetCount > 0 && (
            <Badge variant="outline" className="border-sky-500 text-sky-700 dark:text-sky-400">
              数え直し済み {resetCount} 名
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          交通費＋宿泊費は<strong>講座ごとに合計 ¥{TRAVEL_CAP_PER_COURSE.toLocaleString("ja-JP")}</strong>までです。
          <br />
          <strong>再受講のときは自動で数え直します。</strong>
          区切りは<strong>受講料の領収書の日付</strong>で、その日以降・次の受講料の日付より前の
          交通費・宿泊費を1つの受講分として累計します。
          申請の順番（新幹線が先、受講料が後など）では結果が変わりません。
          通常はこの画面を触る必要はありません。
          <br />
          手動で数え直すのは、<strong>同じ受講の分が別々に数えられてしまった場合</strong>など
          例外のときだけです。
          <br />
          <strong>確定済みの支給額は変わりません。</strong>
          押した日時より後の申請だけを枠に数えるようになります。
          <br />
          テスト申請は枠を消費しないため、テストスタッフはここに並びません。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="flex min-w-[320px] flex-col gap-1.5">
            <Label htmlFor="travel-cap-course">講座</Label>
            <Select value={courseId} onValueChange={setCourseId}>
              <SelectTrigger id="travel-cap-course">
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
            講座マスタに講座を登録すると、ここで枠を数え直せます。
          </p>
        ) : loading ? (
          <div className="flex items-center gap-2 py-4 text-sm" style={{ color: "var(--muted-foreground)" }}>
            <Loader2 className="size-4 animate-spin" />
            読み込み中…
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {targets.map((m) => {
              const last = latestReset(m)
              return (
                <div
                  key={m.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">{m.name}</span>
                    {hasSeparateLegalName(m) && (
                      <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                        給与・手続き：{payrollName(m)}
                      </span>
                    )}
                    {last ? (
                      <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                        {new Date(last.at).toLocaleString("ja-JP", {
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        に数え直し
                        {typeof last.used_before === "number" &&
                          `（それまでの使用額 ¥${last.used_before.toLocaleString("ja-JP")}）`}
                      </span>
                    ) : (
                      <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                        受講料の申請をもとに自動で数えています
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={savingId === m.id}
                      onClick={() => reset(m, false)}
                    >
                      {savingId === m.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3.5" />
                      )}
                      次の受講分として数え直す
                    </Button>
                    {last && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={savingId === m.id}
                        onClick={() => reset(m, true)}
                      >
                        取り消す
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
