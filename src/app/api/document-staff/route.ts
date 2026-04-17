import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// 書類登録スタッフ一覧取得
export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const { data, error } = await supabase
      .from("document_staff")
      .select("id, name, created_at")
      .order("created_at", { ascending: true })

    if (error) throw error
    return NextResponse.json({ data })
  } catch (error) {
    console.error("書類スタッフ一覧取得エラー:", error)
    return NextResponse.json(
      { error: "書類スタッフ一覧の取得に失敗しました" },
      { status: 500 }
    )
  }
}

// 書類登録スタッフ追加
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as { name?: unknown }
    const name = typeof body.name === "string" ? body.name.trim() : ""

    if (!name) {
      return NextResponse.json({ error: "名前は必須です" }, { status: 400 })
    }

    const { data, error } = await supabase
      .from("document_staff")
      .insert({ name })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ data }, { status: 201 })
  } catch (error) {
    console.error("書類スタッフ追加エラー:", error)
    return NextResponse.json(
      { error: "書類スタッフの追加に失敗しました" },
      { status: 500 }
    )
  }
}

// 書類登録スタッフ名変更
export async function PUT(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as { id?: unknown; name?: unknown }
    const id = typeof body.id === "string" ? body.id : ""
    const name = typeof body.name === "string" ? body.name.trim() : ""

    if (!id || !name) {
      return NextResponse.json({ error: "IDと名前は必須です" }, { status: 400 })
    }

    const { data, error } = await supabase
      .from("document_staff")
      .update({ name })
      .eq("id", id)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ data })
  } catch (error) {
    console.error("書類スタッフ更新エラー:", error)
    return NextResponse.json(
      { error: "書類スタッフの更新に失敗しました" },
      { status: 500 }
    )
  }
}

// 書類登録スタッフ削除
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
      .from("document_staff")
      .delete()
      .eq("id", id)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("書類スタッフ削除エラー:", error)
    return NextResponse.json(
      { error: "書類スタッフの削除に失敗しました" },
      { status: 500 }
    )
  }
}
