"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Briefcase, CheckSquare, FileSpreadsheet, FolderOutput, Loader2, Square, Upload } from "lucide-react"
import { toast } from "sonner"

// デフォルトの対象書類種別
const DEFAULT_DOC_TYPES = [
  "請求書",
  "領収書",
  "売り上げ記録",
  "自動精算機の売上表",
  "社会保険料",
  "医薬品仕入",
]

// API レスポンス型
interface TypeResult {
  type: string
  count: number
  totalAmount: number
}

interface AccountantResponse {
  data?: {
    target_month: string
    results: TypeResult[]
    total_count: number
    total_amount: number
    folder_path?: string
    message?: string
  }
  error?: string
}

// 年月選択肢を生成（過去12ヶ月分）
function generateMonthOptions(): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = []
  const now = new Date()
  for (let i = 1; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    const label = `${d.getFullYear()}年${d.getMonth() + 1}月`
    options.push({ value, label })
  }
  return options
}

// 金額フォーマット
function formatAmount(amount: number): string {
  return `¥${amount.toLocaleString()}`
}

export default function AccountantPage() {
  const [availableTypes, setAvailableTypes] = useState<string[]>(DEFAULT_DOC_TYPES)
  const [selectedTypes, setSelectedTypes] = useState<string[]>([])
  const [targetMonth, setTargetMonth] = useState("")
  const [isProcessing, setIsProcessing] = useState(false)
  const [progressMessage, setProgressMessage] = useState("")
  const [result, setResult] = useState<AccountantResponse["data"] | null>(null)

  // 月計表アップロード用 state
  const [isDragOver, setIsDragOver] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<{
    yearMonthLabel: string
    yearMonthSource: string
    taxFolderPath: string
    results: Array<{
      sheet: string
      csvFileName: string
      rows: number
      status: "saved" | "skipped" | "error"
      message?: string
    }>
  } | null>(null)

  const monthOptions = generateMonthOptions()

  // 初期値: 前月
  useEffect(() => {
    if (monthOptions.length > 0 && !targetMonth) {
      setTargetMonth(monthOptions[0].value)
    }
  }, [monthOptions, targetMonth])

  // settingsから対象種別を取得
  const fetchDocTypes = useCallback(async () => {
    try {
      const res = await fetch("/api/settings?table=settings&key=accountant_doc_types")
      const json = await res.json() as { data?: { value: unknown }; error?: string }
      if (json.data?.value && Array.isArray(json.data.value)) {
        const types = json.data.value as string[]
        setAvailableTypes(types)
        setSelectedTypes(types)
      } else {
        setSelectedTypes(DEFAULT_DOC_TYPES)
      }
    } catch {
      setSelectedTypes(DEFAULT_DOC_TYPES)
    }
  }, [])

  useEffect(() => {
    fetchDocTypes()
  }, [fetchDocTypes])

  // 種別の選択/解除
  function toggleType(type: string) {
    setSelectedTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    )
  }

  // 全選択
  function selectAll() {
    setSelectedTypes([...availableTypes])
  }

  // 全解除
  function deselectAll() {
    setSelectedTypes([])
  }

  // 月計表アップロード処理（クライアント側でxlsx解析→CSV化してAPIに送信）
  async function processMonthlyFile(file: File) {
    if (!file) return
    const ext = file.name.split(".").pop()?.toLowerCase()
    if (!["xlsx", "xls"].includes(ext ?? "")) {
      toast.error("Excel（.xlsx / .xls）のみ対応しています")
      return
    }
    if (file.size > 50 * 1024 * 1024) {
      toast.error("ファイルサイズが50MBを超えています")
      return
    }

    setIsUploading(true)
    setUploadResult(null)

    try {
      // ① ブラウザ側で xlsx を ArrayBuffer として読み込む
      const arrayBuffer = await file.arrayBuffer()
      const XLSX = await import("xlsx")
      const workbook = XLSX.read(arrayBuffer, { type: "array", cellDates: false })

      // ② 年月をセルから検出
      const TARGET_SHEETS = ["Sheet1", "保険"]
      const firstSheet = workbook.SheetNames[0]
      const ws0 = workbook.Sheets[firstSheet]
      let year = new Date().getFullYear()
      let month = new Date().getMonth() + 1

      if (ws0) {
        outer: for (let r = 0; r <= 9; r++) {
          for (let c = 0; c <= 5; c++) {
            const cell = ws0[XLSX.utils.encode_cell({ r, c })]
            if (!cell) continue
            const text = String(cell.w ?? cell.v ?? "")
            const m = text.match(/(20\d{2})[年\/\-](\d{1,2})[月]?/)
            if (m) {
              const y = Number(m[1]); const mo = Number(m[2])
              if (y >= 2020 && y <= 2100 && mo >= 1 && mo <= 12) {
                year = y; month = mo; break outer
              }
            }
            // Excel日付シリアル値
            if (cell.t === "n" && typeof cell.v === "number" && cell.v > 40000) {
              try {
                const parsed = XLSX.SSF.parse_date_code(cell.v as number)
                if (parsed && parsed.y >= 2020) { year = parsed.y; month = parsed.m; break outer }
              } catch { /* ignore */ }
            }
          }
        }
      }

      const monthStr = String(month).padStart(2, "0")
      const yearMonthLabel = `${year}年${monthStr}月`

      // ③ 各シートを1〜30行目のCSVに変換
      const csvSheets: Array<{ sheet: string; csv: string }> = []
      // シートごとの抽出上限行数（1-indexed）
      const SHEET_MAX_ROWS: Record<string, number> = {
        "Sheet1": 20,
        "保険": 28,
      }

      for (const sheetName of TARGET_SHEETS) {
        const ws = workbook.Sheets[sheetName]
        if (!ws) { csvSheets.push({ sheet: sheetName, csv: "" }); continue }

        const ref = ws["!ref"]
        if (!ref) { csvSheets.push({ sheet: sheetName, csv: "" }); continue }
        const range = XLSX.utils.decode_range(ref)
        const maxRows = SHEET_MAX_ROWS[sheetName] ?? 28
        const endRow = Math.min(range.e.r, maxRows - 1) // 0-indexed

        const rows: string[][] = []
        for (let r = 0; r <= endRow; r++) {
          const row: string[] = []
          for (let c = range.s.c; c <= range.e.c; c++) {
            const cell = ws[XLSX.utils.encode_cell({ r, c })]
            const raw = cell ? String(cell.v ?? "") : ""
            const escaped = raw.includes(",") || raw.includes('"') || raw.includes("\n")
              ? `"${raw.replace(/"/g, '""')}"` : raw
            row.push(escaped)
          }
          rows.push(row)
        }
        csvSheets.push({ sheet: sheetName, csv: rows.map(r => r.join(",")).join("\n") })
      }

      // ④ APIにCSV文字列のみ送信（Excelファイル本体は送らない）
      const res = await fetch("/api/accountant/upload-monthly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year,
          month,
          yearMonthLabel,
          csvSheets,
          filename: file.name,
        }),
      })

      const json = await res.json() as {
        yearMonthLabel?: string
        yearMonthSource?: string
        taxFolderPath?: string
        results?: Array<{
          sheet: string
          csvFileName: string
          rows: number
          status: "saved" | "skipped" | "error"
          message?: string
        }>
        error?: string
      }

      if (json.error) throw new Error(json.error)

      setUploadResult({
        yearMonthLabel: json.yearMonthLabel ?? yearMonthLabel,
        yearMonthSource: json.yearMonthSource ?? "セル自動検出",
        taxFolderPath: json.taxFolderPath ?? "",
        results: json.results ?? [],
      })

      const savedCount = (json.results ?? []).filter((r) => r.status === "saved").length
      toast.success(`✅ ${yearMonthLabel} の月計表CSV（${savedCount}件）を税理士フォルダに保存しました`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "アップロードに失敗しました")
    } finally {
      setIsUploading(false)
    }
  }

  // クリック選択
  async function handleMonthlyUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    await processMonthlyFile(file)
    e.target.value = ""
  }

  // ドラッグ&ドロップ
  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }

  async function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    await processMonthlyFile(file)
  }

  // フォルダ作成実行
  async function handleCreate() {
    if (selectedTypes.length === 0) {
      toast.error("対象種別を1つ以上選択してください")
      return
    }

    setIsProcessing(true)
    setResult(null)
    setProgressMessage("書類を取得中...")

    try {
      setProgressMessage("Dropboxにフォルダを作成中...")

      const res = await fetch("/api/accountant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_month: targetMonth,
          doc_types: selectedTypes,
        }),
      })

      const json = await res.json() as AccountantResponse

      if (json.error) {
        throw new Error(json.error)
      }

      setResult(json.data ?? null)

      if (json.data?.total_count === 0) {
        toast.info(json.data.message ?? "対象の書類がありませんでした")
      } else {
        toast.success(`${json.data?.total_count}件の書類をコピーしました`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "処理に失敗しました"
      toast.error(message)
    } finally {
      setIsProcessing(false)
      setProgressMessage("")
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Briefcase className="size-7 text-primary" />
        <h1 className="text-2xl font-bold">税理士提出フォルダ作成</h1>
      </div>

      {/* 設定カード */}
      <Card>
        <CardHeader>
          <CardTitle>対象月・種別の選択</CardTitle>
          <CardDescription>
            前月分の書類をDropboxの税理士提出フォルダに自動でまとめます
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 月選択 */}
          <div className="space-y-2">
            <Label>対象月</Label>
            <Select value={targetMonth} onValueChange={setTargetMonth}>
              <SelectTrigger className="w-60">
                <SelectValue placeholder="月を選択" />
              </SelectTrigger>
              <SelectContent>
                {monthOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 種別チェックボックスリスト */}
          <div className="space-y-3">
            <div className="flex items-center gap-4">
              <Label>対象種別</Label>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={selectAll}
                  className="gap-1"
                >
                  <CheckSquare className="size-3.5" />
                  全選択
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={deselectAll}
                  className="gap-1"
                >
                  <Square className="size-3.5" />
                  全解除
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {availableTypes.map((type) => (
                <div key={type} className="flex items-center gap-2">
                  <Checkbox
                    id={`type-${type}`}
                    checked={selectedTypes.includes(type)}
                    onCheckedChange={() => toggleType(type)}
                  />
                  <Label
                    htmlFor={`type-${type}`}
                    className="cursor-pointer text-sm"
                  >
                    {type}
                  </Label>
                </div>
              ))}
            </div>
          </div>

          {/* 実行ボタン */}
          <div className="flex items-center gap-4 pt-2">
            <Button
              onClick={handleCreate}
              disabled={isProcessing || selectedTypes.length === 0}
              className="gap-2"
            >
              {isProcessing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FolderOutput className="size-4" />
              )}
              {isProcessing ? "処理中..." : "フォルダ作成"}
            </Button>
            {progressMessage && (
              <span className="text-sm text-muted-foreground">
                {progressMessage}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 結果サマリー */}
      {result && result.results.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>作成結果</CardTitle>
            <CardDescription>
              {result.folder_path && (
                <>Dropbox: {result.folder_path}</>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>種別</TableHead>
                  <TableHead className="text-right">件数</TableHead>
                  <TableHead className="text-right">合計金額</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.results.map((r) => (
                  <TableRow key={r.type}>
                    <TableCell className="font-medium">{r.type}</TableCell>
                    <TableCell className="text-right">{r.count}件</TableCell>
                    <TableCell className="text-right">
                      {formatAmount(r.totalAmount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="font-bold">合計</TableCell>
                  <TableCell className="text-right font-bold">
                    {result.total_count}件
                  </TableCell>
                  <TableCell className="text-right font-bold">
                    {formatAmount(result.total_amount)}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* 書類なしメッセージ */}
      {result && result.results.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {result.message ?? "対象月に該当する書類がありませんでした"}
          </CardContent>
        </Card>
      )}

      {/* 月計表アップロードセクション */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="size-5 text-primary" />
            月計表アップロード
          </CardTitle>
          <CardDescription>
            Excel(.xlsx / .xls)をアップロードすると、Sheet1・保険タブの1〜30行目を
            CSVに変換して税理士提出フォルダに自動保存します。対象年月はセルから自動検出します。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={[
              "flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-8 transition",
              isDragOver
                ? "border-[#A0703A] bg-[#F5EFE6] scale-[1.01]"
                : "border-[#E0CEB8] bg-[#FAF7F0]",
              isUploading ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:bg-[#F5EFE6]",
            ].join(" ")}
            onClick={() => {
              if (!isUploading) document.getElementById("monthly-upload-input")?.click()
            }}
          >
            {isUploading ? (
              <>
                <Loader2 className="size-8 animate-spin text-[#A0703A]" />
                <span className="text-sm text-[#8B5E2F]">解析中...</span>
              </>
            ) : isDragOver ? (
              <>
                <Upload className="size-8 text-[#A0703A]" />
                <span className="text-sm font-medium text-[#A0703A]">
                  ここでドロップ！
                </span>
              </>
            ) : (
              <>
                <Upload className="size-8 text-[#A0703A]" />
                <span className="text-sm font-medium text-[#8B5E2F]">
                  クリックまたはドロップしてアップロード
                </span>
                <span className="text-xs text-[#A0703A]/70">.xlsx / .xls のみ対応</span>
              </>
            )}
            <input
              id="monthly-upload-input"
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              disabled={isUploading}
              onChange={handleMonthlyUpload}
            />
          </div>

          {/* アップロード結果 */}
          {uploadResult && (
            <div className="rounded-lg border border-[#E0CEB8] bg-white/60 p-4 space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold text-[#8B5E2F]">
                  📅 {uploadResult.yearMonthLabel} として処理
                </span>
                <span className="text-xs text-muted-foreground">
                  検出元: {uploadResult.yearMonthSource}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                保存先: {uploadResult.taxFolderPath}
              </p>
              <div className="space-y-2">
                {uploadResult.results.map((r) => (
                  <div key={r.sheet} className="flex items-center justify-between text-sm rounded-md bg-[#FAF7F0] px-3 py-2">
                    <span className="font-medium text-[#6B4226]">
                      📄 {r.csvFileName || `月計表_${r.sheet}`}
                    </span>
                    {r.status === "saved" && (
                      <span className="text-emerald-600 text-xs font-medium">✅ 保存完了({r.rows}行)</span>
                    )}
                    {r.status === "skipped" && (
                      <span className="text-amber-600 text-xs">⚠ {r.message}</span>
                    )}
                    {r.status === "error" && (
                      <span className="text-red-600 text-xs">❌ {r.message}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
