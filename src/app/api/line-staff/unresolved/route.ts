import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { parseAiRawObject } from "@/lib/staff-receipt-split"
import type { Database } from "@/types/database"

/**
 * そのスタッフに未処理の申請が残っていないかを返す。
 *
 * GET /api/line-staff/unresolved?id=<staff_members.id>
 *
 * 退職にすると一覧から隠れ、LINEからの申請も受け付けなくなる。
 * そのとき未確定の申請が残っていると、支給されないまま誰も気づかなくなるため、
 * 退職の操作の前に件数を出して確認できるようにする。
 *
 * 返すもの:
 *   held      … 確認待ちの申請（上限超過・講座の確認・添付待ちなど）
 *   incomplete… 区分が選ばれていない領収書（支給の対象になっていない）
 */

export const maxDuration = 60

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Supabaseの接続情報が設定されていません")
  return createClient<Database>(url, key)
}

export async function GET(request: Request) {
  const authSupabase = await createAuthClient()
  const {
    data: { user },
  } = await authSupabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  const id = new URL(request.url).searchParams.get("id")
  if (!id) return NextResponse.json({ error: "IDが指定されていません" }, { status: 400 })

  try {
    const service = createServiceClient()

    // 1. 確認待ちの申請（hold_reason が入っているもの）
    let held = 0
    const { data: holdRows, error: holdError } = await service
      .from("petty_cash_transactions")
      .select("id")
      .eq("category", "staff_refund")
      .eq("staff_member_id", id)
      .not("hold_reason", "is", null)
    if (!holdError) held = holdRows?.length ?? 0

    // 2. 区分が選ばれていない領収書（精算が作られていないもの）
    const { data: receipts } = await service
      .from("staff_receipts")
      .select("id, ai_raw")
      .eq("staff_member_id", id)
    const receiptIds = (receipts ?? []).map((r) => (r as { id: string }).id)

    let incomplete = 0
    if (receiptIds.length > 0) {
      const { data: settledRows } = await service
        .from("petty_cash_transactions")
        .select("staff_receipt_id")
        .in("staff_receipt_id", receiptIds)
      const settled = new Set(
        (settledRows ?? [])
          .map((t) => (t as { staff_receipt_id: string | null }).staff_receipt_id)
          .filter((v): v is string => !!v)
      )
      incomplete = (receipts ?? []).filter((r) => {
        const row = r as { id: string; ai_raw?: unknown }
        if (settled.has(row.id)) return false
        // 担当が「対応済み」にしたものは残っていても問題ない
        return !parseAiRawObject(row.ai_raw)?.pending_dismissed_at
      }).length
    }

    return NextResponse.json({ held, incomplete, total: held + incomplete })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "確認できませんでした" },
      { status: 500 }
    )
  }
}
