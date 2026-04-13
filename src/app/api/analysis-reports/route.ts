import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import type { Json } from "@/types/database"

// 分析レポート一覧取得
export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const { data, error } = await supabase
      .from("analysis_reports")
      .select("*")
      .order("year", { ascending: false })
      .order("month", { ascending: false })
      .order("created_at", { ascending: false })

    if (error) throw error
    return NextResponse.json({ data })
  } catch (error) {
    console.error("分析レポート取得エラー:", error)
    return NextResponse.json(
      { error: "分析レポートの取得に失敗しました" },
      { status: 500 }
    )
  }
}

// 分析レポート保存
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as {
      title?: unknown
      year?: unknown
      month?: unknown
      total_amount?: unknown
      doc_count?: unknown
      category_breakdown?: unknown
      weekly_breakdown?: unknown
      ai_summary?: unknown
    }

    const title = typeof body.title === "string" ? body.title : ""
    const year = typeof body.year === "number" ? body.year : new Date().getFullYear()
    const month = typeof body.month === "number" ? body.month : new Date().getMonth() + 1
    const totalAmount = typeof body.total_amount === "number" ? body.total_amount : 0
    const docCount = typeof body.doc_count === "number" ? body.doc_count : 0
    const categoryBreakdown = Array.isArray(body.category_breakdown)
      ? (body.category_breakdown as Json)
      : ([] as unknown as Json)
    const weeklyBreakdown = Array.isArray(body.weekly_breakdown)
      ? (body.weekly_breakdown as Json)
      : ([] as unknown as Json)
    const aiSummary = typeof body.ai_summary === "string" ? body.ai_summary : null

    if (!title) {
      return NextResponse.json({ error: "タイトルは必須です" }, { status: 400 })
    }

    const { data, error } = await supabase
      .from("analysis_reports")
      .insert({
        title,
        year,
        month,
        total_amount: totalAmount,
        doc_count: docCount,
        category_breakdown: categoryBreakdown,
        weekly_breakdown: weeklyBreakdown,
        ai_summary: aiSummary,
      })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ data }, { status: 201 })
  } catch (error) {
    console.error("分析レポート保存エラー:", error)
    return NextResponse.json(
      { error: "分析レポートの保存に失敗しました" },
      { status: 500 }
    )
  }
}

// 分析レポート削除
export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const id = searchParams.get("id")

  if (!id) {
    return NextResponse.json({ error: "IDが必要です" }, { status: 400 })
  }

  try {
    const { error } = await supabase
      .from("analysis_reports")
      .delete()
      .eq("id", id)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("分析レポート削除エラー:", error)
    return NextResponse.json(
      { error: "分析レポートの削除に失敗しました" },
      { status: 500 }
    )
  }
}
