"use client"

import { useState } from "react"
import ReactMarkdown from "react-markdown"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"
import { Sparkles, Copy, FileDown, ArrowLeft } from "lucide-react"
import Link from "next/link"

const PERIOD_OPTIONS = [
  { value: "1m", label: "先月" },
  { value: "3m", label: "過去3ヶ月" },
  { value: "6m", label: "過去6ヶ月" },
  { value: "12m", label: "過去12ヶ月" },
]

export default function AiReportPage() {
  const [period, setPeriod] = useState("3m")
  const [report, setReport] = useState("")
  const [modelUsed, setModelUsed] = useState("")
  const [isLoading, setIsLoading] = useState(false)

  // レポート生成
  async function generateReport() {
    setIsLoading(true)
    setReport("")
    setModelUsed("")

    try {
      const res = await fetch("/api/analytics/ai-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period }),
      })

      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(data.error || "レポート生成に失敗しました")
      }

      const data = await res.json() as { report: string; model_used?: string }
      setReport(data.report)
      if (data.model_used) setModelUsed(data.model_used)
      toast.success("レポートを生成しました")
    } catch (error) {
      const message = error instanceof Error ? error.message : "レポート生成に失敗しました"
      toast.error(message)
    } finally {
      setIsLoading(false)
    }
  }

  // クリップボードにコピー
  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(report)
      toast.success("コピーしました")
    } catch {
      toast.error("コピーに失敗しました")
    }
  }

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div className="flex items-center gap-4">
        <Link href="/analytics">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">AI経営分析レポート</h1>
          <p className="text-sm text-muted-foreground">
            Gemini AIが経理データを分析し、経営レポートを生成します
          </p>
        </div>
      </div>

      {/* 操作パネル */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 pt-6">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">分析期間:</span>
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIOD_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button onClick={generateReport} disabled={isLoading}>
            <Sparkles className="mr-2 h-4 w-4" />
            {isLoading ? "生成中..." : "レポート生成"}
          </Button>

          {report && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={copyToClipboard}>
                <Copy className="mr-2 h-4 w-4" />
                コピー
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled
                title="将来実装予定"
              >
                <FileDown className="mr-2 h-4 w-4" />
                PDF
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* レポート表示 */}
      {isLoading && (
        <Card>
          <CardHeader>
            <Skeleton className="h-8 w-64" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/6" />
            <Skeleton className="h-6 w-48 mt-6" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-3/6" />
            <Skeleton className="h-6 w-48 mt-6" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/6" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/6" />
          </CardContent>
        </Card>
      )}

      {report && !isLoading && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5" />
              分析レポート
            </CardTitle>
            {modelUsed && (
              <p className="text-xs text-muted-foreground">
                使用モデル: {modelUsed}
              </p>
            )}
          </CardHeader>
          <CardContent>
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown>{report}</ReactMarkdown>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 未生成時の案内 */}
      {!report && !isLoading && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Sparkles className="mb-4 h-12 w-12 text-muted-foreground/50" />
            <h3 className="text-lg font-medium">レポート未生成</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              期間を選択して「レポート生成」をクリックしてください。
              <br />
              AIが経理データを分析し、経営レポートを作成します。
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
