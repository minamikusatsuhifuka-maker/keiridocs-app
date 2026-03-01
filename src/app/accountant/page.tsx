"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Briefcase, CheckSquare, FolderOutput, Loader2, Square } from "lucide-react"
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
    </div>
  )
}
