import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import type { Database } from "@/types/database"

type ManualRow = Database["public"]["Tables"]["manuals"]["Row"]

/** マニュアル一覧取得・新規作成 */

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const categoryId = request.nextUrl.searchParams.get("category_id")

  let query = supabase
    .from("manuals")
    .select("*")
    .order("created_at", { ascending: true })

  if (categoryId) {
    query = query.eq("category_id", categoryId)
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: (data || []) as ManualRow[] })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const body = await request.json() as {
    category_id?: string
    title: string
    content: string
    source?: string
  }

  if (!body.title || !body.content) {
    return NextResponse.json({ error: "タイトルと内容は必須です" }, { status: 400 })
  }

  const { data, error } = await supabase
    .from("manuals")
    .insert({
      category_id: body.category_id || null,
      title: body.title,
      content: body.content,
      source: body.source || null,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}

export async function PUT(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const body = await request.json() as {
    id: string
    category_id?: string
    title?: string
    content?: string
    source?: string
  }

  if (!body.id) {
    return NextResponse.json({ error: "IDが必要です" }, { status: 400 })
  }

  const updateData: Record<string, unknown> = {}
  if (body.category_id !== undefined) updateData.category_id = body.category_id
  if (body.title !== undefined) updateData.title = body.title
  if (body.content !== undefined) updateData.content = body.content
  if (body.source !== undefined) updateData.source = body.source

  const { data, error } = await supabase
    .from("manuals")
    .update(updateData)
    .eq("id", body.id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}

export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const id = request.nextUrl.searchParams.get("id")
  if (!id) {
    return NextResponse.json({ error: "IDが必要です" }, { status: 400 })
  }

  const { error } = await supabase
    .from("manuals")
    .delete()
    .eq("id", id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
