import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { parseAiRawObject } from "@/lib/staff-receipt-split"
import type { Database } from "@/types/database"

/**
 * 「未完了の申請」を対応済みにして要対応から外す。
 *
 * POST /api/staff-reimburse/dismiss
 * body: { ids: string[], undo?: boolean }
 *
 * 未完了（スタッフが費用区分を選ばずに離脱した領収書）は、
 * 承認・却下のような確定操作が無いため要対応に残り続ける。
 * 担当が本人に確認して処理し終えたものを画面から外せるようにする。
 *
 * 記録は staff_receipts.ai_raw に持つ（列の追加が不要）。
 *   pending_dismissed_at … 対応済みにした日時
 *   pending_dismissed_by … 対応した人
 *
 * 支給（petty_cash_transactions）は作らない。
 * 支給が必要な場合は /mkadmin の「立替手動登録」で登録する。
 * undo: true で対応済みを取り消し、要対応へ戻す。
 */

export const maxDuration = 60

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Supabaseの接続情報が設定されていません")
  return createClient<Database>(url, key)
}

export async function POST(request: Request) {
  const authSupabase = await createAuthClient()
  const {
    data: { user },
    error: authError,
  } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = (await request.json()) as { ids?: unknown; undo?: unknown }
    const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === "string") : []
    if (ids.length === 0) {
      return NextResponse.json({ error: "対象が指定されていません" }, { status: 400 })
    }
    const undo = body.undo === true

    const supabase = createServiceClient()
    const now = new Date().toISOString()
    let updated = 0

    for (const id of ids) {
      const { data, error } = await supabase
        .from("staff_receipts")
        .select("ai_raw")
        .eq("id", id)
        .maybeSingle()
      if (error || !data) continue

      const current = parseAiRawObject((data as { ai_raw?: unknown }).ai_raw) ?? {}
      const next: Record<string, unknown> = { ...current }
      if (undo) {
        delete next.pending_dismissed_at
        delete next.pending_dismissed_by
      } else {
        next.pending_dismissed_at = now
        next.pending_dismissed_by = user.email ?? "担当"
      }

      const { error: updateError } = await supabase
        .from("staff_receipts")
        .update({ ai_raw: JSON.parse(JSON.stringify(next)) })
        .eq("id", id)
      if (!updateError) updated++
    }

    if (updated === 0) {
      return NextResponse.json({ error: "対象の領収書が見つかりませんでした" }, { status: 404 })
    }

    return NextResponse.json({ ok: true, updated, undo })
  } catch (e) {
    const message = e instanceof Error ? e.message : "処理できませんでした"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
