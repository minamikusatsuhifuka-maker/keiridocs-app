import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"

/** 支払状態として許可する値（既存 documents.payment_status と同一） */
const ALLOWED_PAYMENT_STATUS = ["未対応", "支払い済み"] as const

/**
 * 支払状態更新 API
 * PATCH /api/documents/[id]/payment-status   body: { payment_status: "未対応" | "支払い済み" }
 * - 支払管理ページの「支払い完了」「未払いに戻す」から使用
 * - 未払い⇄支払済みの切り替え（取り消しも可能）
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  // 権限チェック: admin or staff のみ編集可（既存PATCHと同じ方式）
  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "編集権限がありません" }, { status: 403 })
  }

  let body: { payment_status?: unknown }
  try {
    body = await request.json() as { payment_status?: unknown }
  } catch {
    return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 })
  }

  const newStatus = body.payment_status
  if (typeof newStatus !== "string" || !ALLOWED_PAYMENT_STATUS.includes(newStatus as (typeof ALLOWED_PAYMENT_STATUS)[number])) {
    return NextResponse.json({ error: "不正な支払状態です" }, { status: 400 })
  }

  // 更新（adminは全件、staffは自分の書類のみ）
  let updateQuery = supabase
    .from("documents")
    .update({ payment_status: newStatus })
    .eq("id", id)
  if (auth.role !== "admin") {
    updateQuery = updateQuery.eq("user_id", user.id)
  }

  const { data, error } = await updateQuery.select().single()

  if (error) {
    console.error("支払状態更新エラー:", error)
    return NextResponse.json({ error: "支払状態の更新に失敗しました" }, { status: 500 })
  }

  return NextResponse.json({ data })
}
