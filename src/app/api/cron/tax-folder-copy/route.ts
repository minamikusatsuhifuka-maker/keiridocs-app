import { NextRequest, NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { runTaxFolderCopy, ALL_SOURCE_FOLDERS, type CopyDetail } from "@/lib/tax-folder-copy"
import type { createClient } from "@/lib/supabase/server"
import type { Database, Json } from "@/types/database"

export const maxDuration = 300

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * 税理士フォルダ一括コピーの自動実行（Vercel Cron）
 *
 * - cron は毎日 UTC 13:00（= JST 22:00）に起動（vercel.json）。
 * - ハンドラ内で「今日がJSTで20日 または 月の最終日か」を判定し、該当日のみ当月分を実行。
 * - 認証: CRON_SECRET（Bearer）。未設定時は fail-closed で拒否。
 * - 実行結果は tax_folder_copy_runs に run_type="auto_copy" で記録し、院長LINEへ通知する。
 *
 * 動作確認用（実行日を待たずに検証する場合。CRON_SECRET 必須）:
 *   GET /api/cron/tax-folder-copy?force=20   → 20日分として即実行
 *   GET /api/cron/tax-folder-copy?force=eom  → 月末分として即実行
 */
export async function GET(request: NextRequest) {
  // 認証（fail-closed: CRON_SECRET 未設定なら常に拒否）
  const secret = process.env.CRON_SECRET
  const authHeader = request.headers.get("authorization")
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  // JST基準の日付判定（UTC日付で判定しない）
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const year = jstNow.getUTCFullYear()
  const month = jstNow.getUTCMonth() + 1 // 1-12
  const day = jstNow.getUTCDate()
  // 月の最終日（うるう年・月ごとの日数変動も Date が正しく解決する）
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()

  // 実行日判定: 20日 or 月末（force パラメータで検証用に強制実行可能）
  const force = new URL(request.url).searchParams.get("force")
  let runKind: "20日分" | "月末分" | null = null
  if (force === "20") runKind = "20日分"
  else if (force === "eom") runKind = "月末分"
  else if (day === 20) runKind = "20日分"
  else if (day === lastDayOfMonth) runKind = "月末分"

  if (!runKind) {
    return NextResponse.json({
      skipped: true,
      reason: `JST ${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} は実行日（20日・月末${lastDayOfMonth}日）ではありません`,
    })
  }

  const monthStr = String(month).padStart(2, "0")
  const serviceClient = createServiceClient()

  try {
    // 当月分を全フォルダ対象で一括コピー（手動実行と同じ本体ロジック）
    const result = await runTaxFolderCopy({
      supabase: serviceClient as unknown as SupabaseServerClient,
      isAdmin: true,
      userId: "",
      year,
      month,
      runBy: `自動実行（cron・${runKind}）`,
    })

    // 実行履歴に記録（summary は range_copy と同じ月別構造にして履歴画面で詳細表示できるようにする）
    const folderBreakdown: Record<string, { copied: number; skipped: number; failed: number }> = {}
    const failedFiles: Array<{ file_name: string; folder: string; reason?: string; year: number; month: number }> = []
    for (const d of result.details as CopyDetail[]) {
      const key = d.folder || "（未分類）"
      if (!folderBreakdown[key]) folderBreakdown[key] = { copied: 0, skipped: 0, failed: 0 }
      if (d.status === "copied") folderBreakdown[key].copied++
      else if (d.status === "skipped") folderBreakdown[key].skipped++
      else {
        folderBreakdown[key].failed++
        failedFiles.push({ file_name: d.file_name, folder: key, reason: d.message, year, month })
      }
    }
    const summary = [{
      year,
      month,
      copied: result.copied,
      skipped: result.skipped,
      failed: result.failed,
      total: result.total,
      folderBreakdown,
    }]

    await recordRun(serviceClient, {
      run_by: `自動実行（cron・${runKind}）`,
      run_type: "auto_copy",
      period: `${year}-${monthStr}`,
      summary: summary as unknown as Json,
      issues: failedFiles.length > 0 ? (failedFiles as unknown as Json) : null,
    })

    // 院長LINEへ結果通知
    const failedNote = result.failed > 0 ? `／失敗 ${result.failed}件` : ""
    // 前回提出との差分（税理士が再処理すべき変更点）も通知に含める
    const d = result.diffSummary
    const diffNote = !d
      ? ""
      : d.isFirst
        ? "\n（初回のため全件「変更なし」として記録しました）"
        : d.added === 0 && d.modified === 0 && d.removed === 0
          ? "\n前回から変更はありません"
          : `\n変更: 新規 ${d.added}件／修正 ${d.modified}件／削除 ${d.removed}件`
    await notifyAdmin(
      `✅ 税理士フォルダへ自動コピー完了（${year}年${monthStr}月・${runKind}）：` +
      `コピー ${result.copied}件／スキップ ${result.skipped}件／要確認 ${result.needsReviewCount}件${failedNote}` +
      diffNote
    )

    return NextResponse.json({
      ok: true,
      runKind,
      year,
      month,
      copied: result.copied,
      skipped: result.skipped,
      failed: result.failed,
      needsReview: result.needsReviewCount,
      diffSummary: result.diffSummary,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error("税理士フォルダ自動コピーエラー:", error)

    // 失敗も履歴に残す（range_copy互換の error 形式）
    await recordRun(serviceClient, {
      run_by: `自動実行（cron・${runKind}）`,
      run_type: "auto_copy",
      period: `${year}-${monthStr}`,
      summary: [{ year, month, copied: 0, skipped: 0, failed: 0, total: 0, folderBreakdown: {}, error: msg }] as unknown as Json,
      issues: null,
    }).catch((e) => console.error("自動コピー失敗履歴の記録エラー:", e))

    await notifyAdmin(
      `⚠️ 税理士フォルダの自動コピーに失敗しました（${year}年${monthStr}月・${runKind}）：${msg}\nアプリから手動実行してください`
    )

    return NextResponse.json({ error: "自動コピーに失敗しました" }, { status: 500 })
  }
}

/** サービスロールクライアント（RLSバイパス。履歴書込・コピー本体で使用） */
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createSupabaseClient<Database>(url, serviceKey)
}

/** 実行履歴（tax_folder_copy_runs）に1件記録する */
async function recordRun(
  serviceClient: ReturnType<typeof createServiceClient>,
  params: {
    run_by: string
    run_type: string
    period: string
    summary: Json
    issues: Json | null
  }
) {
  const { error } = await serviceClient.from("tax_folder_copy_runs").insert({
    run_by: params.run_by,
    run_type: params.run_type,
    period_start: params.period,
    period_end: params.period,
    target_folders: [...ALL_SOURCE_FOLDERS],
    summary: params.summary,
    issues: params.issues,
  })
  if (error) {
    console.error("自動コピー実行履歴の記録エラー:", error)
  }
}

/** 院長LINEへPush通知（ADMIN_LINE_USER_ID 未設定ならスキップ。既存cronと同じ方式） */
async function notifyAdmin(text: string): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  const adminId = process.env.ADMIN_LINE_USER_ID
  if (!token || !adminId) {
    console.warn("LINE通知スキップ: LINE_CHANNEL_ACCESS_TOKEN / ADMIN_LINE_USER_ID 未設定")
    return
  }
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: adminId,
        messages: [{ type: "text", text }],
      }),
    })
    if (!res.ok) {
      console.error("LINE Push送信失敗:", res.status, await res.text())
    }
  } catch (error) {
    console.error("LINE Push送信エラー:", error)
  }
}
