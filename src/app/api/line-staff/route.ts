import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"

/** サービスロールキーでRLSをバイパスするSupabaseクライアント */
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createSupabaseClient<Database>(url, serviceKey)
}

/** 認証チェック（通常クライアントで行う） */
async function checkAuth() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

// スタッフ一覧取得（全カラム取得でline_user_idを確実に含む）
export async function GET() {
  const user = await checkAuth()
  if (!user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const service = createServiceClient()
    const { data, error } = await service
      .from("staff_members")
      .select("*")
      .order("created_at", { ascending: true })

    if (error) {
      console.error("LINEスタッフ一覧取得エラー:", error.message, error.details, error.hint)
      throw error
    }

    return NextResponse.json({ data })
  } catch (error) {
    console.error("LINEスタッフ一覧取得エラー:", error)
    return NextResponse.json(
      { error: "スタッフ一覧の取得に失敗しました" },
      { status: 500 }
    )
  }
}

// 新規スタッフ追加（サービスロールでRLSバイパス）
export async function POST(request: NextRequest) {
  const user = await checkAuth()
  if (!user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as { name?: string }
    const name = body.name?.trim()

    if (!name) {
      return NextResponse.json({ error: "名前は必須です" }, { status: 400 })
    }

    const service = createServiceClient()
    const { data, error } = await service
      .from("staff_members")
      .insert({ name })
      .select("*")
      .single()

    if (error) {
      console.error("スタッフ追加エラー:", error.message, error.details, error.hint, error.code)
      throw error
    }

    console.log("スタッフ追加成功:", data)
    return NextResponse.json({ data })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error("スタッフ追加エラー:", msg)
    return NextResponse.json(
      { error: `スタッフの追加に失敗しました: ${msg}` },
      { status: 500 }
    )
  }
}

// スタッフ更新（名前・line_user_id）
export async function PUT(request: NextRequest) {
  const user = await checkAuth()
  if (!user) {
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

    const service = createServiceClient()
    const { data, error } = await service
      .from("staff_members")
      .update(updates)
      .eq("id", body.id)
      .select("*")
      .single()

    if (error) {
      console.error("スタッフ更新エラー:", error.message, error.details, error.hint, error.code)
      throw error
    }

    return NextResponse.json({ data })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error("スタッフ更新エラー:", msg)
    return NextResponse.json(
      { error: `スタッフの更新に失敗しました: ${msg}` },
      { status: 500 }
    )
  }
}

// スタッフの初回ATC申請状態の操作（現状は「未申請に戻す」= フラグのクリアのみ）
// 会計履歴（petty_cash_transactions）は書き換えず、staff_members のフラグだけを戻す（訂正用）
export async function PATCH(request: NextRequest) {
  const user = await checkAuth()
  if (!user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as { id?: string; action?: string }
    if (!body.id) {
      return NextResponse.json({ error: "IDは必須です" }, { status: 400 })
    }
    if (body.action !== "clear_first_atc") {
      return NextResponse.json({ error: "不正な操作です" }, { status: 400 })
    }

    const service = createServiceClient()
    const { data, error } = await service
      .from("staff_members")
      .update({ first_atc_claimed_at: null })
      .eq("id", body.id)
      .select("*")
      .single()

    if (error) {
      console.error("初回ATC状態クリアエラー:", error.message, error.details, error.hint, error.code)
      // 列未適用（migration 031未実行）の場合は分かりやすく案内
      const isMissingColumn =
        error.code === "PGRST204" || error.code === "42703" || /first_atc_claimed_at/.test(error.message || "")
      if (isMissingColumn) {
        return NextResponse.json(
          { error: "first_atc_claimed_at カラムが未適用です。migration 031 を実行してください。" },
          { status: 400 }
        )
      }
      throw error
    }

    return NextResponse.json({ data })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error("初回ATC状態クリアエラー:", msg)
    return NextResponse.json(
      { error: `初回ATC状態の更新に失敗しました: ${msg}` },
      { status: 500 }
    )
  }
}

// スタッフ削除
export async function DELETE(request: NextRequest) {
  const user = await checkAuth()
  if (!user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get("id")

    if (!id) {
      return NextResponse.json({ error: "IDは必須です" }, { status: 400 })
    }

    const service = createServiceClient()
    const { error } = await service
      .from("staff_members")
      .delete()
      .eq("id", id)

    if (error) {
      console.error("スタッフ削除エラー:", error.message, error.details, error.hint, error.code)
      throw error
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error("スタッフ削除エラー:", msg)
    return NextResponse.json(
      { error: `スタッフの削除に失敗しました: ${msg}` },
      { status: 500 }
    )
  }
}
