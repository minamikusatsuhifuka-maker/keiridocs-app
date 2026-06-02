"use client"

import { useState, useEffect, useMemo, useRef, Suspense } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Loader2,
  Plus,
  AlertTriangle,
  Wallet,
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  Stethoscope,
  UserRound,
  FileDown,
} from "lucide-react"
import { toast } from "sonner"
import { PatientResponseModal } from "@/components/petty-cash/PatientResponseModal"
import { StaffRefundModal } from "@/components/petty-cash/StaffRefundModal"
import { PayrollRefundPanel } from "@/components/petty-cash/PayrollRefundPanel"

// 残高に影響しない精算方法（給与返金・保管のみ）
const NON_CASH_SETTLEMENTS = new Set(["payroll", "storage_only"])
// 残高計算でこの取引が現金を動かさないか判定
const isNonCashTx = (tx: { settlement_method?: string | null }): boolean =>
  tx.settlement_method != null && NON_CASH_SETTLEMENTS.has(tx.settlement_method)

interface PettyCashTransaction {
  id: string
  type: string
  amount: number
  description: string | null
  staff_member_id: string | null
  registered_by: string | null
  created_at: string
  // 023マイグレーションで追加
  category?: string | null
  subcategory?: string | null
  note?: string | null
  created_by?: string | null
  transaction_date?: string | null
  balance_after?: number | null
  receipt_urls?: string[] | null
  // 024マイグレーションで追加
  settlement_method?: string | null
  payroll_refund_status?: string | null
}

interface StaffMember {
  id: string
  name: string
}

function getYearOptions(): string[] {
  const now = new Date()
  const years: string[] = []
  for (let y = now.getFullYear(); y >= now.getFullYear() - 3; y--) {
    years.push(String(y))
  }
  return years
}

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => String(i + 1))

const categoryLabel = (c: string | null | undefined, fallbackType: string): string => {
  if (c === "patient_response") return "患者対応"
  if (c === "staff_refund") return "スタッフ返金"
  if (c === "cash_in") return "入金"
  if (c === "other") return "その他"
  return fallbackType
}

const subLabel = (s: string | null | undefined): string =>
  s === "insurance_refund"
    ? "保険診療返金"
    : s === "self_pay_refund"
    ? "自費診療返金"
    : s === "other"
    ? "その他"
    : ""

// 精算方法のサブラベル（給与返金は返金状態も併記）
const settlementLabel = (
  method: string | null | undefined,
  payrollStatus: string | null | undefined
): string => {
  if (method === "payroll") {
    return payrollStatus === "done" ? "給与返金（返金済み）" : "給与返金（返金待ち）"
  }
  if (method === "storage_only") return "保管のみ"
  return ""
}

const categoryBadgeClass = (c: string | null | undefined, type: string): string => {
  if (c === "patient_response") return "bg-sky-100 text-sky-700 hover:bg-sky-100"
  if (c === "staff_refund") return "bg-pink-100 text-pink-700 hover:bg-pink-100"
  if (c === "cash_in" || type === "入金") return "bg-emerald-100 text-emerald-700 hover:bg-emerald-100"
  if (type === "返金") return "bg-blue-100 text-blue-700 hover:bg-blue-100"
  return "bg-red-100 text-red-700 hover:bg-red-100"
}

