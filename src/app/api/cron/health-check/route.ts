import { NextRequest, NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/server"
import { fileExists } from "@/lib/dropbox"
import { notifyAdmins } from "@/lib/line-admin-notify"
import type { Database } from "@/types/database"

/**
 * 外部サービスの死活確認（1日1回）。
 *
 * ■ 作る理由
 * LINEのトークンが失効した、Webhookが止まった、Dropboxの連携が切れた、
 * といった状態になってもアプリ側では気づけず、スタッフが申請できない日が
 * 何日も続く可能性があった。毎日調べて、異常があるときだけ知らせる。
 *
 * ■ 調べるもの
 *   1. LINE … トークンが有効か（/v2/bot/info）
 *   2. LINE … Webhookの宛先が設定されているか（/v2/bot/channel/webhook/endpoint）
 *   3. Dropbox … トークンでアカウント情報が取れるか
 *   4. Supabase … 書き込み系のテーブルを1件読めるか
 *
 * ■ 知らせ方
 * 異常があるときだけ担当のLINEへ送る。正常なら何も送らない
 * （毎日「正常です」が届くと読まれなくなるため）。
 */

export const maxDuration = 60

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createSupabaseClient<Database>(url, serviceKey)
}

async function checkAuth(request: NextRequest): Promise<boolean> {
  const authHeader = request.headers.get("authorization")
  if (authHeader === `Bearer ${process.env.CRON_SECRET}`) return true
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    return !!user
  } catch {
    return false
  }
}

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

/** LINEのトークンが有効か */
async function checkLineToken(): Promise<CheckResult> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) return { name: "LINEのトークン", ok: false, detail: "設定されていません" }
  try {
    const res = await fetch("https://api.line.me/v2/bot/info", {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) return { name: "LINEのトークン", ok: true, detail: "有効です" }
    return {
      name: "LINEのトークン",
      ok: false,
      detail: `無効または期限切れの可能性（${res.status}）`,
    }
  } catch (e) {
    return {
      name: "LINEのトークン",
      ok: false,
      detail: e instanceof Error ? e.message : "確認できませんでした",
    }
  }
}

/** Webhookの宛先が設定され、有効になっているか */
async function checkLineWebhook(): Promise<CheckResult> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) return { name: "LINEのWebhook", ok: false, detail: "トークンが設定されていません" }
  try {
    const res = await fetch("https://api.line.me/v2/bot/channel/webhook/endpoint", {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      return { name: "LINEのWebhook", ok: false, detail: `設定を取得できません（${res.status}）` }
    }
    const json = (await res.json()) as { endpoint?: string; active?: boolean }
    if (!json.endpoint) {
      return { name: "LINEのWebhook", ok: false, detail: "宛先が設定されていません" }
    }
    if (json.active === false) {
      return { name: "LINEのWebhook", ok: false, detail: "宛先が無効になっています" }
    }
    return { name: "LINEのWebhook", ok: true, detail: "設定されています" }
  } catch (e) {
    return {
      name: "LINEのWebhook",
      ok: false,
      detail: e instanceof Error ? e.message : "確認できませんでした",
    }
  }
}

/**
 * Dropboxの連携が生きているか。
 *
 * fileExists で実在するフォルダを1つ見に行く。
 * トークンの更新（src/lib/dropbox.ts 側で行う）が失敗していればここで落ちるため、
 * トークンの経路を作り直さずに同じ仕組みで確認できる。
 */
async function checkDropbox(): Promise<CheckResult> {
  try {
    await fileExists("/経理書類")
    return { name: "Dropboxの連携", ok: true, detail: "有効です" }
  } catch (e) {
    return {
      name: "Dropboxの連携",
      ok: false,
      detail: e instanceof Error ? e.message.slice(0, 120) : "確認できませんでした",
    }
  }
}

/** データベースに読み書きできるか */
async function checkDatabase(): Promise<CheckResult> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase.from("staff_members").select("id").limit(1)
    if (error) return { name: "データベース", ok: false, detail: error.message.slice(0, 120) }
    return { name: "データベース", ok: true, detail: "応答しています" }
  } catch (e) {
    return {
      name: "データベース",
      ok: false,
      detail: e instanceof Error ? e.message : "確認できませんでした",
    }
  }
}

export async function GET(request: NextRequest) {
  if (!(await checkAuth(request))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const results = await Promise.all([
    checkLineToken(),
    checkLineWebhook(),
    checkDropbox(),
    checkDatabase(),
  ])
  const failures = results.filter((r) => !r.ok)

  // 異常があるときだけ知らせる（毎日「正常です」は読まれなくなるため）
  let notified = false
  if (failures.length > 0) {
    // 申請できない状態は担当も困るため、院長と受付担当の両方へ送る
    notified =
      (await notifyAdmins(
        createServiceClient() as never,
        "⚠️【経費申請アプリの異常】\n" +
        "次の確認で問題が見つかりました。\n\n" +
        failures.map((f) => `・${f.name}：${f.detail}`).join("\n") +
          "\n\nこの状態だと、スタッフが申請できない、または領収書が保存されない\n" +
          "可能性があります。設定のご確認をお願いします。"
      )) > 0
  }

  return NextResponse.json({
    ok: failures.length === 0,
    results,
    notified,
  })
}
