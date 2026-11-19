import { NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { parseAiRawObject } from "@/lib/staff-receipt-split"
import { parseLineProfile } from "@/lib/line-staff-profile"
import type { Database } from "@/types/database"

/**
 * 申請に残っているテストの印（ai_raw.test_run_id）を外す。
 *
 * ■ なぜ必要か
 * テストを終えずに「テストスタッフ」をOFFにすると、そのあとの本物の申請にも
 * テストの印が付いてしまう。印が付いた申請は、重複判定と上限の累計を
 * そのテスト実行の中だけで行い、給与集計・会計士提出から静かに外れる。
 * 本人は申請できたのに支給されない状態になるため、担当が直せる必要がある。
 *
 * ■ 安全のための制限
 * - テストスタッフONの方は対象にしない（まだテスト中のため）
 * - 対象の申請IDを明示的に渡す（まとめて書き換えない）
 * - 記録は消さない。印を外すだけ
 */

export const maxDuration = 60

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Supabaseの接続情報が設定されていません")
  return createSupabaseClient<Database>(url, key)
}

export async function POST(request: Request) {
  const auth = await createAuthClient()
  const {
    data: { user },
  } = await auth.auth.getUser()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as { receiptIds?: unknown }
  const ids = Array.isArray(body.receiptIds)
    ? body.receiptIds.filter((v): v is string => typeof v === "string" && !!v)
    : []
  if (ids.length === 0) {
    return NextResponse.json({ error: "対象の申請が指定されていません" }, { status: 400 })
  }

  try {
    const service = createServiceClient()
    const { data, error } = await service
      .from("staff_receipts")
      .select("id, ai_raw, staff_member_id, staff_members!inner(name, is_test, line_profile)")
      .in("id", ids)
    if (error) throw error

    const rows = (data ?? []) as unknown as {
      id: string
      ai_raw: unknown
      staff_member_id: string | null
      staff_members: { name: string; is_test?: boolean | null; line_profile?: unknown }
    }[]

    let cleared = 0
    const skipped: { name: string; reason: string }[] = []

    for (const r of rows) {
      // まだテスト中の方は触らない（テストの重複判定・累計が壊れる）
      if (r.staff_members.is_test) {
        skipped.push({ name: r.staff_members.name, reason: "テストスタッフONのため" })
        continue
      }
      const raw = parseAiRawObject(r.ai_raw) ?? {}
      if (!raw.test_run_id) continue

      const next = { ...raw }
      delete next.test_run_id
      // あとから経緯が追えるように、外した記録だけ残す
      next.test_mark_cleared_at = new Date().toISOString()
      next.test_mark_cleared_by = user.email ?? "担当"

      const { error: upError } = await service
        .from("staff_receipts")
        .update({ ai_raw: JSON.parse(JSON.stringify(next)) })
        .eq("id", r.id)
      if (upError) throw upError
      cleared++
    }

    // 印が付き続ける元を止める。テスト実行が開いたままなら終える
    const staffIds = [...new Set(rows.filter((r) => !r.staff_members.is_test).map((r) => r.staff_member_id))]
    for (const sid of staffIds) {
      if (!sid) continue
      const row = rows.find((r) => r.staff_member_id === sid)
      const profile = parseLineProfile(row?.staff_members.line_profile)
      if (profile.test_run && !profile.test_run.ended_at) {
        await service
          .from("staff_members")
          .update({
            line_profile: JSON.parse(
              JSON.stringify({
                ...profile,
                test_run: { ...profile.test_run, ended_at: new Date().toISOString() },
              })
            ),
          })
          .eq("id", sid)
      }
    }

    return NextResponse.json({ cleared, skipped })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "テストの印を外せませんでした" },
      { status: 500 }
    )
  }
}
