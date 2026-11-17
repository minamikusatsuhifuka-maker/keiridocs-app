import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import type { Database } from "@/types/database"

/**
 * スタッフ立替明細の「確認済み」記録。
 *
 * POST /api/staff-reimburse/review
 *   { ids: string[], reviewed: boolean }
 *   ids は petty_cash_transactions.id（明細1行ごと。分割登録は行ごとに確認する）。
 *   reviewed=true で確認済み、false で取り消し。
 *
 * この記録は担当の進捗管理のためだけに使う。
 * 支給額・税理士提出・自動コピーの挙動は一切変えない（締めに間に合わない事故を防ぐため）。
 */

/** 書き込みはサービスロールで行う（RLSの影響を受けずに確実に更新するため） */
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Supabaseの接続情報が設定されていません")
  return createClient<Database>(url, key)
}

export async function POST(request: NextRequest) {
  const authSupabase = await createAuthClient()
  const {
    data: { user },
    error: authError,
  } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }
  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "変更権限がありません" }, { status: 403 })
  }

  let body: { ids?: unknown; reviewed?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 })
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === "string") : []
  if (ids.length === 0) {
    return NextResponse.json({ error: "対象が選択されていません" }, { status: 400 })
  }
  if (typeof body.reviewed !== "boolean") {
    return NextResponse.json({ error: "確認状態の指定が不正です" }, { status: 400 })
  }
  const reviewed = body.reviewed

  // 確認者は表示用の名前（なければメールアドレス）
  const reviewerName =
    (typeof user.user_metadata?.full_name === "string" && user.user_metadata.full_name) ||
    user.email ||
    "不明"

  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from("petty_cash_transactions")
      .update(
        reviewed
          ? { reviewed_at: new Date().toISOString(), reviewed_by: reviewerName }
          : { reviewed_at: null, reviewed_by: null }
      )
      .in("id", ids)
      .eq("category", "staff_refund")

    if (error) {
      // migration 042 未適用のときは列が無いというエラーになる。原因が分かる文言で返す。
      if (/reviewed_at|reviewed_by|column/i.test(error.message)) {
        return NextResponse.json(
          {
            error:
              "確認機能のDB更新（042_staff_reimburse_review.sql）がまだ実行されていません。Supabase の SQL Editor で実行してください。",
          },
          { status: 409 }
        )
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      updated: ids.length,
      reviewed,
      reviewedBy: reviewed ? reviewerName : null,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "確認状態を更新できませんでした"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
