import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// 対象テーブル名の型
type SettingsTable = "settings" | "allowed_senders" | "notify_recipients" | "custom_folders" | "document_types"

const ALLOWED_TABLES: SettingsTable[] = ["settings", "allowed_senders", "notify_recipients", "custom_folders", "document_types"]

// テーブル名のバリデーション
function validateTable(table: string | null): table is SettingsTable {
  return table !== null && ALLOWED_TABLES.includes(table as SettingsTable)
}

// 設定一覧取得
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const table = searchParams.get("table")

  if (!validateTable(table)) {
    return NextResponse.json(
      { error: "無効なテーブル名です。settings, allowed_senders, notify_recipients, custom_folders のいずれかを指定してください" },
      { status: 400 }
    )
  }

  // settings テーブルはキー指定で単一取得も可能
  const key = searchParams.get("key")
  if (table === "settings" && key) {
    const { data, error } = await supabase
      .from("settings")
      .select("*")
      .eq("user_id", user.id)
      .eq("key", key)
      .maybeSingle()

    if (error) {
      console.error("設定取得エラー:", error)
      return NextResponse.json({ error: "設定の取得に失敗しました" }, { status: 500 })
    }
    return NextResponse.json({ data })
  }

  // document_typesはsort_order順で返す
  const query = supabase
    .from(table)
    .select("*")
    .eq("user_id", user.id)

  if (table === "document_types") {
    query.order("sort_order", { ascending: true })
  }

  const { data, error } = await query

  if (error) {
    console.error("設定取得エラー:", error)
    return NextResponse.json({ error: "設定の取得に失敗しました" }, { status: 500 })
  }

  return NextResponse.json({ data })
}

// 設定追加
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const table = searchParams.get("table")

  if (!validateTable(table)) {
    return NextResponse.json(
      { error: "無効なテーブル名です" },
      { status: 400 }
    )
  }

  try {
    const body = await request.json() as Record<string, unknown>

    if (table === "settings") {
      const key = body.key
      const value = body.value
      if (typeof key !== "string") {
        return NextResponse.json({ error: "keyは必須です" }, { status: 400 })
      }

      // upsert: 既存キーがあれば更新、なければ挿入
      const { data, error } = await supabase
        .from("settings")
        .upsert(
          { key, value: value as import("@/types/database").Json ?? null, user_id: user.id },
          { onConflict: "key,user_id" }
        )
        .select()
        .single()

      if (error) {
        console.error("設定保存エラー:", error)
        return NextResponse.json({ error: "設定の保存に失敗しました" }, { status: 500 })
      }
      return NextResponse.json({ data }, { status: 201 })
    }

    if (table === "allowed_senders") {
      const email = body.email
      const display_name = body.display_name
      if (typeof email !== "string" || !email.includes("@")) {
        return NextResponse.json({ error: "有効なメールアドレスを入力してください" }, { status: 400 })
      }

      const { data, error } = await supabase
        .from("allowed_senders")
        .insert({
          email,
          display_name: typeof display_name === "string" ? display_name : null,
          user_id: user.id,
        })
        .select()
        .single()

      if (error) {
        console.error("許可送信元追加エラー:", error)
        return NextResponse.json({ error: "許可送信元の追加に失敗しました" }, { status: 500 })
      }
      return NextResponse.json({ data }, { status: 201 })
    }

    if (table === "notify_recipients") {
      const email = body.email
      const display_name = body.display_name
      if (typeof email !== "string" || !email.includes("@")) {
        return NextResponse.json({ error: "有効なメールアドレスを入力してください" }, { status: 400 })
      }

      const { data, error } = await supabase
        .from("notify_recipients")
        .insert({
          email,
          display_name: typeof display_name === "string" ? display_name : null,
          user_id: user.id,
        })
        .select()
        .single()

      if (error) {
        console.error("通知先追加エラー:", error)
        return NextResponse.json({ error: "通知先の追加に失敗しました" }, { status: 500 })
      }
      return NextResponse.json({ data }, { status: 201 })
    }

    if (table === "document_types") {
      const name = body.name
      if (typeof name !== "string" || name.trim() === "") {
        return NextResponse.json({ error: "種別名は必須です" }, { status: 400 })
      }

      const { data, error } = await supabase
        .from("document_types")
        .insert({
          name: name.trim(),
          dropbox_folder: typeof body.dropbox_folder === "string" ? body.dropbox_folder : null,
          icon: typeof body.icon === "string" ? body.icon : null,
          sort_order: typeof body.sort_order === "number" ? body.sort_order : 0,
          is_default: typeof body.is_default === "boolean" ? body.is_default : false,
          user_id: user.id,
        })
        .select()
        .single()

      if (error) {
        console.error("書類種別追加エラー:", error)
        return NextResponse.json({ error: "書類種別の追加に失敗しました" }, { status: 500 })
      }
      return NextResponse.json({ data }, { status: 201 })
    }

    // custom_folders
    const name = body.name
    if (typeof name !== "string" || name.trim() === "") {
      return NextResponse.json({ error: "フォルダ名は必須です" }, { status: 400 })
    }

    const { data, error } = await supabase
      .from("custom_folders")
      .insert({
        name: name.trim(),
        monthly: typeof body.monthly === "boolean" ? body.monthly : false,
        status_split: typeof body.status_split === "boolean" ? body.status_split : false,
        date_field: typeof body.date_field === "string" ? body.date_field : "issueDate",
        user_id: user.id,
      })
      .select()
      .single()

    if (error) {
      console.error("フォルダ追加エラー:", error)
      return NextResponse.json({ error: "フォルダの追加に失敗しました" }, { status: 500 })
    }
    return NextResponse.json({ data }, { status: 201 })
  } catch (error) {
    console.error("設定追加エラー:", error)
    return NextResponse.json({ error: "設定の追加に失敗しました" }, { status: 500 })
  }
}

