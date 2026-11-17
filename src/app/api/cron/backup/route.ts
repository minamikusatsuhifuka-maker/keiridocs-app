import { NextRequest, NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/server"
import { fetchAllRows } from "@/lib/supabase/fetch-all"
import { uploadFileOverwrite, deleteFile } from "@/lib/dropbox"
import type { Database } from "@/types/database"

/**
 * データのバックアップ（1日1回・Dropboxへ）。
 *
 * ■ 作る理由
 * 領収書の画像はDropboxにあるが、金額・支給額・スタッフ・設定は
 * データベースにしかない。片方だけでは復旧できない。
 * 誤って削除した場合や、データベースに障害が起きた場合に戻せるよう、
 * 主要なテーブルを毎日書き出して領収書と同じ場所に置く。
 *
 * ■ 置き場所
 *   /経理書類/バックアップ/YYYY-MM-DD/<テーブル名>.json
 *
 * ■ 保存期間
 * BACKUP_RETENTION_DAYS 日より古いものは消す（際限なく増えないようにする）。
 *
 * ■ 安全のため
 * - トークンや秘密鍵が入りうる設定値は伏せて書き出す（REDACT_KEY_PATTERN）
 * - 認証情報そのもの（auth スキーマ）は対象にしない
 */

export const maxDuration = 300

/** 書き出す対象。経理の記録として復旧に必要なものだけ */
const TABLES = [
  "staff_members",
  "staff_receipts",
  "petty_cash_transactions",
  "courses",
  "documents",
  "allowed_senders",
  "notify_recipients",
  "custom_folders",
  "settings",
] as const

/** 何日分を残すか */
const BACKUP_RETENTION_DAYS = 30

/** この語を含む設定キーは中身を伏せる（トークン・秘密鍵の流出を防ぐ） */
const REDACT_KEY_PATTERN = /token|secret|password|credential|api_?key|refresh/i

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

async function push(text: string): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  const to = process.env.ADMIN_LINE_USER_ID
  if (!token || !to) return
  try {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
    })
  } catch {
    // 通知できなくてもバックアップ自体の結果は返す
  }
}

/** JSTの日付（YYYY-MM-DD） */
function jstDate(offsetDays = 0): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000 - offsetDays * 86400000)
  return d.toISOString().slice(0, 10)
}

/** 設定値のうち、トークン類を伏せる */
function redactSettings(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const key = typeof row.key === "string" ? row.key : ""
    if (REDACT_KEY_PATTERN.test(key)) {
      return { ...row, value: "***（バックアップでは伏せています）***" }
    }
    return row
  })
}

export async function GET(request: NextRequest) {
  if (!(await checkAuth(request))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const supabase = createServiceClient()
  const today = jstDate()
  const base = `/経理書類/バックアップ/${today}`
  const results: { table: string; rows: number; ok: boolean; error?: string }[] = []

  for (const table of TABLES) {
    try {
      // 全件を取る（PostgRESTの1000件上限で静かに打ち切られるのを防ぐ）
      const rows = await fetchAllRows<Record<string, unknown>>((from, to) =>
        supabase
          .from(table)
          .select("*")
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
            data: Record<string, unknown>[] | null
            error: { message: string } | null
          }>
      )
      const payload = table === "settings" ? redactSettings(rows) : rows
      const body = JSON.stringify(
        { table, exported_at: new Date().toISOString(), count: payload.length, rows: payload },
        null,
        2
      )
      await uploadFileOverwrite(`${base}/${table}.json`, Buffer.from(body, "utf-8"))
      results.push({ table, rows: payload.length, ok: true })
    } catch (e) {
      const message = e instanceof Error ? e.message : "書き出せませんでした"
      console.error(`[backup] ${table}:`, message)
      results.push({ table, rows: 0, ok: false, error: message.slice(0, 160) })
    }
  }

  // 古いバックアップを消す（際限なく増えないように）
  let deleted = 0
  try {
    const target = `/経理書類/バックアップ/${jstDate(BACKUP_RETENTION_DAYS)}`
    await deleteFile(target)
    deleted = 1
  } catch {
    // その日のバックアップが無いだけなので何もしない
  }

  const failures = results.filter((r) => !r.ok)
  if (failures.length > 0) {
    await push(
      "⚠️【バックアップの失敗】\n" +
        `${today} のバックアップで ${failures.length}件 書き出せませんでした。\n\n` +
        failures.map((f) => `・${f.table}：${f.error}`).join("\n") +
        "\n\nDropboxの連携や容量をご確認ください。"
    )
  }

  return NextResponse.json({
    ok: failures.length === 0,
    date: today,
    folder: base,
    results,
    deletedOldFolder: deleted > 0,
  })
}
