"use client"

import { useState, useEffect, useMemo, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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
  Minus,
  Camera,
  Download,
  AlertTriangle,
  Wallet,
} from "lucide-react"
import { toast } from "sonner"

interface PettyCashTransaction {
  id: string
  type: string
  amount: number
  description: string | null
  staff_member_id: string | null
  staff_receipt_id: string | null
  document_id: string | null
  receipt_image_url: string | null
  dropbox_path: string | null
  registered_by: string | null
  created_at: string
}

interface StaffMember {
  id: string
  name: string
}

// 年の選択肢
function getYearOptions(): string[] {
  const now = new Date()
  const years: string[] = []
  for (let y = now.getFullYear(); y >= now.getFullYear() - 3; y--) {
    years.push(String(y))
  }
  return years
}

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => String(i + 1))

export default function PettyCashPage() {
  const [balance, setBalance] = useState(0)
  const [transactions, setTransactions] = useState<PettyCashTransaction[]>([])
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // フィルター
  const [selectedYear, setSelectedYear] = useState(String(new Date().getFullYear()))
  const [selectedMonth, setSelectedMonth] = useState(String(new Date().getMonth() + 1))

  // ダイアログ
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [showExpenseDialog, setShowExpenseDialog] = useState(false)
  const [showCameraDialog, setShowCameraDialog] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // 入金フォーム
  const [addAmount, setAddAmount] = useState("")
  const [addMemo, setAddMemo] = useState("")

  // 出金フォーム
  const [expenseAmount, setExpenseAmount] = useState("")
  const [expenseDescription, setExpenseDescription] = useState("")
  const [expenseStaffId, setExpenseStaffId] = useState("")

  // カメラフォーム
  const [cameraFile, setCameraFile] = useState<File | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  // スタッフ一覧取得
  useEffect(() => {
    async function fetchStaff() {
      try {
        const res = await fetch("/api/staff-members")
        if (!res.ok) return
        const json = await res.json() as { data: StaffMember[] }
        setStaffMembers(json.data || [])
      } catch {
        // スタッフ取得失敗は無視
      }
    }
    fetchStaff()
  }, [])

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYear, selectedMonth])

  // 残高付き取引リスト（累計残高を計算）
  const transactionsWithBalance = useMemo(() => {
    // created_at昇順でソートして残高を計算し、降順で表示
    const sorted = [...transactions].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )

    // 月初残高を逆算: 現在残高から今月の取引を逆にたどる
    let runningBalance = balance
    // 降順の取引から残高を逆算
    for (let i = sorted.length - 1; i >= 0; i--) {
      const tx = sorted[i]
      if (tx.type === "入金" || tx.type === "返金") {
        runningBalance -= tx.amount
      } else {
        runningBalance += tx.amount
      }
    }

    // 昇順で残高を再計算
    const result: (PettyCashTransaction & { runningBalance: number })[] = []
    for (const tx of sorted) {
      if (tx.type === "入金" || tx.type === "返金") {
        runningBalance += tx.amount
      } else {
        runningBalance -= tx.amount
      }
      result.push({ ...tx, runningBalance })
    }

    // 降順（新しい順）で表示
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

  // 出金登録
  const handleExpense = async () => {
    const amount = parseInt(expenseAmount)
    if (!amount || amount <= 0) {
      toast.error("金額を正しく入力してください")
      return
    }
    if (!expenseDescription) {
      toast.error("用途を入力してください")
      return
    }

    setIsSubmitting(true)
    try {
      const res = await fetch("/api/petty-cash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "出金",
          amount,
          description: expenseDescription,
          staff_member_id: expenseStaffId || undefined,
        }),
      })
      if (!res.ok) {
        const json = await res.json() as { error?: string }
        throw new Error(json.error || "登録に失敗しました")
      }
      toast.success(`¥${amount.toLocaleString()} を出金登録しました`)
      setShowExpenseDialog(false)
      setExpenseAmount("")
      setExpenseDescription("")
      setExpenseStaffId("")
      fetchData()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "出金に失敗しました")
    } finally {
      setIsSubmitting(false)
    }
  }

  // 写真から登録（Gemini AI解析）
  const handleCameraSubmit = async () => {
    if (!cameraFile) {
      toast.error("写真を選択してください")
      return
    }

    setIsAnalyzing(true)
    try {
      // ファイルをbase64変換
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = reader.result as string
          const commaIdx = result.indexOf(",")
          resolve(commaIdx >= 0 ? result.substring(commaIdx + 1) : result)
        }
        reader.onerror = reject
        reader.readAsDataURL(cameraFile)
      })

      // Gemini AI解析
      const geminiRes = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base64,
          mimeType: cameraFile.type,
        }),
      })

      if (!geminiRes.ok) throw new Error("AI解析に失敗しました")
      const ocrResult = await geminiRes.json() as {
        vendor_name?: string
        amount?: number
        description?: string
      }

      const amount = ocrResult.amount
      if (!amount || amount <= 0) {
        toast.error("金額を読み取れませんでした。手動で登録してください。")
        setIsAnalyzing(false)
        return
      }

      const description = ocrResult.vendor_name || ocrResult.description || "写真から登録"

      // 出金登録
      const res = await fetch("/api/petty-cash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "出金",
          amount,
          description: `📷 ${description}`,
        }),
      })

      if (!res.ok) {
        const json = await res.json() as { error?: string }
        throw new Error(json.error || "登録に失敗しました")
      }

      toast.success(`AI解析: ${description} / ¥${amount.toLocaleString()} を出金登録しました`)
      setShowCameraDialog(false)
      setCameraFile(null)
      fetchData()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "写真からの登録に失敗しました")
    } finally {
      setIsAnalyzing(false)
    }
  }

  // Excelエクスポート
  const handleExport = async () => {
    const { utils, writeFile } = await import("xlsx")

    const wsData = transactionsWithBalance.map((tx) => ({
      日付: new Date(tx.created_at).toLocaleString("ja-JP"),
      種別: tx.type,
      内容: tx.description || "",
      金額: tx.type === "出金" ? -tx.amount : tx.amount,
      残高: tx.runningBalance,
      登録者: tx.registered_by || "",
    }))

    const ws = utils.json_to_sheet(wsData)
    ws["!cols"] = [
      { wch: 20 }, { wch: 8 }, { wch: 30 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
    ]

    // 集計シート
    const income = transactions.filter((t) => t.type === "入金").reduce((s, t) => s + t.amount, 0)
    const expense = transactions.filter((t) => t.type === "出金").reduce((s, t) => s + t.amount, 0)
    const refund = transactions.filter((t) => t.type === "返金").reduce((s, t) => s + t.amount, 0)

    const summaryData = [
      { 項目: "現在残高", 金額: balance },
      { 項目: "", 金額: "" },
      { 項目: "入金合計", 金額: income },
      { 項目: "出金合計", 金額: expense },
      { 項目: "返金合計", 金額: refund },
      { 項目: "取引件数", 金額: transactions.length },
    ]

    const ws2 = utils.json_to_sheet(summaryData)
    ws2["!cols"] = [{ wch: 20 }, { wch: 16 }]

    const wb = utils.book_new()
    utils.book_append_sheet(wb, ws, "出納帳")
    utils.book_append_sheet(wb, ws2, "集計")

    const monthStr = selectedMonth.padStart(2, "0")
    writeFile(wb, `小口現金_${selectedYear}年${monthStr}月.xlsx`)
  }

  // 種別バッジ
  const TypeBadge = ({ type }: { type: string }) => {
    if (type === "入金") return <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">🟢 入金</Badge>
    if (type === "出金") return <Badge className="bg-red-100 text-red-700 hover:bg-red-100">🔴 出金</Badge>
    return <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">🔵 返金</Badge>
  }

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Wallet className="size-7" style={{ color: "var(--dusk-primary)" }} />
          <h1 className="text-2xl font-bold">小口現金管理</h1>
        </div>
        <Button
          onClick={handleExport}
          disabled={transactions.length === 0}
          className="btn-float-primary"
        >
          <Download className="mr-2 size-4" />
          Excelエクスポート
        </Button>
      </div>

      {/* 残高カード */}
      <Card className="overflow-hidden">
        <div
          className="p-6"
          style={{ background: "var(--dusk-accent-gradient)" }}
        >
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
            <Button onClick={() => setShowExpenseDialog(true)} variant="outline">
              <Minus className="mr-2 size-4" />
              手動で支出登録
            </Button>
            <Button onClick={() => setShowCameraDialog(true)} variant="outline">
              <Camera className="mr-2 size-4" />
              写真から登録
            </Button>
          </div>
        </CardContent>
      </Card>

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

      {/* 件数サマリー */}
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
                    <th className="px-4 py-3 text-right font-medium">金額</th>
                    <th className="px-4 py-3 text-right font-medium">残高</th>
                    <th className="px-4 py-3 text-left font-medium">登録者</th>
                  </tr>
                </thead>
                <tbody>
                  {transactionsWithBalance.map((tx) => (
                    <tr key={tx.id} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap">
                        {new Date(tx.created_at).toLocaleDateString("ja-JP")}
                      </td>
                      <td className="px-4 py-3">
                        <TypeBadge type={tx.type} />
                      </td>
                      <td className="px-4 py-3">{tx.description || "—"}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium">
                        <span className={
                          tx.type === "出金" ? "text-red-600" : "text-emerald-600"
                        }>
                          {tx.type === "出金" ? "-" : "+"}¥{tx.amount.toLocaleString()}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <span className={tx.runningBalance < 0 ? "text-red-600 font-bold" : ""}>
                          ¥{tx.runningBalance.toLocaleString()}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{tx.registered_by || "—"}</td>
                    </tr>
                  ))}
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

      {/* 出金ダイアログ */}
      <Dialog open={showExpenseDialog} onOpenChange={setShowExpenseDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>手動で支出登録</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>金額（円）</Label>
              <Input
                type="number"
                placeholder="500"
                value={expenseAmount}
                onChange={(e) => setExpenseAmount(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>用途・内容</Label>
              <Textarea
                placeholder="文房具購入、交通費など"
                value={expenseDescription}
                onChange={(e) => setExpenseDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>担当者（任意）</Label>
              <Select value={expenseStaffId} onValueChange={setExpenseStaffId}>
                <SelectTrigger>
                  <SelectValue placeholder="選択してください" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">指定なし</SelectItem>
                  {staffMembers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {expenseAmount && parseInt(expenseAmount) > 0 && (
              <>
                <div className="text-sm text-muted-foreground">
                  出金後の残高: <span className={`font-bold ${balance - parseInt(expenseAmount) < 0 ? "text-red-600" : "text-foreground"}`}>
                    ¥{(balance - parseInt(expenseAmount)).toLocaleString()}
                  </span>
                </div>
                {balance - parseInt(expenseAmount) < 0 && (
                  <Alert className="border-red-200 bg-red-50">
                    <AlertTriangle className="size-4 text-red-600" />
                    <AlertDescription className="text-red-700">
                      残高がマイナスになります
                    </AlertDescription>
                  </Alert>
                )}
              </>
            )}
            <Button
              onClick={handleExpense}
              disabled={isSubmitting}
              className="w-full"
              variant="destructive"
            >
              {isSubmitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              出金登録
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* カメラダイアログ */}
      <Dialog open={showCameraDialog} onOpenChange={setShowCameraDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>写真から登録</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              領収書の写真をアップロードすると、AI（Gemini）が金額と内容を自動解析して出金登録します。
            </p>
            <div className="space-y-2">
              <Label>領収書写真</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/jpg,application/pdf"
                className="block w-full text-sm text-muted-foreground
                  file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0
                  file:text-sm file:font-semibold file:bg-[var(--dusk-primary-light)]
                  file:text-[var(--dusk-primary)] hover:file:opacity-80"
                onChange={(e) => setCameraFile(e.target.files?.[0] || null)}
              />
            </div>
            {cameraFile && (
              <div className="text-sm text-muted-foreground">
                選択: {cameraFile.name}（{(cameraFile.size / 1024).toFixed(0)} KB）
              </div>
            )}
            <Button
              onClick={handleCameraSubmit}
              disabled={isAnalyzing || !cameraFile}
              className="w-full btn-float-primary"
            >
              {isAnalyzing ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  AI解析中...
                </>
              ) : (
                <>
                  <Camera className="mr-2 size-4" />
                  AI解析して出金登録
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
