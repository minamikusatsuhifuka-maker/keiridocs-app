"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import {
  Users,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  MessageCircle,
  ArrowRight,
  ChevronDown,
  ChevronUp,
} from "lucide-react"
import { toast } from "sonner"
import {
  commuteMethodLabel,
  commuterPassLabel,
  findNameConflicts,
  hasPendingNameChange,
  hasPriorCourseRecord,
  hasSeparateLegalName,
  mayHaveCommuterPass,
  parseLineProfile,
  payrollName,
} from "@/lib/line-staff-profile"

interface StaffMember {
  id: string
  name: string
  /** 046_staff_legal_name.sql（給与・行政上の氏名。旧姓で勤務している場合のみ入る） */
  legal_name?: string | null
  line_user_id: string | null
  created_at: string
  seminar_repeat_claimed_at?: string | null
  home_station?: string | null
  home_station_pref?: string | null
  /** 043_staff_retired.sql（退職日時。NULL=在籍中） */
  retired_at?: string | null
  is_test?: boolean | null
  /** 041_staff_line_profile.sql（定期券・初回設定の完了など） */
  line_profile?: unknown
}

/** LINEの初回設定の状態（担当が督促できるように一覧で示す） */
function setupStatus(member: StaffMember): { done: boolean; issues: string[] } {
  const profile = parseLineProfile(member.line_profile)
  const issues: string[] = []
  if (!member.home_station) issues.push("最寄り駅 未登録")
  if (!profile.commute_method) issues.push("通勤手段 未回答")
  // 車・自転車・徒歩の方は定期券を聞かないので未回答扱いにしない
  if (mayHaveCommuterPass(profile.commute_method ?? "other") && !profile.commuter_pass) {
    issues.push("定期券 未回答")
  }
  if (!profile.name_confirmed_at) issues.push("氏名 未確認")
  return { done: !!profile.setup_completed_at, issues }
}

