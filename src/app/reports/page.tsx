"use client"

import { useCallback, useEffect, useState } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  CategoryPieChartClient,
  WeeklyBarChartClient,
} from "@/app/_components/dashboard-charts"
import {
  Loader2,
  Sparkles,
  Trash2,
  FileText,
  ArrowLeft,
  LineChart,
  TrendingUp,
} from "lucide-react"
import { toast } from "sonner"

interface Suggestion {
  title: string
  description: string
  priority: "高" | "中" | "低"
  expected_effect: string
}

interface Report {
  id: string
  title: string
  year: number
  month: number
  total_amount: number
  doc_count: number
  category_breakdown: { name: string; value: number }[]
  weekly_breakdown: { week: string; amount: number }[]
  ai_summary: string | null
  ai_suggestions: Suggestion[] | null
  created_at: string
}

// 優先度ごとの配色
function priorityStyle(priority: string): {
  badge: string
  color: string
  label: string
} {
  if (priority === "高") {
    return {
      badge: "#DC2626",
      color: "#FFFFFF",
      label: "高",
    }
  }
  if (priority === "中") {
    return {
      badge: "#F59E0B",
      color: "#FFFFFF",
      label: "中",
    }
  }
  return {
    badge: "#059669",
    color: "#FFFFFF",
    label: "低",
  }
}

