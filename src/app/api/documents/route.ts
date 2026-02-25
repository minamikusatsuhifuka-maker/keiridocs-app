import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getDocumentPath, moveFile } from "@/lib/dropbox"
import type { Database } from "@/types/database"

type DocumentRow = Database["public"]["Tables"]["documents"]["Row"]
type DocumentUpdate = Database["public"]["Tables"]["documents"]["Update"]

// 書類一覧取得 / 単一取得
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)

  // 単一取得（id指定時）
  const id = searchParams.get("id")
  if (id) {
    const { data, error } = await supabase
      .from("documents")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single()

    if (error) {
      console.error("書類取得エラー:", error)
      return NextResponse.json({ error: "書類の取得に失敗しました" }, { status: 404 })
    }
    return NextResponse.json({ data })
  }

  // 一覧取得（フィルタ・検索・ソート・ページネーション対応）
  const status = searchParams.get("status")
  const type = searchParams.get("type")
  const searchQuery = searchParams.get("search")
  const dateFrom = searchParams.get("date_from")
  const dateTo = searchParams.get("date_to")
  const sortField = searchParams.get("sort") ?? "created_at"
  const sortDirection = searchParams.get("direction") ?? "desc"
  const limit = parseInt(searchParams.get("limit") ?? "20", 10)
  const offset = parseInt(searchParams.get("offset") ?? "0", 10)

  // ソート可能なカラムを制限
  const allowedSortFields = ["type", "vendor_name", "amount", "issue_date", "due_date", "status", "created_at"]
  const safeSort = allowedSortFields.includes(sortField) ? sortField : "created_at"
  const ascending = sortDirection === "asc"

  let query = supabase
    .from("documents")
    .select("*", { count: "exact" })
    .eq("user_id", user.id)
    .order(safeSort, { ascending })
    .range(offset, offset + limit - 1)

  if (status) {
    query = query.eq("status", status)
  }
  if (type) {
    query = query.eq("type", type)
  }

  // テキスト検索（取引先名・摘要）
  if (searchQuery) {
    query = query.or(`vendor_name.ilike.%${searchQuery}%,description.ilike.%${searchQuery}%`)
  }

  // 期間フィルタ（発行日基準）
  if (dateFrom) {
    query = query.gte("issue_date", dateFrom)
  }
  if (dateTo) {
    query = query.lte("issue_date", dateTo)
  }

  const { data, error, count } = await query

  if (error) {
    console.error("書類取得エラー:", error)
    return NextResponse.json({ error: "書類の取得に失敗しました" }, { status: 500 })
  }

  return NextResponse.json({ data, count })
}

// 書類登録
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as {
      type: unknown
      vendor_name: unknown
      amount: unknown
      issue_date: unknown
      due_date: unknown
      description: unknown
      input_method: unknown
      dropbox_path: unknown
      ocr_raw: unknown
    }

    const { type, vendor_name, amount, issue_date, due_date, description, input_method, dropbox_path, ocr_raw } = body

    // 必須フィールドのバリデーション
    if (typeof type !== "string" || typeof vendor_name !== "string") {
      return NextResponse.json(
        { error: "種別と取引先名は必須です" },
        { status: 400 }
      )
    }

    if (typeof input_method !== "string") {
      return NextResponse.json(
        { error: "入力経路は必須です" },
        { status: 400 }
      )
    }

    const { data, error } = await supabase
      .from("documents")
      .insert({
        type,
        vendor_name,
        amount: typeof amount === "number" ? amount : null,
        issue_date: typeof issue_date === "string" ? issue_date : null,
        due_date: typeof due_date === "string" ? due_date : null,
        description: typeof description === "string" ? description : null,
        input_method,
        status: "未処理",
        dropbox_path: typeof dropbox_path === "string" ? dropbox_path : null,
        ocr_raw: (ocr_raw ?? null) as import("@/types/database").Json | null,
        user_id: user.id,
      })
      .select()
      .single()

    if (error) {
      console.error("書類登録エラー:", error)
      return NextResponse.json({ error: "書類の登録に失敗しました" }, { status: 500 })
    }

    return NextResponse.json({ data }, { status: 201 })
  } catch (error) {
    console.error("書類登録エラー:", error)
    return NextResponse.json({ error: "書類の登録に失敗しました" }, { status: 500 })
  }
}

// 書類更新（ステータス変更時のDropbox移動対応）
export async function PATCH(request: NextRequest) {
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
    const body = await request.json() as Record<string, unknown>

    // 既存の書類を取得
    const { data: existingData, error: fetchError } = await supabase
      .from("documents")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single()

    if (fetchError || !existingData) {
      return NextResponse.json({ error: "書類が見つかりません" }, { status: 404 })
    }

    const existing = existingData as DocumentRow

    // 更新可能なフィールドを構築
    const update: DocumentUpdate = {}
    if (typeof body.type === "string") update.type = body.type
    if (typeof body.vendor_name === "string") update.vendor_name = body.vendor_name
    if ("amount" in body) update.amount = typeof body.amount === "number" ? body.amount : null
    if ("issue_date" in body) update.issue_date = typeof body.issue_date === "string" ? body.issue_date : null
    if ("due_date" in body) update.due_date = typeof body.due_date === "string" ? body.due_date : null
    if ("description" in body) update.description = typeof body.description === "string" ? body.description : null
    if (typeof body.status === "string") update.status = body.status

    const hasUpdates = Object.keys(update).length > 0
    if (!hasUpdates) {
      return NextResponse.json({ error: "更新するフィールドがありません" }, { status: 400 })
    }

    // ステータス変更時にDropboxファイルを移動
    const newStatus = update.status
    if (newStatus && newStatus !== existing.status && existing.dropbox_path) {
      try {
        const newType = update.type ?? existing.type
        const fileName = existing.dropbox_path.split("/").pop() ?? ""
        const dateStr = existing.issue_date ?? existing.created_at
        const date = new Date(dateStr)
        const newPath = getDocumentPath(newType, fileName, date, newStatus)

        if (newPath !== existing.dropbox_path) {
          const movedPath = await moveFile(existing.dropbox_path, newPath)
          update.dropbox_path = movedPath
        }
      } catch (moveError) {
        console.error("Dropboxファイル移動エラー:", moveError)
        // ファイル移動が失敗してもDB更新は続行する
      }
    }

    const { data, error } = await supabase
      .from("documents")
      .update(update)
      .eq("id", id)
      .eq("user_id", user.id)
      .select()
      .single()

    if (error) {
      console.error("書類更新エラー:", error)
      return NextResponse.json({ error: "書類の更新に失敗しました" }, { status: 500 })
    }

    return NextResponse.json({ data })
  } catch (error) {
    console.error("書類更新エラー:", error)
    return NextResponse.json({ error: "書類の更新に失敗しました" }, { status: 500 })
  }
}

// 書類削除
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

  const { error } = await supabase
    .from("documents")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id)

  if (error) {
    console.error("書類削除エラー:", error)
    return NextResponse.json({ error: "書類の削除に失敗しました" }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
