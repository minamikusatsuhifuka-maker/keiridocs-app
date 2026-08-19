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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
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
  paymentDate: string
  storeName: string
  expenseDetail: string
  detailKey: string
  amount: number
  isHalf: boolean
  subsidy: number
  source: ReimburseSource
  registeredBy: string
  hasFile: boolean
  fileName: string
  dropboxPath: string
  splitGroup: string | null
  splitIndex: number
  splitTotal: number
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
  totals: { count: number; totalAmount: number; totalSubsidy: number }
  periodLabel: string
  staffOptions: { id: string; name: string }[]
  detailOptions: string[]
}

/* ---------- 表示ヘルパー ---------- */

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`
const ALL = "__all__"

type SortKey =
  | "applicationDate"
  | "submitDate"
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

  const [data, setData] = useState<ApiResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  const [previewTarget, setPreviewTarget] = useState<FilePreviewTarget | null>(null)
  const [editRow, setEditRow] = useState<Row | null>(null)
  const [deleteRow, setDeleteRow] = useState<Row | null>(null)

  const query = useMemo(() => {
    const p = new URLSearchParams()
    p.set("basis", basis)
    if (start) p.set("start", start)
    if (end) p.set("end", end)
    if (staffMemberId !== ALL) p.set("staffMemberId", staffMemberId)
    if (expenseDetail !== ALL) p.set("expenseDetail", expenseDetail)
    return p.toString()
  }, [basis, start, end, staffMemberId, expenseDetail])

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

      {/* 絞り込み */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">絞り込み</CardTitle>
          <CardDescription>
            期間の基準日は「提出日（20日締めの月割りに使う日付）」が既定です。
            提出日ベースの集計は、会計士向け立替明細CSV・/mkadmin の立替まとめと同じ基準日です。
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

      {/* 明細 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">明細（1件1行）</CardTitle>
          <CardDescription>
            列見出しをクリックで並べ替えできます（空欄は常に末尾）。
            同じ資料から分割登録された行には「分割 n/N」が付きます。
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
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
                    <TableCell className="whitespace-nowrap">{r.applicationDate || "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">{r.submitDate || "—"}</TableCell>
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

      <FilePreviewModal target={previewTarget} onClose={() => setPreviewTarget(null)} />
      <EditDialog row={editRow} onClose={() => setEditRow(null)} onSaved={fetchData} />
      <DeleteDialog row={deleteRow} onClose={() => setDeleteRow(null)} onDeleted={fetchData} />
    </div>
  )
}

/** ソート用の値を取り出す */
function valueOf(r: Row, key: SortKey): string | number {
  switch (key) {
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