/** セミナー2回目以降の申請日時を日本時間で表示（YYYY/MM/DD HH:mm） */
function formatClaimedAt(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ""
  return d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * LINEスタッフ管理のCRUD部分（パスワード認証なし）
 * - /line-staff ページと /mkadmin の「LINEスタッフ管理」タブの両方から再利用する
 * - 認証は呼び出し側（各ページ/管理画面）で行う
 *
 * @param showHeader 見出し・領収書管理リンクを表示するか（タブ内では false 推奨）
 */
export function StaffManagement({ showHeader = true }: { showHeader?: boolean }) {
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // 追加ダイアログ
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [newName, setNewName] = useState("")
  const [newLegalName, setNewLegalName] = useState("")
  // 「詳細」を開いているスタッフ（1人ずつ。ふだん触らない設定を隠して1画面に収める）
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [isAdding, setIsAdding] = useState(false)

  // 編集ダイアログ
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editingStaff, setEditingStaff] = useState<StaffMember | null>(null)
  const [editName, setEditName] = useState("")
  const [editLegalName, setEditLegalName] = useState("")
  const [editHomeStation, setEditHomeStation] = useState("")
  const [editHomeStationPref, setEditHomeStationPref] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  // 削除中のID
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // セミナー2回目以降 ON/OFFトグル処理中のID
  const [togglingId, setTogglingId] = useState<string | null>(null)
  // テストスタッフ ON/OFFトグル処理中のID
  const [togglingTestId, setTogglingTestId] = useState<string | null>(null)
  // 退職 ON/OFFトグル処理中のID
  const [togglingRetiredId, setTogglingRetiredId] = useState<string | null>(null)
  // 退職者も一覧に表示するか（既定は在籍者のみ）
  const [showRetired, setShowRetired] = useState(false)

  // 在籍者（退職者は既定で隠す。過去の記録は残っているが日々の運用では邪魔になる）
  const activeStaff = staff.filter((m) => !m.retired_at)
  const retiredCount = staff.length - activeStaff.length
  const visibleStaff = showRetired ? staff : activeStaff

  // 同姓・同名の警告（LINEの氏名登録で候補提示が必要になる組み合わせ）
  // 退職者は氏名照合の対象外なので、在籍者だけで判定する
  const nameConflicts = findNameConflicts(activeStaff)
  const setupSummary = {
    notDone: activeStaff.filter((m) => !setupStatus(m).done).length,
    noStation: activeStaff.filter((m) => !m.home_station).length,
    methodUnanswered: activeStaff.filter((m) => !parseLineProfile(m.line_profile).commute_method).length,
    // 車・自転車・徒歩の方は定期券を聞かないので未回答に数えない
    passUnanswered: activeStaff.filter((m) => {
      const p = parseLineProfile(m.line_profile)
      return mayHaveCommuterPass(p.commute_method ?? "other") && !p.commuter_pass
    }).length,
  }

  /* ---------- データ取得 ---------- */
  const fetchStaff = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch("/api/line-staff")
      if (!res.ok) throw new Error("取得失敗")
      const json = (await res.json()) as { data: StaffMember[] }
      setStaff(json.data ?? [])
    } catch {
      toast.error("スタッフ一覧の取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStaff()
  }, [fetchStaff])

  /* ---------- 追加 ---------- */
  async function handleAdd() {
    if (!newName.trim()) {
      toast.error("名前を入力してください")
      return
    }
    setIsAdding(true)
    try {
      const res = await fetch("/api/line-staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), legal_name: newLegalName.trim() || null }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error || "追加に失敗しました")
      }
      toast.success("スタッフを追加しました")
      setNewName("")
      setNewLegalName("")
      setAddDialogOpen(false)
      fetchStaff()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "追加に失敗しました")
    } finally {
      setIsAdding(false)
    }
  }

  /* ---------- 編集 ---------- */
  function openEditDialog(member: StaffMember) {
    setEditingStaff(member)
    setEditName(member.name)
    setEditLegalName(member.legal_name ?? "")
    setEditHomeStation(member.home_station ?? "")
    setEditHomeStationPref(member.home_station_pref ?? "")
    setEditDialogOpen(true)
  }

  async function handleEdit() {
    if (!editingStaff || !editName.trim()) {
      toast.error("名前を入力してください")
      return
    }
    setIsSaving(true)
    try {
      const res = await fetch("/api/line-staff", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingStaff.id,
          name: editName.trim(),
          legal_name: editLegalName.trim() || null,
          home_station: editHomeStation.trim() || null,
          home_station_pref: editHomeStationPref.trim() || null,
        }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error || "更新に失敗しました")
      }
      toast.success("スタッフ名を更新しました")
      setEditDialogOpen(false)
      setEditingStaff(null)
      fetchStaff()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新に失敗しました")
    } finally {
      setIsSaving(false)
    }
  }

  /* ---------- セミナー2回目以降 ON/OFFトグル（手動切替・訂正用・会計履歴は無改変） ---------- */
  // ON→以降「初回ATC＋アカデミー会員費」を非表示 / OFF→初回ATCを再表示
  async function handleToggleSeminarRepeat(member: StaffMember, next: boolean) {
    // 申請済み→未申請（OFF）に戻すときのみ確認（誤操作防止）
    if (!next && !confirm(`「${member.name}」のセミナー2回目以降を未登録（OFF）に戻しますか？\n（初回ATCが再表示されます。会計履歴は変更されません）`)) {
      return
    }
    setTogglingId(member.id)
    try {
      const res = await fetch("/api/line-staff", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: member.id, seminar_repeat_claimed: next }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error || "操作に失敗しました")
      }
      toast.success(next ? "セミナー2回目以降を登録済（ON）にしました（初回ATC非表示）" : "セミナー2回目以降を未登録（OFF）に戻しました（初回ATC再表示）")
      fetchStaff()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作に失敗しました")
    } finally {
      setTogglingId(null)
    }
  }

  /* ---------- 退職 ON/OFFトグル（論理削除。記録は残す） ---------- */
  async function handleToggleRetired(member: StaffMember, next: boolean) {
    if (next && !confirm(`「${member.name}」を退職にしますか？\n\n一覧から隠れ、LINEからの申請も受け付けなくなります。\n過去の申請記録と支給額はそのまま残ります。`)) return
    setTogglingRetiredId(member.id)
    try {
      const res = await fetch("/api/line-staff", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: member.id, retired: next }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error || "操作に失敗しました")
      }
      toast.success(
        next
          ? "退職にしました（一覧から隠れ、LINEからの申請を受け付けません。記録は残ります）"
          : "在籍に戻しました"
      )
      fetchStaff()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作に失敗しました")
    } finally {
      setTogglingRetiredId(null)
    }
  }

  /* ---------- テストスタッフ ON/OFFトグル（保存先分離・集計/通知から除外） ---------- */
  async function handleToggleTest(member: StaffMember, next: boolean) {
    setTogglingTestId(member.id)
    try {
      const res = await fetch("/api/line-staff", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: member.id, is_test: next }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error || "操作に失敗しました")
      }
      toast.success(
        next
          ? "テストスタッフ（ON）にしました（テストフォルダ保存・集計/通知から除外）"
          : "テストスタッフを解除（OFF）しました（本番扱いに戻ります）"
      )
      fetchStaff()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作に失敗しました")
    } finally {
      setTogglingTestId(null)
    }
  }

  /* ---------- 削除 ---------- */
  async function handleDelete(id: string, name: string) {
    if (
      !confirm(
        `「${name}」を削除しますか？\n\n` +
          `削除は登録ミスの行を消すためのものです。\n` +
          `過去の申請があるスタッフは削除できません（領収書の記録が消えて税理士提出リストの裏づけが失われるため）。\n` +
          `退職された場合は「退職」に切り替えてください。`
      )
    )
      return
    setDeletingId(id)
    try {
      const res = await fetch(`/api/line-staff?id=${id}`, { method: "DELETE" })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error || "削除に失敗しました")
      }
      toast.success("スタッフを削除しました")
      fetchStaff()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "削除に失敗しました")
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* 見出し + 操作ボタン */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {showHeader && (
            <>
              <div
                className="flex h-10 w-10 items-center justify-center rounded-xl text-white"
                style={{ background: "var(--dusk-accent-gradient)" }}
              >
                <Users className="h-5 w-5" />
              </div>
              <h1 className="text-2xl font-bold" style={{ color: "var(--dusk-text-main)" }}>
                LINEスタッフ管理
              </h1>
            </>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {retiredCount > 0 && (
            <Button variant="outline" onClick={() => setShowRetired((v) => !v)}>
              {showRetired ? `退職者を隠す（${retiredCount}名）` : `退職者も表示（${retiredCount}名）`}
            </Button>
          )}
          <Button asChild variant="outline">
            <Link href="/staff-receipts/admin">
              スタッフ領収書管理へ
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
          <Button
            className="btn-dusk-primary gap-2"
            onClick={() => setAddDialogOpen(true)}
          >
            <Plus className="h-4 w-4" />
            スタッフを追加
          </Button>
        </div>
      </div>

      {/* 説明カード */}
      <Card>
        <CardContent className="flex items-start gap-3 pt-5">
          <MessageCircle className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "var(--dusk-primary)" }} />
          <div className="text-sm" style={{ color: "var(--dusk-text-muted)" }}>
            <p>
              スタッフがLINEでフルネームを送り、確認ボタンを押すと登録されます。
              照合は<strong>この一覧の氏名との完全一致のみ</strong>です（姓と名の間のスペース・全角半角は問いません）。
            </p>
            <p>
              他のスタッフの氏名が見えてしまうため、<strong>候補は表示しません</strong>。
              一致しなければ入力し直してもらい、同姓同名が2名いる場合は担当にご連絡いただく案内になります。
              そのため<strong>この一覧はフルネームで登録</strong>してください。
            </p>
            <p>LINE未登録のスタッフにはリマインダーが届きません。</p>
            {staff.length > 0 && (
              <p className="mt-1">
                LINE初回設定：未完了 {setupSummary.notDone}名 ／ 最寄り駅 未登録 {setupSummary.noStation}名 ／ 通勤手段 未回答{" "}
                {setupSummary.methodUnanswered}名 ／ 定期券 未回答 {setupSummary.passUnanswered}名
                <span className="ml-1 text-xs">（定期券が未回答のまま電車代を申請すると二重払いになるため、未完了の方は次の申請時に設定を1回挟みます。車・自転車・徒歩の方には定期券を聞きません）</span>
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* スタッフ一覧 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">スタッフ一覧</CardTitle>
          {/* どの操作がどこにあるか分かるようにする（アイコンだけでは探せない） */}
          <CardDescription>
            <strong>氏名の変更（フルネームへの修正・改姓）</strong>は各行の「編集」から。
            自宅の最寄り駅も同じ画面で登録できます。
            <br />
            <strong>入職</strong>は上の「スタッフを追加」、
            <strong>退職</strong>は各行の「在籍」スイッチをOFFにしてください。
            退職にすると一覧から隠れ、LINEからの申請も受け付けませんが、過去の申請記録は残ります。
            <br />
            テスト・初回ATC・削除は「詳細」を開くと出てきます。
            <br />
            <strong>「初回ATCの表示」</strong>は、LINEの申請画面に「初回ATC＋アカデミー会員費」を出すかどうかです。
            初回の全額支給を2回受けられないようにするためのもので、次のどちらかで<strong>自動的に「非表示」</strong>になります。
            <br />
            ① 下の<strong>「既受講の登録」</strong>に受講回数（1回以上）を登録したとき
            ② 本人がLINEで「セミナー2回目以降」を申請したとき
            <br />
            ①で非表示になっている方は「既受講の登録により非表示」と表示されます。
            つまり<strong>既受講の登録をすれば、このスイッチは触らなくて済みます</strong>。
            スイッチは記録がない方を手で非表示にするときだけ使ってください。会計の記録は変わりません。
            既受講の登録は支給率（全額／半額）の判定にも使われます。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--dusk-primary)" }} />
            </div>
          ) : staff.length === 0 ? (
            <div className="py-12 text-center" style={{ color: "var(--dusk-text-muted)" }}>
              <Users className="mx-auto mb-3 h-10 w-10 opacity-40" />
              <p>スタッフが登録されていません</p>
              <p className="mt-1 text-sm">「スタッフを追加」ボタンから登録してください</p>
            </div>
          ) : (
            /*
              横に長い表はスクロールが必要で、行を目で追う間に別のスタッフを
              操作してしまう危険があった。1人1枚のカードにして横スクロールを無くす。
              よく使う「氏名・在籍・編集」は常に見え、細かい設定は「詳細」で開く。
            */
            <div className="flex flex-col gap-3">
              {visibleStaff.map((member) => {
                const st = setupStatus(member)
                const profile = parseLineProfile(member.line_profile)
                const atcHidden =
                  !!member.seminar_repeat_claimed_at || hasPriorCourseRecord(member.line_profile)
                const isOpen = expandedId === member.id
                return (
                  <div
                    key={member.id}
                    className="rounded-lg border p-3"
                    style={{
                      borderColor: "var(--dusk-border)",
                      background: member.retired_at ? "var(--muted)" : undefined,
                    }}
                  >
                    {/* 1段目: 氏名と、よく使う操作 */}
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{member.name}</span>
                          {member.retired_at && (
                            <Badge variant="outline" style={{ color: "var(--dusk-text-muted)" }}>
                              退職
                            </Badge>
                          )}
                          {/* 改姓して院内では旧姓のまま、という状態をひと目で分かるようにする */}
                          {hasSeparateLegalName(member) && (
                            <Badge
                              variant="outline"
                              className="border-violet-500 text-violet-700 dark:text-violet-300"
                            >
                              院内は旧姓
                            </Badge>
                          )}
                          {member.is_test && (
                            <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
                              テスト
                            </Badge>
                          )}
                        </div>

                        {hasSeparateLegalName(member) && (
                          <p className="mt-0.5 text-xs" style={{ color: "var(--dusk-text-muted)" }}>
                            給与・手続き：{payrollName(member)}
                          </p>
                        )}

                        {/* 直してほしいことだけを並べる（LINEの照合は完全一致のため） */}
                        {!member.name.trim().includes(" ") &&
                          !member.name.trim().includes("　") &&
                          member.name.trim().length <= 3 && (
                            <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
                              フルネームで登録してください
                            </p>
                          )}
                        {nameConflicts.get(member.id) && (
                          <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-amber-600">
                            <AlertTriangle className="h-3 w-3" />
                            {nameConflicts.get(member.id) === "same_name"
                              ? "同名のスタッフがいます"
                              : "同姓のスタッフがいます（フルネーム推奨）"}
                          </p>
                        )}
                        {hasPendingNameChange(profile) && (
                          <p className="mt-0.5 text-xs text-amber-600">
                            お名前の変更依頼あり（「編集」から変更すると完了）
                          </p>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {/* 在籍/退職。退職＝一覧から隠し、LINEからの申請も受け付けない。記録は残る */}
                        <div className="flex items-center gap-2 rounded-md border px-2 py-1">
                          <Switch
                            checked={!member.retired_at}
                            onCheckedChange={(checked) => handleToggleRetired(member, !checked)}
                            disabled={togglingRetiredId === member.id}
                            aria-label="在籍の切り替え"
                          />
                          <span
                            className="inline-flex items-center gap-1 text-sm font-medium"
                            style={{ color: member.retired_at ? "var(--dusk-text-muted)" : undefined }}
                          >
                            {togglingRetiredId === member.id && <Loader2 className="h-3 w-3 animate-spin" />}
                            {member.retired_at ? "退職" : "在籍"}
                          </span>
                        </div>
                        <Button variant="outline" size="sm" onClick={() => openEditDialog(member)}>
                          <Pencil className="h-4 w-4" />
                          編集
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setExpandedId(isOpen ? null : member.id)}
                        >
                          {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          詳細
                        </Button>
                      </div>
                    </div>

                    {/* 2段目: 状態のまとめ（文字だけ・折り返す） */}
                    <div
                      className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
                      style={{ color: "var(--dusk-text-muted)" }}
                    >
                      <span className="inline-flex items-center gap-1">
                        {member.line_user_id ? (
                          <>
                            <CheckCircle2 className="h-4 w-4 text-green-600" />
                            LINE登録済み
                          </>
                        ) : (
                          <>
                            <AlertTriangle className="h-4 w-4 text-amber-600" />
                            LINE未登録
                          </>
                        )}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        {st.done ? (
                          <>
                            <CheckCircle2 className="h-4 w-4 text-green-600" />
                            初回設定ずみ
                          </>
                        ) : (
                          <>
                            <AlertTriangle className="h-4 w-4 text-amber-600" />
                            初回設定が未完了
                            {st.issues.length > 0 && `（${st.issues.join("・")}）`}
                          </>
                        )}
                      </span>
                      <span>
                        最寄り駅：
                        {member.home_station
                          ? `${member.home_station}${member.home_station_pref ? `（${member.home_station_pref}）` : ""}`
                          : "未登録"}
                      </span>
                      <span>通勤：{commuteMethodLabel(profile)}</span>
                      {mayHaveCommuterPass(profile.commute_method ?? "other") && (
                        <span>定期券：{commuterPassLabel(profile)}</span>
                      )}
                      <span>初回ATC：{atcHidden ? "非表示" : "表示"}</span>
                    </div>

                    {/* 3段目（詳細）: ふだんは触らない設定 */}
                    {isOpen && (
                      <div
                        className="mt-3 flex flex-col gap-3 border-t pt-3"
                        style={{ borderColor: "var(--dusk-border)" }}
                      >
                        {/* 初回ATCの表示。既受講の登録があればスイッチに関係なく非表示 */}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium">初回ATCの表示</p>
                            <p className="text-xs" style={{ color: "var(--dusk-text-muted)" }}>
                              {!member.seminar_repeat_claimed_at && hasPriorCourseRecord(member.line_profile)
                                ? "既受講の登録により非表示になっています（スイッチは不要です）"
                                : member.seminar_repeat_claimed_at
                                  ? `本人の申請により非表示（${formatClaimedAt(member.seminar_repeat_claimed_at)}）`
                                  : "LINEに「初回ATC＋アカデミー会員費」が表示されます"}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={!!member.seminar_repeat_claimed_at}
                              onCheckedChange={(checked) => handleToggleSeminarRepeat(member, checked)}
                              disabled={togglingId === member.id}
                              aria-label="LINEで初回ATCを表示するかの切り替え"
                            />
                            <span
                              className="inline-flex items-center gap-1 text-sm font-medium"
                              style={{ color: atcHidden ? "var(--dusk-primary)" : "var(--dusk-text-muted)" }}
                            >
                              {togglingId === member.id && <Loader2 className="h-3 w-3 animate-spin" />}
                              {atcHidden ? "非表示" : "表示"}
                            </span>
                          </div>
                        </div>

                        {/* テストスタッフ。ON=テストフォルダ保存＋会計士CSV/集計/院長通知から除外 */}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium">テストスタッフ</p>
                            <p className="text-xs" style={{ color: "var(--dusk-text-muted)" }}>
                              ONにすると、会計士さんへの提出・集計・通知から除外されます。
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={!!member.is_test}
                              onCheckedChange={(checked) => handleToggleTest(member, checked)}
                              disabled={togglingTestId === member.id}
                              aria-label="テストスタッフの切り替え"
                            />
                            <span
                              className="inline-flex items-center gap-1 text-sm font-medium"
                              style={{ color: member.is_test ? "#d97706" : "var(--dusk-text-muted)" }}
                            >
                              {togglingTestId === member.id && <Loader2 className="h-3 w-3 animate-spin" />}
                              {member.is_test ? "テスト(ON)" : "本番(OFF)"}
                            </span>
                          </div>
                        </div>

                        {/* 削除は誤操作が怖いので詳細の中に置く（退職は在籍スイッチ） */}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium">この行を削除</p>
                            <p className="text-xs" style={{ color: "var(--dusk-text-muted)" }}>
                              登録ミスの行を消すためのものです。退職は上の「在籍」スイッチで切り替えてください。
                              申請があるスタッフは削除できません。
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => handleDelete(member.id, member.name)}
                            disabled={deletingId === member.id}
                          >
                            {deletingId === member.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                            削除
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

      {/* 追加ダイアログ */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>スタッフを追加</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="new-name">① 院内で使っているお名前</Label>
              <Input
                id="new-name"
                placeholder="例: 南 ひふ子"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isAdding) handleAdd()
                }}
              />
              <p className="text-xs" style={{ color: "var(--dusk-text-muted)" }}>
                <strong>必ずフルネーム</strong>で入力してください。
                LINEの氏名照合はこの氏名との完全一致のみで、姓だけでは本人と判定できません。
              </p>
            </div>
            {/* 給与・行政上の氏名。入職時点で旧姓勤務が分かっている場合に入れる */}
            <div className="space-y-2">
              <Label htmlFor="new-legal-name">② 給与や手続きに使うお名前（任意）</Label>
              <Input
                id="new-legal-name"
                placeholder="同じ場合は空欄のまま"
                value={newLegalName}
                onChange={(e) => setNewLegalName(e.target.value)}
              />
              <p className="text-xs" style={{ color: "var(--dusk-text-muted)" }}>
                院内で使っているお名前と異なる場合のみ、フルネームでご入力ください。
                あとから「編集」でも登録できます。
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setAddDialogOpen(false)
                  setNewName("")
                  setNewLegalName("")
                }}
              >
                キャンセル
              </Button>
              <Button
                className="btn-dusk-primary"
                onClick={handleAdd}
                disabled={isAdding || !newName.trim()}
              >
                {isAdding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                追加
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 編集ダイアログ */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>スタッフ名を編集</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="edit-name">① 院内で使っているお名前</Label>
              <Input
                id="edit-name"
                placeholder="例: 南 ひふ子"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isSaving) handleEdit()
                }}
              />
              <p className="text-xs" style={{ color: "var(--dusk-text-muted)" }}>
                普段、クリニックで使っているお名前をフルネームでご入力ください。
              </p>
            </div>
            {/*
              給与・行政上の氏名。
              結婚などで戸籍の氏名が変わっても旧姓のまま勤務することがあり、
              給与・社会保険・源泉徴収は戸籍の氏名で処理する必要がある。
              LINEの氏名照合はどちらの氏名でも通るので、スタッフが取り違えても申請できる。
            */}
            <div className="space-y-2">
              <Label htmlFor="edit-legal-name">② 給与や手続きに使うお名前（任意）</Label>
              <Input
                id="edit-legal-name"
                placeholder="同じ場合は空欄のまま"
                value={editLegalName}
                onChange={(e) => setEditLegalName(e.target.value)}
              />
              <p className="text-xs" style={{ color: "var(--dusk-text-muted)" }}>
                院内で使っているお名前と異なる場合のみ、フルネームでご入力ください。
                同じ場合は空欄で大丈夫です。
                <br />
                ご入力いただくと、LINEで<strong>どちらのお名前を送っても</strong>ご本人と判定します。
              </p>
            </div>
            {/* 自宅最寄り駅（領収書なし交通費の電車運賃AI推定の出発駅。県は同名駅の特定用） */}
            <div className="space-y-2">
              <Label htmlFor="edit-home-station">自宅最寄り駅</Label>
              <Input
                id="edit-home-station"
                placeholder="例: 南草津"
                value={editHomeStation}
                onChange={(e) => setEditHomeStation(e.target.value)}
              />
              <p className="text-xs" style={{ color: "var(--dusk-text-muted)" }}>
                LINEの「交通費（領収書なし）・電車」で運賃を推定する出発駅に使います。
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-home-station-pref">県（都道府県）</Label>
              <Input
                id="edit-home-station-pref"
                placeholder="例: 滋賀県"
                value={editHomeStationPref}
                onChange={(e) => setEditHomeStationPref(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setEditDialogOpen(false)
                  setEditingStaff(null)
                }}
              >
                キャンセル
              </Button>
              <Button
                className="btn-dusk-primary"
                onClick={handleEdit}
                disabled={isSaving || !editName.trim()}
              >
                {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                保存
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
