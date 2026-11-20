"use client"

// スタッフ立替専用メニュー。
// 小口現金の取引一覧に混ざっていたスタッフ立替を、1件1行の独立した明細として一覧表示する。
// 分割登録（1ファイルに複数の領収証）は合算せず、レコードごとに1行＋「分割 n/N」で表示する。

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { NotifyStaffDialog } from "@/components/mkadmin/notify-staff-dialog"
import { InquiryList } from "@/components/line-staff/inquiry-list"
import { ReceiptDiagnose } from "@/components/line-staff/receipt-diagnose"
import {
  CompletePendingDialog,
  type CompleteTarget,
} from "@/components/line-staff/complete-pending-dialog"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertTriangle,
  MessageCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Wallet,
} from "lucide-react"
import { toast } from "sonner"
import {
  FilePreviewModal,
  previewKind,
  type FilePreviewTarget,
} from "@/components/documents/file-preview-modal"
import { STAFF_EXPENSE_DETAILS } from "@/lib/subsidy"

/* ---------- 型（APIのレスポンスに対応） ---------- */

type ReimburseSource = "line" | "admin_approve" | "manual" | "petty_manual"

const SOURCE_LABELS: Record<ReimburseSource, string> = {
  line: "LINE",
  admin_approve: "管理画面の承認",
  manual: "手動登録",
  petty_manual: "手動登録（小口）",
}

interface Row {
  transactionId: string
  receiptId: string | null
  staffMemberId: string | null
  staffName: string
  applicationDate: string
  submitDate: string
  /** 提出月（"YYYY-MM"。税理士提出フォルダの振り分け先） */
  submissionMonth: string
  /** 提出月が手動指定か（false は提出日20日締めの自動判定） */
  submissionMonthManual: boolean
  paymentDate: string
  storeName: string
  expenseDetail: string
  detailKey: string
  amount: number
  isHalf: boolean
  subsidy: number
  source: ReimburseSource
  registeredBy: string
  /** 担当が確認した日時（ISO文字列）。未確認は "" */
  reviewedAt: string
  /** 確認した担当者。未確認は "" */
  reviewedBy: string
  hasFile: boolean
  fileName: string
  dropboxPath: string
  splitGroup: string | null
  splitIndex: number
  splitTotal: number
}

/**
 * 要対応の1件（/api/staff-reimburse/pending の戻り）。
 *
 *   excess     上限超過の承認待ち
 *   course     講座の割り当て待ち
 *   attach     合格通知の添付待ち
 *   incomplete 未完了の申請（スタッフが費用区分を選ばずに離脱した）
 */
interface PendingItem {
  id: string
  kind: "excess" | "course" | "attach" | "pass" | "term" | "detail" | "dup" | "help" | "incomplete"
  /** 連絡（LINE）に使う staff_members.id */
  staffMemberId: string | null
  staffName: string
  courseName: string
  itemLabel: string
  /** 支払先（未完了の申請を担当が代わりに登録するときに使う） */
  storeName?: string | null
  /** 領収書の日付（同上） */
  paymentDate?: string | null
  amount: number
  excess: number
  suggested: number
  isRepeat: boolean
  /** 上限と支給率の計算内訳（上限がある内訳のみ。無ければ空） */
  calcNote?: string[]
  submittedAt: string
  daysWaiting: number
  /**
   * テストの印が付いたまま残っている申請。
   * 本物の申請なのに、給与集計・会計士提出から外れている状態。
   */
  testMarked?: boolean
}

const PENDING_LABELS: Record<PendingItem["kind"], string> = {
  excess: "上限超過",
  course: "講座の確認",
  attach: "添付待ち",
  pass: "定期券区間",
  term: "会員期間外",
  detail: "内訳がその他",
  dup: "二重申請の疑い",
  help: "本人から相談",
  incomplete: "未完了",
}

/** 種別ごとの説明（担当が何をすればよいか） */
const PENDING_HELP: Record<PendingItem["kind"], string> = {
  excess: "上限を超えた分を承認するか決めてください。承認するとスタッフへ自動で通知されます。",
  course: "講座マスタに無い講座名で申請されています。/mkadmin の講座マスタで登録・割り当てしてください。",
  attach: "合格通知または修了通知の写真が届いていません。スタッフへ催促してください。",
  dup: "同じスタッフ・同じ日付・同じ金額・同じ支払先の申請が既に確定しています。同じ領収書を2回送った可能性があります。別の支出であれば「このまま確定する」を、重複であれば「承認しない」を押してください。",
  detail: "「その他」で申請されています。スタッフが書いた内容（明細の摘要に入っています）を確認し、支給してよければ「このまま確定する」を押してください。金額を変える場合は下の明細で直してから確定してください。",
  term: "アカデミー会員の有効期間（開始日から3年）を過ぎているか、開始日が未登録です。スタッフの「設定」→「アカデミー会員の登録」で開始日を登録してもらうか、期間外の扱いを決めてから確定してください。",
  pass: "切符などで定期券区間が含まれている可能性があります。院が通勤手当を払っているため、その区間の運賃を差し引いて承認してください（差し引く額は「金額を指定して承認」で入力できます）。",
  help: "スタッフが「担当に相談する」を押しました。領収書の金額や日付が読み取れていません。画像を確認し、「立替手動登録」から金額・日付・区分を入れて登録してください。登録が済んだらこの行の「対応済みにして隠す」を押してください。",
  incomplete:
    "領収書は届いていますが、費用区分が選ばれず支給の対象になっていません。本人は申請したつもりの可能性があります。",
}

interface Subtotal {
  staffMemberId: string | null
  staffName: string
  count: number
  totalAmount: number
  totalSubsidy: number
}

interface ApiResponse {
  rows: Row[]
  subtotals: Subtotal[]
  totals: { count: number; totalAmount: number; totalSubsidy: number; unreviewedCount: number }
  periodLabel: string
  staffOptions: { id: string; name: string }[]
  detailOptions: string[]
}

