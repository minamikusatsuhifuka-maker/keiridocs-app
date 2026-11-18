import { NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { parseLineProfile, payrollName, hasSeparateLegalName } from "@/lib/line-staff-profile"
import { fetchAllRows } from "@/lib/supabase/fetch-all"
import type { Database } from "@/types/database"

/**
 * スタッフからの問い合わせ一覧。
 *
 * GET   … 未対応と、最近の対応済みを返す
 * PATCH … { staffMemberId, at, done } で対応済み／未対応を切り替える
 *
 * ■ なぜ必要か
 * 問い合わせは担当のLINEへ送るだけで、アプリには何も残っていなかった。
 * 担当が見落とすとどこにも残らず消えてしまい、あとから追えない。
 *
 * ■ 保存先
 * staff_members.line_profile.inquiries（DBの列は増やしていない）。
 * 件数が少ないため、全スタッフを読んで組み立てる。
 */

export const maxDuration = 30

/** サービスロールキーでRLSをバイパスするクライアント（サーバーサイドのみ） */
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Supabaseの接続情報が設定されていません")
  return createSupabaseClient<Database>(url, key)
}

interface StaffRow {
  id: string
  name: string
  legal_name: string | null
  is_test: boolean | null
  retired_at: string | null
  line_profile: unknown
}

/** 対応済みを一覧に残す日数（古いものは隠して見やすくする） */
const DONE_VISIBLE_DAYS = 30

async function fetchStaff(service: ReturnType<typeof createServiceClient>): Promise<StaffRow[]> {
  return fetchAllRows<StaffRow>((from, to) =>
    service
      .from("staff_members")
      .select("id, name, legal_name, is_test, retired_at, line_profile")
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: StaffRow[] | null
        error: { message: string } | null
      }>
  )
}

export async function GET() {
  const supabase = await createAuthClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  try {
    const service = createServiceClient()
    const staff = await fetchStaff(service)
    const cutoff = Date.now() - DONE_VISIBLE_DAYS * 24 * 60 * 60 * 1000

    const items = staff.flatMap((m) => {
      const profile = parseLineProfile(m.line_profile)
      return (profile.inquiries ?? [])
        .filter((q) => !!q?.at)
        // 対応済みは一定期間だけ残す（古いものまで並ぶと未対応が埋もれる）
        .filter((q) => !q.done_at || Date.parse(q.done_at) >= cutoff)
        .map((q) => ({
          staffMemberId: m.id,
          staffName: m.name,
          payrollName: hasSeparateLegalName(m) ? payrollName(m) : null,
          isTest: !!m.is_test,
          retired: !!m.retired_at,
          at: q.at,
          text: q.text ?? "",
          doneAt: q.done_at ?? null,
          doneBy: q.done_by ?? null,
          // 最後に担当から連絡した日時（返信済みかの目安になる）
          lastRepliedAt: lastAdminMessageAt(profile.admin_messages),
        }))
    })

    // 新しい順。未対応を先に出す
    items.sort((a, b) => {
      if (!!a.doneAt !== !!b.doneAt) return a.doneAt ? 1 : -1
      return b.at.localeCompare(a.at)
    })

    return NextResponse.json({
      items,
      openCount: items.filter((i) => !i.doneAt && !i.isTest).length,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "取得できませんでした" },
      { status: 500 }
    )
  }
}

export async function PATCH(request: Request) {
  const supabase = await createAuthClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as {
    staffMemberId?: string
    at?: string
    done?: boolean
  }
  if (!body.staffMemberId || !body.at || typeof body.done !== "boolean") {
    return NextResponse.json({ error: "対象が指定されていません" }, { status: 400 })
  }

  try {
    const service = createServiceClient()
    const { data } = await service
      .from("staff_members")
      .select("line_profile")
      .eq("id", body.staffMemberId)
      .maybeSingle()
    if (!data) return NextResponse.json({ error: "スタッフが見つかりません" }, { status: 404 })

    const profile = parseLineProfile((data as { line_profile?: unknown }).line_profile)
    const list = profile.inquiries ?? []
    if (!list.some((q) => q.at === body.at)) {
      return NextResponse.json({ error: "対象の問い合わせが見つかりません" }, { status: 404 })
    }

    const next = list.map((q) =>
      q.at === body.at
        ? body.done
          ? { ...q, done_at: new Date().toISOString(), done_by: user.email ?? "担当" }
          : { at: q.at, text: q.text } // 未対応に戻すときは対応の記録を消す
        : q
    )

    const { error } = await service
      .from("staff_members")
      .update({ line_profile: JSON.parse(JSON.stringify({ ...profile, inquiries: next })) })
      .eq("id", body.staffMemberId)
    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "保存できませんでした" },
      { status: 500 }
    )
  }
}

/** 担当から最後に連絡した日時（返信済みかの目安） */
function lastAdminMessageAt(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null
  const times = messages
    .map((m) => (m && typeof m === "object" ? (m as { at?: unknown }).at : null))
    .filter((v): v is string => typeof v === "string")
    .sort()
  return times.length > 0 ? times[times.length - 1] : null
}
