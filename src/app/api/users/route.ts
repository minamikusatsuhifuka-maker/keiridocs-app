import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"

// ユーザー一覧取得（admin専用）
export async function GET() {
  const auth = await getCurrentUserRole()
  if (!auth) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }
  if (auth.role !== "admin") {
    return NextResponse.json({ error: "管理者権限が必要です" }, { status: 403 })
  }

  const supabase = await createClient()

  // user_rolesテーブルからユーザー一覧を取得
  const { data, error } = await supabase
    .from("user_roles")
    .select("*")
    .order("created_at", { ascending: true })

  if (error) {
    console.error("ユーザー一覧取得エラー:", error)
    return NextResponse.json({ error: "ユーザー一覧の取得に失敗しました" }, { status: 500 })
  }

  return NextResponse.json({ data: data ?? [] })
}

// 権限変更（admin専用）
export async function PATCH(request: NextRequest) {
  const auth = await getCurrentUserRole()
  if (!auth) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }
  if (auth.role !== "admin") {
    return NextResponse.json({ error: "管理者権限が必要です" }, { status: 403 })
  }

  try {
    const body = await request.json() as { user_id?: string; role?: string; display_name?: string }
    const { user_id, role, display_name } = body

    if (!user_id) {
      return NextResponse.json({ error: "user_idは必須です" }, { status: 400 })
    }

    const validRoles = ["admin", "staff", "viewer"]
    if (role && !validRoles.includes(role)) {
      return NextResponse.json({ error: "無効な権限です" }, { status: 400 })
    }

    // 自分自身のadmin権限は変更不可（最低1人のadminを保つ）
    if (user_id === auth.userId && role && role !== "admin") {
      return NextResponse.json({ error: "自分自身のadmin権限は変更できません" }, { status: 400 })
    }

    const supabase = await createClient()

    const update: Record<string, unknown> = {}
    if (role) update.role = role
    if (typeof display_name === "string") update.display_name = display_name

    // upsert: レコードがなければ作成、あれば更新
    const { data: existing } = await supabase
      .from("user_roles")
      .select("id")
      .eq("user_id", user_id)
      .maybeSingle()

    if (existing) {
      const { data, error } = await supabase
        .from("user_roles")
        .update(update)
        .eq("user_id", user_id)
        .select()
        .single()

      if (error) {
        console.error("権限更新エラー:", error)
        return NextResponse.json({ error: "権限の更新に失敗しました" }, { status: 500 })
      }
      return NextResponse.json({ data })
    } else {
      const { data, error } = await supabase
        .from("user_roles")
        .insert({
          user_id,
          role: role || "staff",
          display_name: display_name || null,
        })
        .select()
        .single()

      if (error) {
        console.error("権限作成エラー:", error)
        return NextResponse.json({ error: "権限の作成に失敗しました" }, { status: 500 })
      }
      return NextResponse.json({ data }, { status: 201 })
    }
  } catch (error) {
    console.error("権限変更エラー:", error)
    return NextResponse.json({ error: "権限の変更に失敗しました" }, { status: 500 })
  }
}