/* ---------- 表示ヘルパー ---------- */

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`

/** 確認日時を「11/16 19:30」の形にする（JST） */
const formatReviewedAt = (iso: string) => {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
const ALL = "__all__"

type SortKey =
  | "applicationDate"
  | "submitDate"
  | "submissionMonth"
  | "paymentDate"
  | "staffName"
  | "storeName"
  | "expenseDetail"
  | "amount"
  | "isHalf"
  | "subsidy"
  | "source"

const COLUMNS: { key: SortKey; label: string; numeric?: boolean; className?: string }[] = [
  { key: "applicationDate", label: "申請日" },
  { key: "submitDate", label: "提出日" },
  { key: "submissionMonth", label: "提出月" },
  { key: "paymentDate", label: "支払年月日" },
  { key: "staffName", label: "スタッフ名" },
  { key: "storeName", label: "支払先" },
  { key: "expenseDetail", label: "目的・用途" },
  { key: "amount", label: "立替額", numeric: true, className: "text-right" },
  { key: "isHalf", label: "支給割合" },
  { key: "subsidy", label: "支給額", numeric: true, className: "text-right" },
  { key: "source", label: "登録経路" },
]

/** 当月の初日・末日（JST） */
function currentMonthRange(): { start: string; end: string } {
  const ym = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
  const [y, m] = ym.split("-").map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const mm = String(m).padStart(2, "0")
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, "0")}` }
}

