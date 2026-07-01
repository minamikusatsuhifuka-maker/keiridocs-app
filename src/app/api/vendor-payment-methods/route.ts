import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/staff-refund-core"
import { getCurrentUserRole } from "@/lib/auth"
import { MASTER_METHODS } from "@/lib/payment-methods"

export const runtime = "nodejs"

/** 認証・権限チェック（admin/staff のみ書込み可） */
async function requireStaff() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return { error: NextResponse.json({ error: "認証が必要です" }, { status: 401 }) }
  }
  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return { error: NextResponse.json({ error: "権限がありません" }, { status: 403 }) }
  }
  return { user }
}

/**
 * 支払先マスタ一覧を取得
 * クエリ: ?method=口座振替 で絞り込み可（省略時は全件）
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const method = request.nextUrl.searchParams.get("method")

  let query = supabase
    .from("vendor_payment_methods")
    .select("vendor_name, method, updated_at")
    .order("updated_at", { ascending: false })

  if (method && (MASTER_METHODS as readonly string[]).includes(method)) {
    query = query.eq("method", method)
  }

  const { data, error } = await query
  if (error) {
    console.error("支払先マスタ取得エラー:", error)
    return NextResponse.json({ error: "支払先マスタの取得に失敗しました" }, { status: 500 })
  }

  return NextResponse.json({ vendors: data ?? [] })
}

/**
 * 支払先の支払方法を登録/更新（upsert）
 * リクエスト: { vendor_name: string, method: '都度振込' | '口座振替' | 'その他' }
 */
export async function POST(request: NextRequest) {
  const guard = await requireStaff()
  if ("error" in guard) return guard.error

  try {
    const body = await request.json() as { vendor_name?: unknown; method?: unknown }
    const vendorName = typeof body.vendor_name === "string" ? body.vendor_name.trim() : ""
    const method = typeof body.method === "string" ? body.method : ""

    if (!vendorName) {
      return NextResponse.json({ error: "支払先名を指定してください" }, { status: 400 })
    }
    if (!(MASTER_METHODS as readonly string[]).includes(method)) {
      return NextResponse.json({ error: "支払方法が不正です" }, { status: 400 })
    }

    const service = createServiceClient()
    const nowIso = new Date().toISOString()
    const { data, error } = await service
      .from("vendor_payment_methods")
      .upsert(
        { vendor_name: vendorName, method, updated_at: nowIso },
        { onConflict: "vendor_name" }
      )
      .select("vendor_name, method, updated_at")
      .single()

    if (error) {
      console.error("支払先マスタ更新エラー:", error)
      return NextResponse.json({ error: "支払先マスタの更新に失敗しました" }, { status: 500 })
    }

    return NextResponse.json({ vendor: data })
  } catch (error) {
    console.error("支払先マスタ更新エラー:", error)
    return NextResponse.json({ error: "支払先マスタの更新に失敗しました" }, { status: 500 })
  }
}

/**
 * 支払先マスタの登録を解除（削除）
 * クエリ: ?vendor_name=... または リクエスト: { vendor_name }
 */
export async function DELETE(request: NextRequest) {
  const guard = await requireStaff()
  if ("error" in guard) return guard.error

  try {
    let vendorName = request.nextUrl.searchParams.get("vendor_name")?.trim() ?? ""
    if (!vendorName) {
      const body = await request.json().catch(() => ({})) as { vendor_name?: unknown }
      vendorName = typeof body.vendor_name === "string" ? body.vendor_name.trim() : ""
    }
    if (!vendorName) {
      return NextResponse.json({ error: "支払先名を指定してください" }, { status: 400 })
    }

    const service = createServiceClient()
    const { error } = await service
      .from("vendor_payment_methods")
      .delete()
      .eq("vendor_name", vendorName)

    if (error) {
      console.error("支払先マスタ削除エラー:", error)
      return NextResponse.json({ error: "支払先マスタの削除に失敗しました" }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("支払先マスタ削除エラー:", error)
    return NextResponse.json({ error: "支払先マスタの削除に失敗しました" }, { status: 500 })
  }
}