// 設定更新
export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const table = searchParams.get("table")
  const id = searchParams.get("id")

  if (!validateTable(table)) {
    return NextResponse.json({ error: "無効なテーブル名です" }, { status: 400 })
  }

  if (!id) {
    return NextResponse.json({ error: "IDが必要です" }, { status: 400 })
  }

  try {
    const body = await request.json() as Record<string, unknown>

    if (table === "settings") {
      const update: Record<string, unknown> = {}
      if ("value" in body) update.value = body.value as import("@/types/database").Json ?? null
      if ("key" in body && typeof body.key === "string") update.key = body.key

      const { data, error } = await supabase
        .from("settings")
        .update(update)
        .eq("id", id)
        .eq("user_id", user.id)
        .select()
        .single()

      if (error) {
        console.error("設定更新エラー:", error)
        return NextResponse.json({ error: "設定の更新に失敗しました" }, { status: 500 })
      }
      return NextResponse.json({ data })
    }

    if (table === "allowed_senders") {
      const update: Record<string, unknown> = {}
      if (typeof body.email === "string") update.email = body.email
      if (typeof body.display_name === "string") update.display_name = body.display_name

      const { data, error } = await supabase
        .from("allowed_senders")
        .update(update)
        .eq("id", id)
        .eq("user_id", user.id)
        .select()
        .single()

      if (error) {
        console.error("許可送信元更新エラー:", error)
        return NextResponse.json({ error: "許可送信元の更新に失敗しました" }, { status: 500 })
      }
      return NextResponse.json({ data })
    }

    if (table === "notify_recipients") {
      const update: Record<string, unknown> = {}
      if (typeof body.email === "string") update.email = body.email
      if (typeof body.display_name === "string") update.display_name = body.display_name

      const { data, error } = await supabase
        .from("notify_recipients")
        .update(update)
        .eq("id", id)
        .eq("user_id", user.id)
        .select()
        .single()

      if (error) {
        console.error("通知先更新エラー:", error)
        return NextResponse.json({ error: "通知先の更新に失敗しました" }, { status: 500 })
      }
      return NextResponse.json({ data })
    }

    if (table === "document_types") {
      const update: Record<string, unknown> = {}
      if (typeof body.name === "string") update.name = body.name.trim()
      if (typeof body.dropbox_folder === "string") update.dropbox_folder = body.dropbox_folder
      if (body.dropbox_folder === null) update.dropbox_folder = null
      if (typeof body.icon === "string") update.icon = body.icon
      if (typeof body.sort_order === "number") update.sort_order = body.sort_order
      if (typeof body.is_default === "boolean") update.is_default = body.is_default

      const { data, error } = await supabase
        .from("document_types")
        .update(update)
        .eq("id", id)
        .eq("user_id", user.id)
        .select()
        .single()

      if (error) {
        console.error("書類種別更新エラー:", error)
        return NextResponse.json({ error: "書類種別の更新に失敗しました" }, { status: 500 })
      }
      return NextResponse.json({ data })
    }

    // custom_folders
    const update: Record<string, unknown> = {}
    if (typeof body.name === "string") update.name = body.name.trim()
    if (typeof body.monthly === "boolean") update.monthly = body.monthly
    if (typeof body.status_split === "boolean") update.status_split = body.status_split
    if (typeof body.date_field === "string") update.date_field = body.date_field

    const { data, error } = await supabase
      .from("custom_folders")
      .update(update)
      .eq("id", id)
      .eq("user_id", user.id)
      .select()
      .single()

    if (error) {
      console.error("フォルダ更新エラー:", error)
      return NextResponse.json({ error: "フォルダの更新に失敗しました" }, { status: 500 })
    }
    return NextResponse.json({ data })
  } catch (error) {
    console.error("設定更新エラー:", error)
    return NextResponse.json({ error: "設定の更新に失敗しました" }, { status: 500 })
  }
}

// 設定削除
export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const table = searchParams.get("table")
  const id = searchParams.get("id")

  if (!validateTable(table)) {
    return NextResponse.json({ error: "無効なテーブル名です" }, { status: 400 })
  }

  if (!id) {
    return NextResponse.json({ error: "IDが必要です" }, { status: 400 })
  }

  const { error } = await supabase
    .from(table)
    .delete()
    .eq("id", id)
    .eq("user_id", user.id)

  if (error) {
    console.error("設定削除エラー:", error)
    return NextResponse.json({ error: "設定の削除に失敗しました" }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
