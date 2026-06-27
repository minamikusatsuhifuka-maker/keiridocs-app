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

// スタッフの「セミナー2回目以降」申請状態のトグル（ON=申請済み→初回ATC非表示 / OFF=未申請→初回ATC再表示）
// 会計履歴（petty_cash_transactions）は書き換えず、staff_members のフラグだけを切り替える（訂正・手動管理用）
// body: { id, seminar_repeat_claimed: boolean }  ON→申請日時をセット（既存は保持）/ OFF→NULL
export async function PATCH(request: NextRequest) {
  const user = await checkAuth()
  if (!user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as { id?: string; seminar_repeat_claimed?: boolean }
    if (!body.id) {
      return NextResponse.json({ error: "IDは必須です" }, { status: 400 })
    }
    if (typeof body.seminar_repeat_claimed !== "boolean") {
      return NextResponse.json({ error: "seminar_repeat_claimed（真偽値）は必須です" }, { status: 400 })
    }
    const claimed = body.seminar_repeat_claimed

    const service = createServiceClient()

    // ON要求かつ既に申請済みなら、元の申請日時を保持（上書きしない・冪等）
    if (claimed) {
      const { data: current, error: readError } = await service
        .from("staff_members")
        .select("seminar_repeat_claimed_at")
        .eq("id", body.id)
        .single()
      if (!readError) {
        const existing = (current as { seminar_repeat_claimed_at?: string | null } | null)?.seminar_repeat_claimed_at
        if (existing) {
          return NextResponse.json({ data: current })
        }
      }
    }

    const newValue = claimed ? new Date().toISOString() : null
    const { data, error } = await service
      .from("staff_members")
      .update({ seminar_repeat_claimed_at: newValue })
      .eq("id", body.id)
      .select("*")
      .single()

    if (error) {
      console.error("セミナー2回目以降状態更新エラー:", error.message, error.details, error.hint, error.code)
      // 列未適用（migration未実行）の場合は分かりやすく案内
      const isMissingColumn =
        error.code === "PGRST204" || error.code === "42703" || /seminar_repeat_claimed_at/.test(error.message || "")
      if (isMissingColumn) {
        return NextResponse.json(
          { error: "seminar_repeat_claimed_at カラムが未適用です。migration 032_seminar_repeat_claimed.sql を実行してください。" },
          { status: 400 }
        )
      }
      throw error
    }

    return NextResponse.json({ data })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error("セミナー2回目以降状態更新エラー:", msg)
    return NextResponse.json(
      { error: `セミナー2回目以降状態の更新に失敗しました: ${msg}` },
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
