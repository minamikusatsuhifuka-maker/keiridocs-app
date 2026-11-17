import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import type { Database } from "@/types/database"

/**
 * 担当からスタッフへLINEで連絡する。
 *
 * POST /api/line/notify-staff
 * body: { staffMemberId, text }
 *
 * 要対応の行から直接送れるようにするための窓口。
 * 「金額が読み取れないので撮り直してほしい」「この費用の内容を教えてほしい」
 * といったやり取りのために、画面を離れずに連絡できるようにする。
 *
 * 送った相手・本文は petty_cash ではなく staff_members.line_profile に
 * 履歴として残す（誰にいつ何を送ったかが分からないと、二重連絡になるため）。
 */

export const maxDuration = 60

/** 1回の連絡の長さの上限（LINEの制限より十分短く） */
const MAX_LENGTH = 1000

/** 残す履歴の件数（増え続けないように古いものから捨てる） */
const HISTORY_LIMIT = 20

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
  } = await authSupabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  try {
    const body = (await request.json()) as { staffMemberId?: string; text?: string }
    const staffMemberId = body.staffMemberId
    const text = (body.text ?? "").trim()

    if (!staffMemberId) {
      return NextResponse.json({ error: "スタッフが指定されていません" }, { status: 400 })
    }
    if (!text) {
      return NextResponse.json({ error: "本文を入力してください" }, { status: 400 })
    }
    if (text.length > MAX_LENGTH) {
      return NextResponse.json({ error: `本文は${MAX_LENGTH}文字以内にしてください` }, { status: 400 })
    }

    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
    if (!token) {
      return NextResponse.json({ error: "LINEの設定がされていません" }, { status: 500 })
    }

    const service = createServiceClient()
    const { data: member, error } = await service
      .from("staff_members")
      .select("id, name, line_user_id, line_profile")
      .eq("id", staffMemberId)
      .maybeSingle()
    if (error || !member) {
      return NextResponse.json({ error: "スタッフが見つかりません" }, { status: 404 })
    }

    const m = member as unknown as {
      id: string
      name: string
      line_user_id: string | null
      line_profile?: unknown
    }
    if (!m.line_user_id) {
      return NextResponse.json(
        { error: `${m.name}さんはLINEが未登録のため送れません` },
        { status: 400 }
      )
    }

    // 担当からの連絡だと分かるようにして送る（自動のお知らせと区別するため）
    const message = `【担当からのご連絡】\n${text}`
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: m.line_user_id, messages: [{ type: "text", text: message }] }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      console.error("[notify-staff] LINE送信エラー:", res.status, detail)
      return NextResponse.json(
        { error: `送信できませんでした（${res.status}）` },
        { status: 502 }
      )
    }

    // 送信履歴を残す（二重連絡を避けるため、画面で「最後にいつ送ったか」を出す）
    try {
      const profile =
        (m.line_profile && typeof m.line_profile === "object"
          ? (m.line_profile as Record<string, unknown>)
          : {}) ?? {}
      const history = Array.isArray(profile.admin_messages) ? profile.admin_messages : []
      const next = [
        ...history,
        { at: new Date().toISOString(), by: user.email ?? "担当", text: text.slice(0, 200) },
      ].slice(-HISTORY_LIMIT)
      await service
        .from("staff_members")
        .update({
          line_profile: JSON.parse(JSON.stringify({ ...profile, admin_messages: next })),
        })
        .eq("id", m.id)
    } catch (e) {
      // 履歴が残らなくても連絡自体は済んでいるので、処理は止めない
      console.warn("[notify-staff] 履歴の保存に失敗:", e)
    }

    return NextResponse.json({ ok: true, name: m.name })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "送信できませんでした" },
      { status: 500 }
    )
  }
}
