"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Save, Loader2, BookmarkCheck } from "lucide-react"
import { toast } from "sonner"

interface CategoryItem {
  name: string
  value: number
}

interface WeeklyItem {
  week: string
  amount: number
}

interface SaveReportButtonProps {
  year: number
  month: number
  totalAmount: number
  docCount: number
  categoryBreakdown: CategoryItem[]
  weeklyBreakdown: WeeklyItem[]
}

// 今月の分析データを analysis_reports に保存するボタン
export function SaveReportButton({
  year,
  month,
  totalAmount,
  docCount,
  categoryBreakdown,
  weeklyBreakdown,
}: SaveReportButtonProps) {
  const router = useRouter()
  const [isSaving, setIsSaving] = useState(false)
  const [isSaved, setIsSaved] = useState(false)

  async function handleSave() {
    setIsSaving(true)
    try {
      const title = `${year}年${month}月の分析レポート`
      const res = await fetch("/api/analysis-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          year,
          month,
          total_amount: totalAmount,
          doc_count: docCount,
          category_breakdown: categoryBreakdown,
          weekly_breakdown: weeklyBreakdown,
        }),
      })

      const json = await res.json() as { data?: { id: string }; error?: string }
      if (!res.ok) throw new Error(json.error ?? "保存に失敗しました")

      setIsSaved(true)
      toast.success("分析レポートを保存しました", {
        action: {
          label: "レポート一覧へ",
          onClick: () => router.push("/reports"),
        },
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存に失敗しました")
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Button
      onClick={handleSave}
      disabled={isSaving || isSaved}
      className="btn-float-primary gap-2 rounded-lg px-4 py-2 text-sm"
      style={{
        background: "var(--dusk-accent-gradient)",
        color: "#FFFFFF",
        border: "none",
      }}
    >
      {isSaving ? (
        <Loader2 className="size-4 animate-spin" />
      ) : isSaved ? (
        <BookmarkCheck className="size-4" />
      ) : (
        <Save className="size-4" />
      )}
      {isSaving ? "保存中..." : isSaved ? "保存済み" : "今月の分析を保存"}
    </Button>
  )
}
