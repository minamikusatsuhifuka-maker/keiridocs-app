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
  Upload,
  FileSpreadsheet,
  ScanLine,
  CheckCircle2,
  XCircle,
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

  // インポートフォーム
  const [showImportDialog, setShowImportDialog] = useState(false)
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

  // スキャナーフォーム
  const [showScannerDialog, setShowScannerDialog] = useState(false)
  const [scannerFile, setScannerFile] = useState<File | null>(null)
  const [scannerPreview, setScannerPreview] = useState<{
    vendor_name: string
    amount: number | null
    issue_date: string | null
    description: string | null
    type: string | null
  } | null>(null)
  const [scannerAmount, setScannerAmount] = useState("")
  const [scannerDescription, setScannerDescription] = useState("")
  const [scannerDate, setScannerDate] = useState("")
  const [scannerType, setScannerType] = useState<"出金" | "入金" | "返金">("出金")
  const [scannerLoading, setScannerLoading] = useState(false)
  const scannerFileInputRef = useRef<HTMLInputElement>(null)

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

  // インポート: プレビュー取得
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

  // インポート: 実行
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

  // スキャナー: AI解析
  const handleScannerAnalyze = async () => {
    if (!scannerFile) {
      toast.error("ファイルを選択してください")
      return
    }

    setScannerLoading(true)
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = reader.result as string
          const commaIdx = result.indexOf(",")
          resolve(commaIdx >= 0 ? result.substring(commaIdx + 1) : result)
        }
        reader.onerror = reject
        reader.readAsDataURL(scannerFile)
      })

      const res = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base64,
          mimeType: scannerFile.type || "application/octet-stream",
        }),
      })

      if (!res.ok) throw new Error("AI解析に失敗しました")
      const json = await res.json() as {
        vendor_name?: string
        amount?: number | null
        issue_date?: string | null
        description?: string | null
        type?: string | null
      }

      const preview = {
        vendor_name: json.vendor_name || "",
        amount: json.amount ?? null,
        issue_date: json.issue_date ?? null,
        description: json.description ?? null,
        type: json.type ?? null,
      }
      setScannerPreview(preview)
      setScannerAmount(preview.amount ? String(preview.amount) : "")
      setScannerDescription(preview.vendor_name || preview.description || "")
      setScannerDate(preview.issue_date || new Date().toISOString().substring(0, 10))
      toast.success("AI解析完了。内容を確認してください")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "AI解析に失敗しました")
    } finally {
      setScannerLoading(false)
    }
  }

  // スキャナー: 登録実行（Dropbox保存 + DB登録）
  const handleScannerSubmit = async () => {
    if (!scannerFile) {
      toast.error("ファイルを選択してください")
      return
    }
    const amount = parseInt(scannerAmount)
    if (!amount || amount <= 0) {
      toast.error("金額を正しく入力してください")
      return
    }
    if (!scannerDescription) {
      toast.error("内容を入力してください")
      return
    }

    setScannerLoading(true)
    try {
      // ファイルをbase64変換
      const arrayBuffer = await scannerFile.arrayBuffer()
      const bytes = new Uint8Array(arrayBuffer)
      let binary = ""
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
      const base64 = btoa(binary)

      // Dropboxパス生成
      const targetDate = scannerDate ? new Date(scannerDate) : new Date()
      const yyyy = targetDate.getFullYear()
      const mm = String(targetDate.getMonth() + 1).padStart(2, "0")
      const dd = String(targetDate.getDate()).padStart(2, "0")
      const rand6 = Math.random().toString(36).substring(2, 8).toLowerCase()
      const ext = scannerFile.name.split(".").pop() || "pdf"
      const safeDesc = scannerDescription.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40)
      const dropboxPath = `/経理書類/小口現金/${yyyy}年${mm}月/${yyyy}${mm}${dd}_${safeDesc}_${rand6}.${ext}`

      // Dropboxアップロード
      const uploadRes = await fetch("/api/petty-cash/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base64,
          fileName: scannerFile.name,
          dropboxPath,
        }),
      })
      if (!uploadRes.ok) {
        const json = await uploadRes.json().catch(() => ({})) as { error?: string }
        throw new Error(json.error || "Dropboxアップロードに失敗しました")
      }
      const uploadJson = await uploadRes.json() as { path: string }

      // 取引登録
      const txRes = await fetch("/api/petty-cash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: scannerType,
          amount,
          description: `📄 ${scannerDescription}`,
          dropbox_path: uploadJson.path,
        }),
      })

      if (!txRes.ok) {
        const json = await txRes.json() as { error?: string }
        throw new Error(json.error || "登録に失敗しました")
      }

      toast.success(`${scannerType}登録完了: ¥${amount.toLocaleString()} (${scannerDescription})`)
      setShowScannerDialog(false)
      setScannerFile(null)
      setScannerPreview(null)
      setScannerAmount("")
      setScannerDescription("")
      setScannerDate("")
      setScannerType("出金")
      if (scannerFileInputRef.current) scannerFileInputRef.current.value = ""
      fetchData()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "登録に失敗しました")
    } finally {
      setScannerLoading(false)
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
            <Button onClick={() => setShowScannerDialog(true)} variant="outline">
              <ScanLine className="mr-2 size-4" />
              スキャナーから登録
            </Button>
            <Button onClick={() => setShowImportDialog(true)} variant="outline">
              <Upload className="mr-2 size-4" />
              過去データをインポート
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

      {/* スキャナーダイアログ */}
      <Dialog
        open={showScannerDialog}
        onOpenChange={(v) => {
          setShowScannerDialog(v)
          if (!v) {
            setScannerFile(null)
            setScannerPreview(null)
            setScannerAmount("")
            setScannerDescription("")
            setScannerDate("")
            setScannerType("出金")
            if (scannerFileInputRef.current) scannerFileInputRef.current.value = ""
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>スキャナーから登録</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              PDFまたは画像（JPG/PNG）をアップロードすると、AIが領収書・帳票を解析し、
              Dropboxに自動保存＋小口現金に登録します。
            </p>

            <div className="space-y-2">
              <Label>ファイル（PDF / JPG / PNG）</Label>
              <input
                ref={scannerFileInputRef}
                type="file"
                accept="application/pdf,image/jpeg,image/jpg,image/png"
                className="block w-full text-sm text-muted-foreground
                  file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0
                  file:text-sm file:font-semibold file:bg-[var(--dusk-primary-light)]
                  file:text-[var(--dusk-primary)] hover:file:opacity-80"
                onChange={(e) => {
                  setScannerFile(e.target.files?.[0] || null)
                  setScannerPreview(null)
                }}
              />
            </div>
            {scannerFile && (
              <div className="text-sm text-muted-foreground">
                選択: {scannerFile.name}（{(scannerFile.size / 1024).toFixed(0)} KB）
              </div>
            )}

            {!scannerPreview && (
              <Button
                onClick={handleScannerAnalyze}
                disabled={scannerLoading || !scannerFile}
                className="w-full btn-float-primary"
              >
                {scannerLoading ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    AI解析中...
                  </>
                ) : (
                  <>
                    <ScanLine className="mr-2 size-4" />
                    AIで解析
                  </>
                )}
              </Button>
            )}

            {scannerPreview && (
              <>
                <div className="rounded-md border p-3 text-sm">
                  <div className="font-medium mb-2 flex items-center gap-1">
                    <CheckCircle2 className="size-4 text-emerald-600" />
                    AI解析結果（修正可）
                  </div>
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <Label className="text-xs">日付</Label>
                      <Input
                        type="date"
                        value={scannerDate}
                        onChange={(e) => setScannerDate(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">種別</Label>
                      <Select value={scannerType} onValueChange={(v) => setScannerType(v as "出金" | "入金" | "返金")}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="出金">出金</SelectItem>
                          <SelectItem value="入金">入金</SelectItem>
                          <SelectItem value="返金">返金</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">金額（円）</Label>
                      <Input
                        type="number"
                        value={scannerAmount}
                        onChange={(e) => setScannerAmount(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">内容</Label>
                      <Input
                        value={scannerDescription}
                        onChange={(e) => setScannerDescription(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    onClick={() => setScannerPreview(null)}
                    variant="outline"
                    className="flex-1"
                    disabled={scannerLoading}
                  >
                    <XCircle className="mr-2 size-4" />
                    やり直し
                  </Button>
                  <Button
                    onClick={handleScannerSubmit}
                    disabled={scannerLoading}
                    className="flex-1 btn-float-primary"
                  >
                    {scannerLoading ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        登録中...
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="mr-2 size-4" />
                        Dropbox保存 + 登録
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
