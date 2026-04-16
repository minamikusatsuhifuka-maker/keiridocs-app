import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// スタッフ一覧取得（line_user_id含む）
export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const { data, error } = await supabase
      .from("staff_members")
      .select("id, name, line_user_id, created_at")
      .order("created_at", { ascending: true })

    if (error) throw error

    return NextResponse.json({ data })
  } catch (error) {
    console.error("LINEスタッフ一覧取得エラー:", error)
    return NextResponse.json(
      { error: "スタッフ一覧の取得に失敗しました" },
      { status: 500 }
    )
  }
}

// 新規スタッフ追加
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as { name?: string }
    const name = body.name?.trim()

    if (!name) {
      return NextResponse.json({ error: "名前は必須です" }, { status: 400 })
    }

    const { data, error } = await supabase
      .from("staff_members")
      .insert({ name })
      .select("id, name, line_user_id, created_at")
      .single()

    if (error) throw error

    return NextResponse.json({ data })
  } catch (error) {
    console.error("スタッフ追加エラー:", error)
    return NextResponse.json(
      { error: "スタッフの追加に失敗しました" },
      { status: 500 }
    )
  }
}

// スタッフ更新（名前・line_user_id）
export async function PUT(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as { id?: string; name?: string; line_user_id?: string | null }

    if (!body.id) {
      return NextResponse.json({ error: "IDは必須です" }, { status: 400 })
    }

    const updates: Record<string, unknown> = {}
    if (body.name !== undefined) {
      const name = body.name?.trim()
      if (!name) {
        return NextResponse.json({ error: "名前は必須です" }, { status: 400 })
      }
      updates.name = name
    }
    if (body.line_user_id !== undefined) {
      updates.line_user_id = body.line_user_id
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "更新する項目がありません" }, { status: 400 })
    }

    const { data, error } = await supabase
      .from("staff_members")
      .update(updates)
      .eq("id", body.id)
      .select("id, name, line_user_id, created_at")
      .single()

    if (error) throw error

    return NextResponse.json({ data })
  } catch (error) {
    console.error("スタッフ更新エラー:", error)
    return NextResponse.json(
      { error: "スタッフの更新に失敗しました" },
      { status: 500 }
    )
  }
}

// スタッフ削除
export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get("id")

    if (!id) {
      return NextResponse.json({ error: "IDは必須です" }, { status: 400 })
    }

    const { error } = await supabase
      .from("staff_members")
      .delete()
      .eq("id", id)

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("スタッフ削除エラー:", error)
    return NextResponse.json(
      { error: "スタッフの削除に失敗しました" },
      { status: 500 }
    )
  }
}