function PettyCashPageInner() {
  const searchParams = useSearchParams()
  const router = useRouter()

  const [balance, setBalance] = useState(0)
  const [transactions, setTransactions] = useState<PettyCashTransaction[]>([])
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const [selectedYear, setSelectedYear] = useState(String(new Date().getFullYear()))
  const [selectedMonth, setSelectedMonth] = useState(String(new Date().getMonth() + 1))

  // ダイアログ表示状態
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [showPatientDialog, setShowPatientDialog] = useState(false)
  const [showStaffDialog, setShowStaffDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // 給与返金パネルの再取得トリガー
  const [payrollReloadKey, setPayrollReloadKey] = useState(0)

  // 入金フォーム
  const [addAmount, setAddAmount] = useState("")
  const [addMemo, setAddMemo] = useState("")

  // インポートフォーム
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importLoading, setImportLoading] = useState(false)
  const [importPreview, setImportPreview] = useState<{
    headers: string[]
    mapping: Record<string, unknown>
    total_rows: number
    mapped_rows: Array<{
      date: string | null
      type: string
      amount: number
      description: string | null
      staff: string | null
    }>
    preview: unknown[]
  } | null>(null)
  const importFileInputRef = useRef<HTMLInputElement>(null)

  // データ取得
  const fetchData = async () => {
    setIsLoading(true)
    try {
      const params = new URLSearchParams()
      if (selectedYear) params.set("year", selectedYear)
      if (selectedMonth) params.set("month", selectedMonth)

      const res = await fetch(`/api/petty-cash?${params.toString()}`)
      if (!res.ok) throw new Error("取得失敗")
      const json = await res.json() as { balance: number; transactions: PettyCashTransaction[] }
      setBalance(json.balance)
      setTransactions(json.transactions)
    } catch {
      toast.error("小口現金データの取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    async function fetchStaff() {
      try {
        const res = await fetch("/api/staff-members")
        if (!res.ok) return
        const json = await res.json() as { data: StaffMember[] }
        setStaffMembers(json.data || [])
      } catch {
        // ignore
      }
    }
    fetchStaff()
  }, [])

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYear, selectedMonth])

  // 書類登録ページのリンク（?action=staff-refund）からの自動起動
  useEffect(() => {
    if (searchParams.get("action") === "staff-refund") {
      setShowStaffDialog(true)
      // クエリを消して履歴をきれいにする（リロード時の再オープン防止）
      router.replace("/petty-cash")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // スタッフ名マップ
  const staffNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of staffMembers) m.set(s.id, s.name)
    return m
  }, [staffMembers])

  // 残高付き取引リスト
  const transactionsWithBalance = useMemo(() => {
    const sorted = [...transactions].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )

    // 月初残高を逆算（給与返金・保管のみは現金が動かないので残高計算から除外）
    let runningBalance = balance
    for (let i = sorted.length - 1; i >= 0; i--) {
      const tx = sorted[i]
      if (isNonCashTx(tx)) continue
      if (tx.type === "入金" || tx.type === "返金") {
        runningBalance -= tx.amount
      } else {
        runningBalance += tx.amount
      }
    }

    const result: (PettyCashTransaction & { runningBalance: number })[] = []
    for (const tx of sorted) {
      if (!isNonCashTx(tx)) {
        if (tx.type === "入金" || tx.type === "返金") {
          runningBalance += tx.amount
        } else {
          runningBalance -= tx.amount
        }
      }
      result.push({ ...tx, runningBalance })
    }
    return result.reverse()
  }, [transactions, balance])

  // 入金登録
  const handleAdd = async () => {
    const amount = parseInt(addAmount)
    if (!amount || amount <= 0) {
      toast.error("金額を正しく入力してください")
      return
    }

    setIsSubmitting(true)
    try {
      const res = await fetch("/api/petty-cash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "入金",
          amount,
          description: addMemo || "現金追加",
        }),
      })
      if (!res.ok) {
        const json = await res.json() as { error?: string }
        throw new Error(json.error || "登録に失敗しました")
      }
      toast.success(`¥${amount.toLocaleString()} を入金しました`)
      setShowAddDialog(false)
      setAddAmount("")
      setAddMemo("")
      fetchData()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "入金に失敗しました")
    } finally {
      setIsSubmitting(false)
    }
  }

  // インポートプレビュー
  const handleImportPreview = async () => {
    if (!importFile) {
      toast.error("ファイルを選択してください")
      return
    }

    setImportLoading(true)
    try {
      const formData = new FormData()
      formData.append("file", importFile)

      const res = await fetch("/api/petty-cash/import", {
        method: "PUT",
        body: formData,
      })

      if (!res.ok) {
        const json = await res.json() as { error?: string }
        throw new Error(json.error || "プレビューに失敗しました")
      }

      const json = await res.json() as typeof importPreview
      if (!json || json.mapped_rows.length === 0) {
        toast.error("登録可能な行が見つかりませんでした")
        return
      }
      setImportPreview(json)
      toast.success(`${json.mapped_rows.length}件の取引を検出しました`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "プレビューに失敗しました")
    } finally {
      setImportLoading(false)
    }
  }

  // インポート実行
  const handleImportExecute = async () => {
    if (!importPreview) return

    setImportLoading(true)
    try {
      const res = await fetch("/api/petty-cash/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: importPreview.mapped_rows }),
      })

      if (!res.ok) {
        const json = await res.json() as { error?: string }
        throw new Error(json.error || "インポートに失敗しました")
      }

      const json = await res.json() as { inserted: number; skipped: number; balance: number }
      toast.success(`インポート完了: ${json.inserted}件登録 / ${json.skipped}件スキップ`)
      setShowImportDialog(false)
      setImportFile(null)
      setImportPreview(null)
      if (importFileInputRef.current) importFileInputRef.current.value = ""
      fetchData()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "インポートに失敗しました")
    } finally {
      setImportLoading(false)
    }
  }

  // CSV出力
  const handleCsvExport = () => {
    window.location.href = `/api/petty-cash/export-csv?year=${selectedYear}&month=${selectedMonth}`
  }

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Wallet className="size-7" style={{ color: "var(--dusk-primary)" }} />
          <h1 className="text-2xl font-bold">小口現金管理</h1>
        </div>
        <Button onClick={handleCsvExport} variant="outline">
          <FileDown className="mr-2 size-4" />
          CSV出力
        </Button>
      </div>

      {/* 残高カード + アクションボタン */}
      <Card className="overflow-hidden">
        <div className="p-6" style={{ background: "var(--dusk-accent-gradient)" }}>
          <div className="text-white/80 text-sm font-medium mb-1">現在の残高</div>
          <div className="text-white text-4xl font-bold tabular-nums">
            ¥{balance.toLocaleString()}
          </div>
          {balance < 0 && (
            <Alert className="mt-4 border-red-200 bg-red-50">
              <AlertTriangle className="size-4 text-red-600" />
              <AlertDescription className="text-red-700 font-medium">
                残高がマイナスです。現金の補充が必要です。
              </AlertDescription>
            </Alert>
          )}
        </div>
        <CardContent className="pt-4">
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => setShowAddDialog(true)} className="btn-float-primary">
              <Plus className="mr-2 size-4" />
              現金を追加
            </Button>
            <Button onClick={() => setShowPatientDialog(true)} variant="outline">
              <Stethoscope className="mr-2 size-4" />
              患者対応
            </Button>
            <Button onClick={() => setShowStaffDialog(true)} variant="outline">
              <UserRound className="mr-2 size-4" />
              スタッフ返金
            </Button>
            <Button onClick={() => setShowImportDialog(true)} variant="outline">
              <Upload className="mr-2 size-4" />
              過去データをインポート
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 給与返金待ちの集計 */}
      <PayrollRefundPanel
        reloadKey={payrollReloadKey}
        onChanged={fetchData}
      />

      {/* 月フィルター */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">期間</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            <div className="space-y-1">
              <Label>年</Label>
              <Select value={selectedYear} onValueChange={setSelectedYear}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {getYearOptions().map((y) => (
                    <SelectItem key={y} value={y}>{y}年</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>月</Label>
              <Select value={selectedMonth} onValueChange={setSelectedMonth}>
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTH_OPTIONS.map((m) => (
                    <SelectItem key={m} value={m}>{m}月</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {transactions.length > 0 && (
        <div className="text-sm text-muted-foreground">
          {transactions.length}件の取引
        </div>
      )}

      {/* 出納帳テーブル */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : transactions.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              該当する取引がありません
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">日付</th>
                    <th className="px-4 py-3 text-left font-medium">種別</th>
                    <th className="px-4 py-3 text-left font-medium">内容</th>
                    <th className="px-4 py-3 text-left font-medium">スタッフ</th>
                    <th className="px-4 py-3 text-right font-medium">金額</th>
                    <th className="px-4 py-3 text-right font-medium">残高</th>
                    <th className="px-4 py-3 text-left font-medium">領収書</th>
                    <th className="px-4 py-3 text-left font-medium">登録者</th>
                  </tr>
                </thead>
                <tbody>
                  {transactionsWithBalance.map((tx) => {
                    const dateStr = tx.transaction_date
                      ? new Date(tx.transaction_date).toLocaleDateString("ja-JP")
                      : new Date(tx.created_at).toLocaleDateString("ja-JP")
                    const sub = subLabel(tx.subcategory)
                    const settleSub = settlementLabel(tx.settlement_method, tx.payroll_refund_status)
                    const nonCash = isNonCashTx(tx)
                    const staffName = tx.staff_member_id
                      ? staffNameById.get(tx.staff_member_id) ?? "—"
                      : "—"
                    const receiptCount = Array.isArray(tx.receipt_urls)
                      ? tx.receipt_urls.length
                      : 0
                    return (
                      <tr key={tx.id} className="border-b hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3 whitespace-nowrap">{dateStr}</td>
                        <td className="px-4 py-3">
                          <Badge className={categoryBadgeClass(tx.category, tx.type)}>
                            {categoryLabel(tx.category, tx.type)}
                          </Badge>
                          {sub && (
                            <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
                          )}
                          {settleSub && (
                            <div className="text-xs text-amber-600 mt-0.5">{settleSub}</div>
                          )}
                        </td>
                        <td className="px-4 py-3">{tx.note || tx.description || "—"}</td>
                        <td className="px-4 py-3">{staffName}</td>
                        <td className="px-4 py-3 text-right tabular-nums font-medium">
                          {nonCash ? (
                            // 給与返金・保管のみは現金が動かないため残高に影響しない表示
                            <span className="text-muted-foreground">¥{tx.amount.toLocaleString()}</span>
                          ) : (
                            <span className={tx.type === "出金" ? "text-red-600" : "text-emerald-600"}>
                              {tx.type === "出金" ? "-" : "+"}¥{tx.amount.toLocaleString()}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          <span className={tx.runningBalance < 0 ? "text-red-600 font-bold" : ""}>
                            ¥{tx.runningBalance.toLocaleString()}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {receiptCount > 0 ? `${receiptCount}件` : "—"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {tx.created_by || tx.registered_by || "—"}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 入金ダイアログ */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>現金を追加</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>金額（円）</Label>
              <Input
                type="number"
                placeholder="10000"
                value={addAmount}
                onChange={(e) => setAddAmount(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>メモ（任意）</Label>
              <Input
                placeholder="銀行引出、補充など"
                value={addMemo}
                onChange={(e) => setAddMemo(e.target.value)}
              />
            </div>
            {addAmount && parseInt(addAmount) > 0 && (
              <div className="text-sm text-muted-foreground">
                入金後の残高: <span className="font-bold text-foreground">¥{(balance + parseInt(addAmount)).toLocaleString()}</span>
              </div>
            )}
            <Button
              onClick={handleAdd}
              disabled={isSubmitting}
              className="w-full btn-float-primary"
            >
              {isSubmitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              入金登録
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 患者対応モーダル */}
      <PatientResponseModal
        open={showPatientDialog}
        onOpenChange={setShowPatientDialog}
        onSuccess={fetchData}
      />

      {/* スタッフ返金モーダル */}
      <StaffRefundModal
        open={showStaffDialog}
        onOpenChange={setShowStaffDialog}
        onSuccess={() => {
          fetchData()
          // 給与返金で登録された場合に集計パネルを更新
          setPayrollReloadKey((k) => k + 1)
        }}
      />

      {/* インポートダイアログ */}
      <Dialog
        open={showImportDialog}
        onOpenChange={(v) => {
          setShowImportDialog(v)
          if (!v) {
            setImportFile(null)
            setImportPreview(null)
            if (importFileInputRef.current) importFileInputRef.current.value = ""
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>過去データをインポート</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Excel(.xlsx)またはCSV(.csv)ファイルをアップロードすると、AIがカラムを自動判定して取引を一括登録します。
              日付・金額・内容が同じ取引はスキップされます。
            </p>

            {!importPreview && (
              <>
                <div className="space-y-2">
                  <Label>ファイル</Label>
                  <input
                    ref={importFileInputRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="block w-full text-sm text-muted-foreground
                      file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0
                      file:text-sm file:font-semibold file:bg-[var(--dusk-primary-light)]
                      file:text-[var(--dusk-primary)] hover:file:opacity-80"
                    onChange={(e) => {
                      setImportFile(e.target.files?.[0] || null)
                      setImportPreview(null)
                    }}
                  />
                </div>
                {importFile && (
                  <div className="text-sm text-muted-foreground flex items-center gap-2">
                    <FileSpreadsheet className="size-4" />
                    {importFile.name}（{(importFile.size / 1024).toFixed(0)} KB）
                  </div>
                )}
                <Button
                  onClick={handleImportPreview}
                  disabled={importLoading || !importFile}
                  className="w-full btn-float-primary"
                >
                  {importLoading ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      AI解析中...
                    </>
                  ) : (
                    <>
                      <Upload className="mr-2 size-4" />
                      AIで解析
                    </>
                  )}
                </Button>
              </>
            )}

            {importPreview && (
              <>
                <div className="rounded-md border p-3 text-sm">
                  <div className="font-medium mb-2">解析結果</div>
                  <div className="grid grid-cols-2 gap-2 text-muted-foreground">
                    <div>検出行数: {importPreview.mapped_rows.length}件</div>
                    <div>全行数: {importPreview.total_rows}件</div>
                  </div>
                  <div className="mt-2 text-xs">
                    カラムマッピング: {JSON.stringify(importPreview.mapping, null, 0)}
                  </div>
                </div>
                <div className="max-h-60 overflow-y-auto rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted">
                      <tr>
                        <th className="px-2 py-1 text-left">日付</th>
                        <th className="px-2 py-1 text-left">種別</th>
                        <th className="px-2 py-1 text-left">内容</th>
                        <th className="px-2 py-1 text-right">金額</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.mapped_rows.slice(0, 100).map((row, idx) => (
                        <tr key={idx} className="border-t">
                          <td className="px-2 py-1">{row.date ? new Date(row.date).toLocaleDateString("ja-JP") : "—"}</td>
                          <td className="px-2 py-1">{row.type}</td>
                          <td className="px-2 py-1">{row.description || "—"}</td>
                          <td className="px-2 py-1 text-right tabular-nums">¥{row.amount.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {importPreview.mapped_rows.length > 100 && (
                    <div className="px-2 py-1 text-xs text-muted-foreground border-t">
                      ...他 {importPreview.mapped_rows.length - 100} 件（登録時に全件処理されます）
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={() => setImportPreview(null)}
                    variant="outline"
                    className="flex-1"
                  >
                    やり直し
                  </Button>
                  <Button
                    onClick={handleImportExecute}
                    disabled={importLoading}
                    className="flex-1 btn-float-primary"
                  >
                    {importLoading ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        登録中...
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="mr-2 size-4" />
                        {importPreview.mapped_rows.length}件を登録
                      </>
                    )}
                  </Button>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// useSearchParams は Suspense 境界が必要なため、ラップして公開する
export default function PettyCashPage() {
  return (
    <Suspense fallback={null}>
      <PettyCashPageInner />
    </Suspense>
  )
}