export default function StaffReimbursePage() {
  const initialRange = useMemo(currentMonthRange, [])

  const [basis, setBasis] = useState<"submit" | "application" | "payment">("submit")
  const [start, setStart] = useState(initialRange.start)
  const [end, setEnd] = useState(initialRange.end)
  const [staffMemberId, setStaffMemberId] = useState<string>(ALL)
  const [expenseDetail, setExpenseDetail] = useState<string>(ALL)
  // 提出月（税理士提出フォルダの振り分け先）の絞り込みと一括変更
  const [submissionMonthFilter, setSubmissionMonthFilter] = useState("")
  const [selectedReceiptIds, setSelectedReceiptIds] = useState<Set<string>>(new Set())
  const [showSubmissionMonthModal, setShowSubmissionMonthModal] = useState(false)
  const [submissionMonthInput, setSubmissionMonthInput] = useState("")
  const [isSavingSubmissionMonth, setIsSavingSubmissionMonth] = useState(false)
  const [submissionMonthResult, setSubmissionMonthResult] = useState<{
    updated: number
    month: string | null
    leftoverFiles: { id: string; fileName: string; fromMonthLabel: string; path: string }[]
  } | null>(null)

  const [data, setData] = useState<ApiResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  const [previewTarget, setPreviewTarget] = useState<FilePreviewTarget | null>(null)
  const [editRow, setEditRow] = useState<Row | null>(null)
  const [deleteRow, setDeleteRow] = useState<Row | null>(null)

  // 確認済みの記録（担当の進捗管理。支給・税理士提出には影響しない）
  const [savingReviewIds, setSavingReviewIds] = useState<Set<string>>(new Set())

  // 要対応（上限超過の承認・講座の確認・添付待ち・未完了の申請）
  const [pending, setPending] = useState<PendingItem[]>([])
  const [showPending, setShowPending] = useState(true)
  // 承認処理中のID
  const [approvingId, setApprovingId] = useState<string | null>(null)
  // 未完了の申請を担当が代わりに登録するダイアログの対象
  const [completeTarget, setCompleteTarget] = useState<CompleteTarget | null>(null)
  // 金額を指定して承認する対象（null は入力なしのワンクリック承認）
  const [customAmountFor, setCustomAmountFor] = useState<PendingItem | null>(null)
  const [customAmount, setCustomAmount] = useState("")
  // LINEで連絡する相手（null のときはダイアログを閉じる）
  const [notifyTarget, setNotifyTarget] = useState<{ id: string; name: string } | null>(null)

  const query = useMemo(() => {
    const p = new URLSearchParams()
    p.set("basis", basis)
    if (start) p.set("start", start)
    if (end) p.set("end", end)
    if (staffMemberId !== ALL) p.set("staffMemberId", staffMemberId)
    if (expenseDetail !== ALL) p.set("expenseDetail", expenseDetail)
    if (submissionMonthFilter) p.set("submissionMonth", submissionMonthFilter)
    return p.toString()
  }, [basis, start, end, staffMemberId, expenseDetail, submissionMonthFilter])

  const fetchData = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch(`/api/staff-reimburse?${query}`)
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error || "取得に失敗しました")
      }
      setData((await res.json()) as ApiResponse)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "取得に失敗しました")
      setData(null)
    } finally {
      setIsLoading(false)
    }
  }, [query])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  /**
   * 締め日（毎月20日）までの残り日数。
   * 20日を過ぎた分は翌月のお給与になるため、担当が一目で分かるようにする。
   */
  const closingInfo = (() => {
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000) // JST
    const day = now.getUTCDate()
    if (day === 20) return { label: "本日が締め日です", urgent: true }
    if (day < 20) return { label: `締めまであと ${20 - day} 日`, urgent: 20 - day <= 3 }
    // 21日以降は翌月20日まで
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 20))
    const days = Math.ceil((end.getTime() - now.getTime()) / 86400000)
    return { label: `次の締めまであと ${days} 日`, urgent: false }
  })()

  // 要対応を取得する（期間フィルタとは独立。常に全件を見せて取りこぼしを防ぐ）
  const fetchPending = useCallback(async () => {
    try {
      const res = await fetch("/api/staff-reimburse/pending")
      if (!res.ok) return
      const json = (await res.json()) as { items?: PendingItem[] }
      // 同じ種別をまとめ、古いものを先に出す。
      // 種別が混ざって並ぶと、同じ判断を何度も切り替えることになり進めにくい
      const order: PendingItem["kind"][] = [
        "excess",
        "course",
        "term",
        "pass",
        "detail",
        "dup",
        "attach",
        "help",
        "incomplete",
      ]
      const items = [...(json.items ?? [])].sort((a, b) => {
        const d = order.indexOf(a.kind) - order.indexOf(b.kind)
        if (d !== 0) return d
        return b.daysWaiting - a.daysWaiting
      })
      setPending(items)
    } catch {
      // 取得できなくても本体の一覧は使えるようにする（警告は出さない）
    }
  }, [])

  useEffect(() => {
    fetchPending()
  }, [fetchPending])

  /**
   * 上限超過を承認／却下する。
   * amount を省略すると規程どおりの既定値（ボタンに表示している額）で承認する。
   */
  const approveExcess = useCallback(
    async (item: PendingItem, approve: boolean, amount?: number) => {
      const yenStr = (n: number) => `¥${n.toLocaleString("ja-JP")}`
      const toApprove = amount ?? item.suggested
      const message = approve
        ? `${item.staffName}さんの${item.itemLabel}について、超過分 ${yenStr(toApprove)} を追加して承認します。\n\nよろしいですか？`
        : `${item.staffName}さんの${item.itemLabel}について、超過分を承認しません。\n上限額のまま確定し、スタッフへ通知されます。\n\nよろしいですか？`
      if (!confirm(message)) return

      setApprovingId(item.id)
      try {
        const res = await fetch("/api/staff-reimburse/approve-excess", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: item.id, approve, amount: approve ? toApprove : undefined }),
        })
        const json = (await res.json().catch(() => ({}))) as {
          error?: string
          finalSubsidy?: number
          notified?: boolean
        }
        if (!res.ok) throw new Error(json.error || "承認に失敗しました")

        toast.success(
          `${approve ? "承認しました" : "承認しませんでした"}。支給額は ${yenStr(json.finalSubsidy ?? 0)} です` +
            (json.notified ? "（スタッフへ通知済み）" : "（LINE通知は送れませんでした）")
        )
        setCustomAmountFor(null)
        setCustomAmount("")
        fetchPending()
        fetchData()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "承認に失敗しました")
      } finally {
        setApprovingId(null)
      }
    },
    [fetchPending, fetchData]
  )

  /**
   * 未完了の申請を「対応済み」にして要対応から外す。
   *
   * 未完了には承認・却下のような確定操作が無いため、
   * 本人に確認して処理し終えたものを担当が自分で消せるようにする。
   * 支給は作られないので、支給が必要なら「立替手動登録」で登録する。
   */
  const dismissIncomplete = useCallback(
    async (items: PendingItem[]) => {
      if (items.length === 0) return
      const names = Array.from(new Set(items.map((i) => i.staffName))).join("・")
      const message =
        items.length === 1
          ? `${items[0].staffName}さんの未完了の申請（${yen(items[0].amount)}）を対応済みにして、要対応から外します。\n\n支給は作られません。支給が必要な場合は「立替手動登録」で登録してください。\n\nよろしいですか？`
          : `未完了の申請 ${items.length}件（${names}）をまとめて対応済みにして、要対応から外します。\n\n支給は作られません。支給が必要な分は「立替手動登録」で登録してください。\n\nよろしいですか？`
      if (!confirm(message)) return

      setApprovingId(items.length === 1 ? items[0].id : "__bulk__")
      try {
        const res = await fetch("/api/staff-reimburse/dismiss", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: items.map((i) => i.id) }),
        })
        const json = (await res.json().catch(() => ({}))) as { error?: string; updated?: number }
        if (!res.ok) throw new Error(json.error || "処理に失敗しました")
        toast.success(`${json.updated ?? items.length}件を対応済みにしました`)
        fetchPending()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "処理に失敗しました")
      } finally {
        setApprovingId(null)
      }
    },
    [fetchPending]
  )

  /**
   * テストの印を外して、本番の申請として扱えるようにする。
   *
   * テストを終えずに「テストスタッフ」をOFFにすると、そのあとの本物の申請にも
   * 印が付き、給与集計・会計士提出から外れてしまう。その救済。
   */
  const clearTestMark = useCallback(
    async (item: PendingItem) => {
      if (
        !confirm(
          `${item.staffName}さんの申請（${yen(item.amount)}）からテストの印を外し、` +
            "本番の申請として扱います。\n\n" +
            "記録は消えません。印を外すと、給与集計と会計士さんへの提出に入ります。\n\n" +
            "よろしいですか？"
        )
      )
        return

      setApprovingId(item.id)
      try {
        const res = await fetch("/api/staff-receipts/clear-test-mark", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ receiptIds: [item.id] }),
        })
        const json = (await res.json().catch(() => ({}))) as {
          error?: string
          cleared?: number
          skipped?: { name: string; reason: string }[]
        }
        if (!res.ok) throw new Error(json.error || "処理に失敗しました")
        if (json.skipped && json.skipped.length > 0) {
          toast.error(`外せませんでした（${json.skipped[0].reason}）`)
        } else {
          toast.success("テストの印を外しました")
        }
        fetchPending()
        fetchData()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "処理に失敗しました")
      } finally {
        setApprovingId(null)
      }
    },
    [fetchPending, fetchData]
  )

  /**
   * 明細の「確認済み」を切り替える。
   * 対象は petty_cash_transactions.id（分割登録は行ごとに確認する）。
   */
  const toggleReview = useCallback(
    async (ids: string[], reviewed: boolean) => {
      if (ids.length === 0) return
      setSavingReviewIds((prev) => new Set([...prev, ...ids]))
      try {
        const res = await fetch("/api/staff-reimburse/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids, reviewed }),
        })
        const json = (await res.json().catch(() => ({}))) as { error?: string; reviewedBy?: string | null }
        if (!res.ok) throw new Error(json.error || "確認状態を更新できませんでした")

        // 画面を即時反映（再取得を待たせない）
        setData((prev) =>
          prev
            ? {
                ...prev,
                rows: prev.rows.map((r) =>
                  ids.includes(r.transactionId)
                    ? {
                        ...r,
                        reviewedAt: reviewed ? new Date().toISOString() : "",
                        reviewedBy: reviewed ? json.reviewedBy ?? "" : "",
                      }
                    : r
                ),
                totals: {
                  ...prev.totals,
                  unreviewedCount: Math.max(
                    0,
                    prev.totals.unreviewedCount + (reviewed ? -ids.length : ids.length)
                  ),
                },
              }
            : prev
        )
        toast.success(reviewed ? `${ids.length}件を確認済みにしました` : `${ids.length}件の確認を取り消しました`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "確認状態を更新できませんでした")
      } finally {
        setSavingReviewIds((prev) => {
          const next = new Set(prev)
          for (const id of ids) next.delete(id)
          return next
        })
      }
    },
    []
  )

  // 並べ替え（空値は常に末尾）
  const sortedRows = useMemo(() => {
    const rows = data?.rows ?? []
    if (!sortKey) return rows
    const sign = sortDir === "asc" ? 1 : -1
    const isEmpty = (r: Row): boolean => {
      const v = valueOf(r, sortKey)
      return v === "" || v === null || v === undefined
    }
    return [...rows].sort((a, b) => {
      const ae = isEmpty(a)
      const be = isEmpty(b)
      if (ae !== be) return ae ? 1 : -1 // 空値は昇順・降順にかかわらず末尾
      const av = valueOf(a, sortKey)
      const bv = valueOf(b, sortKey)
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign
      return String(av).localeCompare(String(bv), "ja") * sign
    })
  }, [data, sortKey, sortDir])

  // 提出月を変更できるのは資料（staff_receipts）がある行のみ
  const selectableRows = useMemo(() => sortedRows.filter((r) => !!r.receiptId), [sortedRows])

  // 選択中の行の提出月を一括変更（month=null で自動判定に戻す）
  async function applySubmissionMonth(month: string | null) {
    if (selectedReceiptIds.size === 0) return
    setIsSavingSubmissionMonth(true)
    setSubmissionMonthResult(null)
    try {
      const res = await fetch("/api/submission-month", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "staff_receipt",
          ids: Array.from(selectedReceiptIds),
          month,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json?.error ?? "提出月の変更に失敗しました")
        return
      }
      setSubmissionMonthResult(json)
      setSelectedReceiptIds(new Set())
      await fetchData()
    } catch {
      toast.error("提出月の変更に失敗しました")
    } finally {
      setIsSavingSubmissionMonth(false)
    }
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("asc")
    }
  }

  // 資料を開く（画像・PDFはアプリ内モーダル、その他はDropboxウェブ）
  function openFile(row: Row) {
    if (!row.receiptId || !row.hasFile) return
    const kind = previewKind(row.fileName)
    if (kind) {
      setPreviewTarget({
        id: row.receiptId,
        dropboxPath: row.dropboxPath || row.fileName,
        title: `${row.staffName}／${row.storeName}`,
        kind,
        // IDからサーバ側でDropboxパスを解決する（パス直指定は受け付けない）
        fileUrl: `/api/staff-receipts/image?id=${encodeURIComponent(row.receiptId)}`,
      })
    } else {
      // プレビューできない形式は一時リンクでDropboxの実ファイルを開く
      openViaTemporaryLink(row.receiptId)
    }
  }

  async function openViaTemporaryLink(receiptId: string) {
    try {
      const res = await fetch(`/api/staff-receipts/image?id=${encodeURIComponent(receiptId)}&mode=link`)
      const json = (await res.json()) as { link?: string; error?: string }
      if (!json.link) throw new Error(json.error || "リンクの取得に失敗しました")
      window.open(json.link, "_blank", "noopener,noreferrer")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "資料を開けませんでした")
    }
  }

  function download(format: "csv" | "xlsx") {
    window.location.href = `/api/staff-reimburse?${query}&format=${format}`
  }

  const totals = data?.totals ?? { count: 0, totalAmount: 0, totalSubsidy: 0 }

  return (
    <div className="space-y-6">
      {/* 見出し */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">スタッフ立替</h1>
          <p className="text-sm text-muted-foreground">
            スタッフ立替（LINE申請・管理画面の承認・手動登録）だけを1件1行で表示します。
            金額は会計士向け立替明細CSVと同じ計算です。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={fetchData} disabled={isLoading}>
            {isLoading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            再読み込み
          </Button>
          <Button variant="outline" size="sm" onClick={() => download("csv")}>
            <Download className="size-4" />
            CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => download("xlsx")}>
            <FileSpreadsheet className="size-4" />
            Excel
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/petty-cash">
              <Wallet className="size-4" />
              小口現金
            </Link>
          </Button>
        </div>
      </div>

      {/* スタッフからの問い合わせ（LINEを見落としてもここから追えるようにする） */}
      <InquiryList />

      {/* 未完了の申請を、担当が代わりに完了させる */}
      <CompletePendingDialog
        target={completeTarget}
        onClose={() => setCompleteTarget(null)}
        onDone={() => {
          fetchPending()
          fetchData()
        }}
      />

      {/* 申請が見つからないときに、隠れている申請と理由を出す */}
      <ReceiptDiagnose
        onChanged={() => {
          fetchPending()
          fetchData()
        }}
      />

      {/* 絞り込み */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">絞り込み</CardTitle>
          <CardDescription>
            期間の基準日は「提出日（20日締めの月割りに使う日付）」が既定です。
            提出日ベースの集計は、会計士向け立替明細CSV・/mkadmin の立替まとめと同じ基準日です。
            <br />
            「提出月」は税理士提出フォルダの振り分け先（前月21日〜当月20日提出分＝当月。手動指定があればそちらが優先）で、
            会計士向け立替明細CSVもこの提出月で集計します。同じ月のフォルダの中身とCSVの中身が一致します。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1">
              <Label className="text-xs">期間の基準日</Label>
              <Select value={basis} onValueChange={(v) => setBasis(v as typeof basis)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="submit">提出日</SelectItem>
                  <SelectItem value="application">申請日</SelectItem>
                  <SelectItem value="payment">支払年月日</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="start">
                開始日
              </Label>
              <Input id="start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="end">
                終了日
              </Label>
              <Input id="end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">スタッフ</Label>
              <Select value={staffMemberId} onValueChange={setStaffMemberId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>すべて</SelectItem>
                  {(data?.staffOptions ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="submissionMonth">
                提出月
              </Label>
              <Input
                id="submissionMonth"
                type="month"
                value={submissionMonthFilter}
                onChange={(e) => setSubmissionMonthFilter(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">費用区分</Label>
              <Select value={expenseDetail} onValueChange={setExpenseDetail}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>すべて</SelectItem>
                  {(data?.detailOptions ?? STAFF_EXPENSE_DETAILS.map((d) => d.fullLabel)).map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const r = currentMonthRange()
                setStart(r.start)
                setEnd(r.end)
              }}
            >
              今月
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStart("")
                setEnd("")
              }}
            >
              全期間
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 合計 */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs text-muted-foreground">件数</div>
            <div className="text-2xl font-bold">{totals.count}件</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs text-muted-foreground">立替額 合計</div>
            <div className="text-2xl font-bold">{yen(totals.totalAmount)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs text-muted-foreground">支給額 合計</div>
            <div className="text-2xl font-bold">{yen(totals.totalSubsidy)}</div>
          </CardContent>
        </Card>
      </div>

      {/*
        今月の状況。担当がこの画面だけを見れば済むようにする。
        複数の画面を見に行く運用は確認もれにつながるため、
        「締めまであと何日か」「残っている対応は何件か」をここに集める。
      */}
      <Card className={pending.length > 0 ? "border-amber-500/60" : undefined}>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">今月の状況</p>
              <p className="mt-0.5 text-xs" style={{ color: "var(--muted-foreground)" }}>
                {closingInfo.label}
                　（毎月20日締め。確定した分がその月のお給与に入ります）
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <div className="text-center">
                <div className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                  要対応
                </div>
                <div
                  className="text-2xl font-bold"
                  style={{ color: pending.length > 0 ? "#dc2626" : undefined }}
                >
                  {pending.length}件
                </div>
              </div>
              <div className="text-center">
                <div className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                  未確認
                </div>
                <div className="text-2xl font-bold">{data?.totals.unreviewedCount ?? 0}件</div>
              </div>
              <div className="text-center">
                <div className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                  確定済み
                </div>
                <div className="text-2xl font-bold">{Math.max(0, totals.count - pending.length)}件</div>
              </div>
            </div>
          </div>
          <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
            <strong>やること</strong>は2つだけです。
            ① 下の「要対応」をゼロにする（承認・確認）
            ② 明細の「確認」にチェックを入れる（内容を見た印）。
            <strong>要対応が残っていると、その分はその月のお給与に入りません。</strong>
          </p>
        </CardContent>
      </Card>

      {/* 要対応：上限超過の承認・講座の確認・添付待ち・未完了の申請を1か所に集める */}
      {pending.length > 0 && (
        <Card className="border-amber-500/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <AlertTriangle className="size-4 text-amber-600" />
              要対応
              <Badge className="bg-red-600 text-white hover:bg-red-600">{pending.length} 件</Badge>
            </CardTitle>
            <CardDescription>
              支給額が確定していない申請です。<strong>確定するまで税理士提出リストに載りません。</strong>
              放置するとスタッフへの支給が遅れます。
              <br />
              「未完了」は承認・却下がないため、本人に確認して処理し終えたものは
              <strong>「対応済みにして隠す」</strong>で画面から外せます（支給は作られません）。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {/* 既定で開く。押さないと行が見えないのは分かりにくい */}
              <Button variant="outline" size="sm" onClick={() => setShowPending((v) => !v)}>
                {showPending ? "一覧を閉じる" : `一覧を開く（${pending.length}件）`}
              </Button>
              {/* 未完了は確定操作が無いため、処理し終えたものをまとめて外せるようにする */}
              {pending.filter((p) => p.kind === "incomplete").length > 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={approvingId === "__bulk__"}
                  onClick={() => dismissIncomplete(pending.filter((p) => p.kind === "incomplete"))}
                >
                  {approvingId === "__bulk__" && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                  未完了 {pending.filter((p) => p.kind === "incomplete").length}件をまとめて対応済みにする
                </Button>
              )}
            </div>
            {showPending && (
              <div className="mt-3 flex flex-col gap-3">
                {/* 何がどれだけ残っているかを先に見せる（13件並ぶと全体が掴めない） */}
                <div className="rounded-lg border bg-muted/40 p-3">
                  <p className="text-sm font-medium">残っているもの</p>
                  <ul className="mt-1.5 space-y-1">
                    {(
                      Object.entries(
                        pending.reduce<Record<string, number>>((acc, p) => {
                          acc[p.kind] = (acc[p.kind] ?? 0) + 1
                          return acc
                        }, {})
                      ) as [PendingItem["kind"], number][]
                    ).map(([kind, count]) => (
                      <li key={kind} className="text-xs leading-relaxed">
                        <strong>
                          {PENDING_LABELS[kind]} {count}件
                        </strong>
                        ／{PENDING_HELP[kind]}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-muted-foreground">
                    下の一覧を<strong>上から順に</strong>処理してください。
                    各行の右側（スマホでは行の下）にボタンがあります。
                  </p>
                </div>
                {pending.map((p, pIndex) => (
                  <div
                    key={`${p.kind}-${p.id}`}
                    className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-muted-foreground">
                          {pIndex + 1}/{pending.length}
                        </span>
                        <Badge
                          variant="outline"
                          className={
                            p.kind === "excess"
                              ? "border-amber-500 text-amber-700 dark:text-amber-400"
                              : p.kind === "incomplete"
                                ? "border-red-500 text-red-700 dark:text-red-400"
                                : "border-blue-500 text-blue-700 dark:text-blue-400"
                          }
                        >
                          {PENDING_LABELS[p.kind]}
                        </Badge>
                        {/* 印が残っていると支給されないため、はっきり見せる */}
                        {p.testMarked && (
                          <Badge
                            variant="outline"
                            className="border-red-500 text-red-700 dark:text-red-400"
                          >
                            テストの印あり・支給対象外
                          </Badge>
                        )}
                        <span className="text-sm font-medium">{p.staffName}</span>
                        {p.courseName && (
                          <span className="text-sm" style={{ color: "var(--muted-foreground)" }}>
                            ／{p.courseName}
                          </span>
                        )}
                        <span className="text-sm" style={{ color: "var(--muted-foreground)" }}>
                          ／{p.itemLabel}
                        </span>
                        <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                          {p.daysWaiting > 0 ? `${p.daysWaiting}日経過` : "本日"}
                        </span>
                      </div>

                      <div className="mt-1.5 text-sm">
                        領収書 <strong>{yen(p.amount)}</strong>
                        {p.excess > 0 && (
                          <>
                            {" "}
                            ／ 上限超過{" "}
                            <strong className="text-amber-700 dark:text-amber-400">{yen(p.excess)}</strong>
                          </>
                        )}
                      </div>

                      <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
                        {PENDING_HELP[p.kind]}
                        {p.kind === "excess" && p.isRepeat && "（2回目以降のため超過分も半額が規程どおりです）"}
                      </p>

                      {/* なぜこの金額になったか（上限 → 残枠 → 支給率 → 支給額 → 超過分）。
                          枠の使用額が分からないと、何を承認するのか判断できないため出す */}
                      {p.calcNote && p.calcNote.length > 0 && (
                        <div className="mt-2 rounded-md border bg-muted/40 px-2.5 py-2">
                          <p className="text-xs font-medium">支給額の計算</p>
                          <ul className="mt-1 space-y-0.5">
                            {p.calcNote.map((line, i) => (
                              <li
                                key={i}
                                className="text-xs leading-relaxed"
                                style={{ color: "var(--muted-foreground)" }}
                              >
                                {line}
                              </li>
                            ))}
                          </ul>
                          {p.kind === "excess" && (
                            <p className="mt-1.5 text-xs" style={{ color: "var(--muted-foreground)" }}>
                              交通費・宿泊費は講座ごとに累計し、再受講の枠は
                              受講料の領収書の日付を区切りに自動で数え直します。
                              同じ受講の分が別々に数えられている場合は、
                              「スタッフ」タブの「交通費・宿泊費の枠」で数え直してから承認してください。
                            </p>
                          )}
                        </div>
                      )}

                      {/* 本人に聞かないと進まないことが多いため、ここから直接連絡できるようにする */}
                      {p.staffMemberId && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-1.5 h-7 px-2 text-xs"
                          onClick={() =>
                            setNotifyTarget({ id: p.staffMemberId!, name: p.staffName })
                          }
                        >
                          <MessageCircle className="mr-1 size-3.5" />
                          {p.staffName}さんにLINEで連絡
                        </Button>
                      )}
                    </div>

                    {/* 定期券区間の確認。含まれていなければそのまま確定できる */}
                    {(p.kind === "pass" || p.kind === "detail" || p.kind === "dup") && (
                      <div className="flex flex-col gap-2 sm:w-64 sm:shrink-0">
                        <Button
                          size="sm"
                          disabled={approvingId === p.id}
                          onClick={() => {
                            if (
                              !confirm(
                                `${p.staffName}さんの ${p.itemLabel} ${yen(p.amount)} を、この金額のまま確定します。\n\n` +
                                  (p.kind === "pass"
                                    ? "定期券区間が含まれていないことを確認してから押してください。"
                                    : p.kind === "dup"
                                      ? "同じ領収書の重複でないことを確認してから押してください。"
                                      : "内容を確認してから押してください。") +
                                  "\n\nよろしいですか？"
                              )
                            ) {
                              return
                            }
                            approveExcess(p, true, 0)
                          }}
                        >
                          {approvingId === p.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Check className="size-3.5" />
                          )}
                          このまま確定する
                        </Button>
                        <p className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                          金額を変える場合は、下の明細で直してから確定してください。
                        </p>
                      </div>
                    )}

                    {/* 未完了は承認・却下が無いため、対応済みにして画面から外せるようにする */}
                    {(p.kind === "incomplete" || p.kind === "help") && (
                      <div className="flex flex-col gap-2 sm:w-64 sm:shrink-0">
                        {/* テストの印が残っていると支給されない。ここで外せるようにする */}
                        {p.testMarked && (
                          <Button
                            size="sm"
                            disabled={approvingId === p.id}
                            onClick={() => clearTestMark(p)}
                          >
                            {approvingId === p.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Check className="size-3.5" />
                            )}
                            テストの印を外す
                          </Button>
                        )}
                        {p.kind === "incomplete" && (
                          <Button
                            size="sm"
                            onClick={() =>
                              setCompleteTarget({
                                id: p.id,
                                staffName: p.staffName,
                                amount: p.amount,
                                storeName: p.storeName ?? null,
                                date: p.paymentDate ?? null,
                              })
                            }
                          >
                            <Check className="size-3.5" />
                            担当が代わりに登録
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={approvingId === p.id}
                          onClick={() => dismissIncomplete([p])}
                        >
                          {approvingId === p.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Check className="size-3.5" />
                          )}
                          対応済みにして隠す
                        </Button>
                      </div>
                    )}

                    {/* 上限超過だけがこの画面で確定できる。既定はワンクリック（入力なし） */}
                    {p.kind === "excess" && (
                      <div className="flex flex-col gap-2 sm:w-64 sm:shrink-0">
                        {customAmountFor?.id === p.id ? (
                          <div className="flex flex-col gap-2">
                            <label className="text-xs font-medium" htmlFor={`amt-${p.id}`}>
                              追加支給額（0〜{p.excess.toLocaleString("ja-JP")}円）
                            </label>
                            <Input
                              id={`amt-${p.id}`}
                              type="number"
                              min={0}
                              max={p.excess}
                              value={customAmount}
                              onChange={(e) => setCustomAmount(e.target.value)}
                            />
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                disabled={approvingId === p.id || customAmount === ""}
                                onClick={() => approveExcess(p, true, Number(customAmount))}
                              >
                                この金額で承認
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setCustomAmountFor(null)
                                  setCustomAmount("")
                                }}
                              >
                                やめる
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              disabled={approvingId === p.id}
                              onClick={() => approveExcess(p, true)}
                            >
                              {approvingId === p.id ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Check className="size-3.5" />
                              )}
                              {yen(p.suggested)} を追加して承認
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={approvingId === p.id}
                              onClick={() => {
                                setCustomAmountFor(p)
                                setCustomAmount(String(p.suggested))
                              }}
                            >
                              金額を指定して承認
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={approvingId === p.id}
                              onClick={() => approveExcess(p, false)}
                            >
                              承認しない
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 明細 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            明細（1件1行）
            {data && data.totals.unreviewedCount > 0 && (
              <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
                未確認 {data.totals.unreviewedCount} 件
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            列見出しをクリックで並べ替えできます（空欄は常に末尾）。
            同じ資料から分割登録された行には「分割 n/N」が付きます。
            「確認」列は担当の進捗管理用で、支給額や税理士提出には影響しません。
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {selectedReceiptIds.size > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-4 py-2.5">
              <span className="text-sm font-medium">{selectedReceiptIds.size}件選択中</span>
              <Button variant="ghost" size="sm" onClick={() => setSelectedReceiptIds(new Set())}>
                選択を解除
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={isSavingSubmissionMonth}
                onClick={() => {
                  setSubmissionMonthResult(null)
                  setSubmissionMonthInput("")
                  setShowSubmissionMonthModal(true)
                }}
              >
                提出月を変更
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  toggleReview(
                    sortedRows
                      .filter((r) => r.receiptId && selectedReceiptIds.has(r.receiptId) && !r.reviewedAt)
                      .map((r) => r.transactionId),
                    true
                  )
                }
              >
                <Check className="size-3.5" />
                確認済みにする
              </Button>
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="mr-2 size-5 animate-spin" />
              読み込み中...
            </div>
          ) : sortedRows.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              条件に一致するスタッフ立替はありません
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      aria-label="すべて選択"
                      checked={
                        selectableRows.length > 0 && selectedReceiptIds.size === selectableRows.length
                      }
                      onCheckedChange={(v) =>
                        setSelectedReceiptIds(
                          v ? new Set(selectableRows.map((r) => r.receiptId as string)) : new Set()
                        )
                      }
                    />
                  </TableHead>
                  {/* 確認列は担当が毎日使うため、横スクロールせずに見える先頭に置く */}
                  <TableHead className="whitespace-nowrap">確認</TableHead>
                  {COLUMNS.map((c) => (
                    <TableHead
                      key={c.key}
                      className={`cursor-pointer select-none whitespace-nowrap ${c.className ?? ""}`}
                      onClick={() => toggleSort(c.key)}
                    >
                      <span className="inline-flex items-center gap-1">
                        {c.label}
                        {sortKey === c.key ? (
                          sortDir === "asc" ? (
                            <ArrowUp className="size-3" />
                          ) : (
                            <ArrowDown className="size-3" />
                          )
                        ) : (
                          <ArrowUpDown className="size-3 opacity-30" />
                        )}
                      </span>
                    </TableHead>
                  ))}
                  <TableHead className="whitespace-nowrap">分割</TableHead>
                  <TableHead className="whitespace-nowrap">資料</TableHead>
                  <TableHead className="whitespace-nowrap">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedRows.map((r) => (
                  <TableRow key={r.transactionId}>
                    <TableCell className="w-8">
                      <Checkbox
                        aria-label="この行を選択"
                        disabled={!r.receiptId}
                        checked={!!r.receiptId && selectedReceiptIds.has(r.receiptId)}
                        onCheckedChange={() => {
                          if (!r.receiptId) return
                          setSelectedReceiptIds((prev) => {
                            const next = new Set(prev)
                            if (next.has(r.receiptId as string)) next.delete(r.receiptId as string)
                            else next.add(r.receiptId as string)
                            return next
                          })
                        }}
                      />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Button
                        variant={r.reviewedAt ? "ghost" : "outline"}
                        size="sm"
                        disabled={savingReviewIds.has(r.transactionId)}
                        onClick={() => toggleReview([r.transactionId], !r.reviewedAt)}
                        title={
                          r.reviewedAt
                            ? `${r.reviewedBy || "担当"} が確認済み（${formatReviewedAt(r.reviewedAt)}）。クリックで取り消し`
                            : "内容を確認したらクリック"
                        }
                        className={
                          r.reviewedAt
                            ? "text-emerald-700 dark:text-emerald-400"
                            : "border-amber-500 text-amber-700 dark:text-amber-400"
                        }
                      >
                        {savingReviewIds.has(r.transactionId) ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : r.reviewedAt ? (
                          <>
                            <Check className="size-3.5" />
                            確認済み
                          </>
                        ) : (
                          "未確認"
                        )}
                      </Button>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{r.applicationDate || "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">{r.submitDate || "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {r.submissionMonth ? (
                        <span className="inline-flex items-center gap-1">
                          {r.submissionMonth}
                          {r.submissionMonthManual && (
                            <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                              手動
                            </Badge>
                          )}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{r.paymentDate || "—"}</TableCell>
                    <TableCell className="whitespace-nowrap font-medium">{r.staffName}</TableCell>
                    <TableCell className="max-w-[200px] truncate" title={r.storeName}>
                      {r.storeName}
                    </TableCell>
                    <TableCell className="max-w-[240px] truncate" title={r.expenseDetail}>
                      {r.expenseDetail}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">{yen(r.amount)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Badge variant={r.isHalf ? "secondary" : "outline"}>
                        {r.isHalf ? "半額" : "全額"}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-medium">
                      {yen(r.subsidy)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Badge variant="outline">{SOURCE_LABELS[r.source]}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {r.splitTotal > 1 ? (
                        <Badge
                          variant="secondary"
                          title={`同じ資料（${r.fileName}）から${r.splitTotal}件に分割登録されています`}
                        >
                          分割 {r.splitIndex}/{r.splitTotal}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {r.hasFile && r.receiptId ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openFile(r)}
                          title="登録された資料を表示（画像・PDFはプレビュー、その他はDropboxで開く）"
                        >
                          <FileText className="size-3.5" />
                          資料
                        </Button>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground/50"
                          title="資料なし（領収書が登録されていません）"
                        >
                          <FileText className="size-3" />
                          資料なし
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!r.receiptId}
                          title={
                            r.receiptId
                              ? "この立替を編集する"
                              : "領収書レコードが無いため編集できません（小口現金画面から修正してください）"
                          }
                          onClick={() => setEditRow(r)}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!r.receiptId}
                          title={
                            r.receiptId
                              ? "この立替を削除する"
                              : "領収書レコードが無いため削除できません（小口現金画面から修正してください）"
                          }
                          onClick={() => setDeleteRow(r)}
                        >
                          <Trash2 className="size-3.5 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* スタッフ別小計 */}
      {(data?.subtotals.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">スタッフ別 小計</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>スタッフ名</TableHead>
                  <TableHead className="text-right">件数</TableHead>
                  <TableHead className="text-right">立替額</TableHead>
                  <TableHead className="text-right">支給額</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.subtotals ?? []).map((s) => (
                  <TableRow key={s.staffMemberId ?? "__unknown__"}>
                    <TableCell className="font-medium">{s.staffName}</TableCell>
                    <TableCell className="text-right">{s.count}件</TableCell>
                    <TableCell className="text-right">{yen(s.totalAmount)}</TableCell>
                    <TableCell className="text-right font-medium">{yen(s.totalSubsidy)}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell className="font-bold">合計</TableCell>
                  <TableCell className="text-right font-bold">{totals.count}件</TableCell>
                  <TableCell className="text-right font-bold">{yen(totals.totalAmount)}</TableCell>
                  <TableCell className="text-right font-bold">{yen(totals.totalSubsidy)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* 提出月の一括変更 */}
      {showSubmissionMonthModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-lg border bg-background p-5 shadow-lg">
            <h2 className="text-base font-semibold">提出月を変更</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              税理士提出フォルダの振り分け先を手動で指定します。指定した月が自動判定（提出日の20日締め）より優先されます。
            </p>

            {!submissionMonthResult ? (
              <>
                <div className="mt-4 flex items-center gap-2">
                  <Input
                    type="month"
                    value={submissionMonthInput}
                    onChange={(e) => setSubmissionMonthInput(e.target.value)}
                    className="w-[180px]"
                  />
                  <span className="text-sm text-muted-foreground">
                    {selectedReceiptIds.size}件に適用します
                  </span>
                </div>
                <div className="mt-5 flex flex-wrap justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowSubmissionMonthModal(false)}
                    disabled={isSavingSubmissionMonth}
                  >
                    閉じる
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void applySubmissionMonth(null)}
                    disabled={isSavingSubmissionMonth}
                  >
                    手動指定を解除（自動判定に戻す）
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void applySubmissionMonth(submissionMonthInput)}
                    disabled={isSavingSubmissionMonth || !submissionMonthInput}
                  >
                    {isSavingSubmissionMonth && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                    この月に変更
                  </Button>
                </div>
              </>
            ) : (
              <div className="mt-4 space-y-3 text-sm">
                <p>
                  ✅ {submissionMonthResult.updated}件の提出月を
                  {submissionMonthResult.month ? `「${submissionMonthResult.month}」に変更` : "自動判定に戻"}しました。
                  次回の税理士フォルダコピーから反映されます。
                </p>
                {submissionMonthResult.leftoverFiles.length > 0 && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900">
                    <p className="font-medium">
                      ⚠️ 変更前の月フォルダに、コピー済みのファイルが
                      {submissionMonthResult.leftoverFiles.length}件残っています
                    </p>
                    <p className="mt-1 text-xs">
                      このままだと同じ資料が2ヶ月分の提出物に現れます。Dropboxで下記のファイルを手動で削除（または移動）してください。
                      安全のため、アプリからは自動で削除・移動しません。
                    </p>
                    <ul className="mt-2 space-y-0.5 text-xs">
                      {submissionMonthResult.leftoverFiles.map((f) => (
                        <li key={`${f.id}-${f.path}`} className="break-all">
                          {f.fromMonthLabel}：{f.path}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="flex justify-end">
                  <Button size="sm" onClick={() => setShowSubmissionMonthModal(false)}>
                    閉じる
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <FilePreviewModal target={previewTarget} onClose={() => setPreviewTarget(null)} />
      <EditDialog row={editRow} onClose={() => setEditRow(null)} onSaved={fetchData} />
      <DeleteDialog row={deleteRow} onClose={() => setDeleteRow(null)} onDeleted={fetchData} />
      {/* 担当からスタッフへのLINE連絡（要対応の行から開く） */}
      <NotifyStaffDialog
        open={!!notifyTarget}
        onOpenChange={(v) => !v && setNotifyTarget(null)}
        staffMemberId={notifyTarget?.id ?? null}
        staffName={notifyTarget?.name ?? ""}
      />
    </div>
  )
}

/** ソート用の値を取り出す */
function valueOf(r: Row, key: SortKey): string | number {
  switch (key) {
    case "submissionMonth":
      return r.submissionMonth
    case "amount":
      return r.amount
    case "subsidy":
      return r.subsidy
    case "isHalf":
      return r.isHalf ? "半額" : "全額"
    case "source":
      return SOURCE_LABELS[r.source]
    default:
      return r[key]
  }
}

/* ---------- 編集ダイアログ（既存の手動登録の編集処理を再利用） ---------- */

function EditDialog({
  row,
  onClose,
  onSaved,
}: {
  row: Row | null
  onClose: () => void
  onSaved: () => void
}) {
  const [storeName, setStoreName] = useState("")
  const [amount, setAmount] = useState("")
  const [paymentDate, setPaymentDate] = useState("")
  const [submitDate, setSubmitDate] = useState("")
  const [detailKey, setDetailKey] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (!row) return
    setStoreName(row.storeName === "不明" ? "" : row.storeName)
    setAmount(String(row.amount))
    setPaymentDate(row.paymentDate)
    setSubmitDate(row.submitDate)
    setDetailKey(row.detailKey)
  }, [row])

  async function save() {
    if (!row?.receiptId) return
    const amountNum = Number(amount)
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      toast.error("金額を正しく入力してください")
      return
    }
    if (!detailKey) {
      toast.error("費用区分を選択してください")
      return
    }
    setIsSaving(true)
    try {
      const res = await fetch("/api/staff-refund/manual-entry", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          receiptId: row.receiptId,
          storeName,
          amount: amountNum,
          paymentDate,
          submitDate,
          detailKey,
        }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || "保存に失敗しました")
      toast.success("保存しました")
      onClose()
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存に失敗しました")
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={!!row} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>スタッフ立替の編集</DialogTitle>
          <DialogDescription>
            {row?.staffName}
            {row && row.splitTotal > 1 ? `／分割 ${row.splitIndex}/${row.splitTotal}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1">
            <Label htmlFor="edit-store">支払先（店名）</Label>
            <Input id="edit-store" value={storeName} onChange={(e) => setStoreName(e.target.value)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="edit-amount">立替額</Label>
              <Input
                id="edit-amount"
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>費用区分</Label>
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
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="edit-payment">支払年月日</Label>
              <Input
                id="edit-payment"
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-submit">提出日（20日締めの判定に使用）</Label>
              <Input
                id="edit-submit"
                type="date"
                value={submitDate}
                onChange={(e) => setSubmitDate(e.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            キャンセル
          </Button>
          <Button onClick={save} disabled={isSaving}>
            {isSaving && <Loader2 className="size-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ---------- 削除ダイアログ ---------- */

function DeleteDialog({
  row,
  onClose,
  onDeleted,
}: {
  row: Row | null
  onClose: () => void
  onDeleted: () => void
}) {
  const [isDeleting, setIsDeleting] = useState(false)

  async function remove() {
    if (!row?.receiptId) return
    setIsDeleting(true)
    try {
      const res = await fetch(
        `/api/staff-refund/manual-entry?receiptId=${encodeURIComponent(row.receiptId)}`,
        { method: "DELETE" }
      )
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || "削除に失敗しました")
      toast.success("削除しました")
      onClose()
      onDeleted()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除に失敗しました")
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <Dialog open={!!row} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>この立替を削除しますか？</DialogTitle>
          <DialogDescription>
            {row?.staffName}／{row?.storeName}／{row ? yen(row.amount) : ""}
            {row && row.splitTotal > 1
              ? `（分割 ${row.splitIndex}/${row.splitTotal}。この1件だけが削除され、同じ資料の他の行は残ります）`
              : ""}
            <br />
            精算取引と領収書レコードを削除します。Dropbox上の実ファイルは残ります。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isDeleting}>
            キャンセル
          </Button>
          <Button variant="destructive" onClick={remove} disabled={isDeleting}>
            {isDeleting && <Loader2 className="size-4 animate-spin" />}
            削除する
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