export default function ReportsPage() {
  const [reports, setReports] = useState<Report[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selected, setSelected] = useState<Report | null>(null)
  const [isSuggesting, setIsSuggesting] = useState(false)

  // 一覧取得
  const fetchReports = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch("/api/analysis-reports")
      const json = (await res.json()) as { data?: Report[]; error?: string }
      if (!res.ok) throw new Error(json.error ?? "取得に失敗しました")
      setReports(json.data ?? [])
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "レポートの取得に失敗しました"
      )
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchReports()
  }, [fetchReports])

  // 削除
  async function handleDelete(id: string) {
    if (!confirm("このレポートを削除しますか？")) return
    try {
      const res = await fetch(`/api/analysis-reports?id=${id}`, {
        method: "DELETE",
      })
      const json = (await res.json()) as { success?: boolean; error?: string }
      if (!res.ok) throw new Error(json.error ?? "削除に失敗しました")
      setReports((prev) => prev.filter((r) => r.id !== id))
      if (selected?.id === id) setSelected(null)
      toast.success("レポートを削除しました")
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "削除に失敗しました"
      )
    }
  }

  // AI提案
  async function handleSuggest() {
    if (!selected) return
    setIsSuggesting(true)
    try {
      const res = await fetch("/api/analysis-reports/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report_id: selected.id }),
      })
      const json = (await res.json()) as { data?: Report; error?: string }
      if (!res.ok) throw new Error(json.error ?? "AI提案の取得に失敗しました")
      if (json.data) {
        setSelected(json.data)
        setReports((prev) =>
          prev.map((r) => (r.id === json.data!.id ? json.data! : r))
        )
      }
      toast.success("AIによる改善提案を取得しました")
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "AI提案の取得に失敗しました"
      )
    } finally {
      setIsSuggesting(false)
    }
  }

  // 詳細表示
  if (selected) {
    const suggestions = Array.isArray(selected.ai_suggestions)
      ? selected.ai_suggestions
      : []

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(null)}
              className="mb-2 gap-1"
              style={{ color: "#1A1A1A" }}
            >
              <ArrowLeft className="size-4" />
              一覧に戻る
            </Button>
            <h1 className="text-2xl font-bold" style={{ color: "#1A1A1A" }}>
              {selected.title}
            </h1>
            <p className="mt-1 text-sm" style={{ color: "#4A4A4A" }}>
              保存日時:{" "}
              {new Date(selected.created_at).toLocaleString("ja-JP")}
            </p>
          </div>
          <Button
            onClick={handleSuggest}
            disabled={isSuggesting}
            className="gap-2 rounded-lg"
            style={{
              background: "var(--dusk-accent-gradient)",
              color: "#FFFFFF",
              border: "none",
            }}
          >
            {isSuggesting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            {isSuggesting ? "AI分析中..." : "AIに改善提案を求める"}
          </Button>
        </div>

        {/* サマリー数値 */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardContent className="pt-6">
              <div className="text-xs" style={{ color: "#4A4A4A" }}>
                合計金額
              </div>
              <div
                className="mt-1 text-2xl font-bold"
                style={{ color: "#1A1A1A" }}
              >
                ¥{Number(selected.total_amount).toLocaleString()}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-xs" style={{ color: "#4A4A4A" }}>
                書類件数
              </div>
              <div
                className="mt-1 text-2xl font-bold"
                style={{ color: "#1A1A1A" }}
              >
                {selected.doc_count}件
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-xs" style={{ color: "#4A4A4A" }}>
                対象月
              </div>
              <div
                className="mt-1 text-2xl font-bold"
                style={{ color: "#1A1A1A" }}
              >
                {selected.year}年{selected.month}月
              </div>
            </CardContent>
          </Card>
        </div>

        {/* グラフ */}
        <div className="grid gap-6 lg:grid-cols-2">
          <CategoryPieChartClient data={selected.category_breakdown ?? []} />
          <WeeklyBarChartClient data={selected.weekly_breakdown ?? []} />
        </div>

        {/* AIサマリー */}
        {selected.ai_summary && (
          <Card>
            <CardHeader>
              <CardTitle
                className="flex items-center gap-2 text-base"
                style={{ color: "#1A1A1A" }}
              >
                <TrendingUp className="size-5" style={{ color: "#A0703A" }} />
                AIによる全体傾向
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed" style={{ color: "#1A1A1A" }}>
                {selected.ai_summary}
              </p>
            </CardContent>
          </Card>
        )}

        {/* AI改善提案 */}
        {suggestions.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle
                className="flex items-center gap-2 text-base"
                style={{ color: "#1A1A1A" }}
              >
                <Sparkles className="size-5" style={{ color: "#A0703A" }} />
                改善提案（優先度順）
              </CardTitle>
              <CardDescription style={{ color: "#4A4A4A" }}>
                AIが経費データを分析し、経営効率化のための提案を作成しました
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {suggestions.map((s, i) => {
                const style = priorityStyle(s.priority)
                return (
                  <div
                    key={i}
                    className="rounded-lg border p-4"
                    style={{
                      borderColor: "var(--dusk-border)",
                      background: "rgba(255,255,255,0.6)",
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-bold"
                        style={{
                          backgroundColor: style.badge,
                          color: style.color,
                        }}
                      >
                        優先度: {style.label}
                      </span>
                      <div className="flex-1">
                        <h3
                          className="text-sm font-bold"
                          style={{ color: "#1A1A1A" }}
                        >
                          {i + 1}. {s.title}
                        </h3>
                        <p
                          className="mt-1 text-sm"
                          style={{ color: "#1A1A1A" }}
                        >
                          {s.description}
                        </p>
                        {s.expected_effect && (
                          <div
                            className="mt-2 rounded-md px-2 py-1 text-xs"
                            style={{
                              backgroundColor: "#F0E0C8",
                              color: "#1A1A1A",
                            }}
                          >
                            期待効果: {s.expected_effect}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-sm" style={{ color: "#4A4A4A" }}>
                まだAI提案はありません。「AIに改善提案を求める」ボタンを押してください。
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    )
  }

  // 一覧表示
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: "#1A1A1A" }}>
          分析レポート
        </h1>
        <p className="mt-1 text-sm" style={{ color: "#4A4A4A" }}>
          保存済みの月次分析データを確認・AIによる改善提案を取得できます
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin" style={{ color: "#4A4A4A" }} />
        </div>
      ) : reports.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <LineChart
              className="mx-auto size-10"
              style={{ color: "#9A8070" }}
            />
            <p className="mt-3 text-sm" style={{ color: "#4A4A4A" }}>
              保存されたレポートはありません
            </p>
            <p className="mt-1 text-xs" style={{ color: "#4A4A4A" }}>
              ダッシュボードから「今月の分析を保存」ボタンで保存できます
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {reports.map((r) => (
            <Card
              key={r.id}
              className="cursor-pointer transition-shadow hover:shadow-lg"
              onClick={() => setSelected(r)}
            >
              <CardHeader>
                <CardTitle
                  className="flex items-center gap-2 text-base"
                  style={{ color: "#1A1A1A" }}
                >
                  <FileText className="size-4" style={{ color: "#A0703A" }} />
                  {r.year}年{r.month}月
                </CardTitle>
                <CardDescription style={{ color: "#4A4A4A" }}>
                  {r.title}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div
                  className="text-lg font-bold"
                  style={{ color: "#1A1A1A" }}
                >
                  ¥{Number(r.total_amount).toLocaleString()}
                </div>
                <div className="mt-1 text-xs" style={{ color: "#4A4A4A" }}>
                  {r.doc_count}件の書類
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-xs" style={{ color: "#4A4A4A" }}>
                    {new Date(r.created_at).toLocaleDateString("ja-JP")}
                  </span>
                  <div className="flex items-center gap-2">
                    {Array.isArray(r.ai_suggestions) &&
                      r.ai_suggestions.length > 0 && (
                        <span
                          className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: "#F0E0C8",
                            color: "#A0703A",
                          }}
                        >
                          <Sparkles className="size-3" />
                          AI提案済
                        </span>
                      )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(r.id)
                      }}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
