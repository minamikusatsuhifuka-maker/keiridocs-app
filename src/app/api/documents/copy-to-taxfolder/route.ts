import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { runTaxFolderCopy, ALL_SOURCE_FOLDERS } from "@/lib/tax-folder-copy"

/**
 * 指定した年月の書類を税理士提出フォルダに一括コピー（手動実行用）
 *
 * リクエスト: { year: number, month: number, folders?: string[] }
 * レスポンス: { copied, skipped, failed, total, details, csv }
 *
 * コピー本体のロジックは lib/tax-folder-copy.ts に集約
 * （自動実行 /api/cron/tax-folder-copy と共通）。
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "コピー権限がありません" }, { status: 403 })
  }

  try {
    const body = await request.json() as {
      year: unknown
      month: unknown
      folders: unknown
    }
    const yearNum = typeof body.year === "number" ? body.year : Number(body.year)
    const monthNum = typeof body.month === "number" ? body.month : Number(body.month)

    if (!Number.isFinite(yearNum) || !Number.isFinite(monthNum)) {
      return NextResponse.json({ error: "年月を指定してください" }, { status: 400 })
    }
    if (yearNum < 2000 || yearNum > 2100) {
      return NextResponse.json({ error: "年が不正です" }, { status: 400 })
    }
    if (monthNum < 1 || monthNum > 12) {
      return NextResponse.json({ error: "月が不正です" }, { status: 400 })
    }

    // 対象フォルダ（未指定 or 空の場合は全フォルダ）
    const requestedFolders = Array.isArray(body.folders)
      ? body.folders.filter((f): f is string => typeof f === "string")
      : []
    if (
      requestedFolders.length > 0 &&
      !requestedFolders.some((f) => (ALL_SOURCE_FOLDERS as readonly string[]).includes(f))
    ) {
      return NextResponse.json({ error: "対象フォルダを1つ以上選択してください" }, { status: 400 })
    }

    // 変更履歴の「変更者」に残す表示名（user_roles.display_name → メタデータ → メール）
    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("display_name")
      .eq("user_id", user.id)
      .maybeSingle()
    const runBy =
      (roleRow?.display_name as string) ||
      (user.user_metadata?.full_name as string) ||
      user.email ||
      "手動実行"

    const result = await runTaxFolderCopy({
      supabase,
      isAdmin: auth.role === "admin",
      userId: user.id,
      year: yearNum,
      month: monthNum,
      targetFolders: requestedFolders,
      runBy,
    })

    return NextResponse.json({
      copied: result.copied,
      skipped: result.skipped,
      failed: result.failed,
      total: result.total,
      details: result.details,
      csv: result.csvBody,
      csvDropboxPath: result.csvDropboxPath,
      salesCsvDropboxPath: result.salesCsvDropboxPath,
      staffSubsidyCsvDropboxPath: result.staffSubsidyCsvDropboxPath,
      csvSaveError: result.csvSaveError,
      diffSummary: result.diffSummary,
    })
  } catch (error) {
    console.error("税理士フォルダコピーエラー:", error)
    return NextResponse.json({ error: "コピー処理に失敗しました" }, { status: 500 })
  }
}
