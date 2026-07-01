import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { buildTaxSubmissionCsv } from "@/lib/tax-submission-csv"

/**
 * 指定年月の税理士提出フォルダについて、内容不明（DB未登録）ファイルと
 * 新旧フォルダ構造の重複除外件数を返す（CSVは生成しない軽量版）。
 *
 * 実行履歴画面（/documents/tax-copy-history）で、過去の実行結果を
 * 表示時に最新ロジックで再判定するために使う。
 *
 * GET /api/documents/tax-folder-unclear?year=2026&month=05
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "閲覧権限がありません" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const yearNum = Number(searchParams.get("year"))
  const monthNum = Number(searchParams.get("month"))

  if (!Number.isFinite(yearNum) || !Number.isFinite(monthNum)) {
    return NextResponse.json({ error: "年月を指定してください" }, { status: 400 })
  }
  if (yearNum < 2000 || yearNum > 2100) {
    return NextResponse.json({ error: "年が不正です" }, { status: 400 })
  }
  if (monthNum < 1 || monthNum > 12) {
    return NextResponse.json({ error: "月が不正です" }, { status: 400 })
  }

  try {
    const built = await buildTaxSubmissionCsv({
      supabase,
      isAdmin: auth.role === "admin",
      userId: user.id,
      year: yearNum,
      month: monthNum,
      scope: "all",
    })

    return NextResponse.json({
      data: {
        needsReviewFiles: built.needsReviewFiles,
        duplicatesRemoved: built.duplicatesRemoved,
      },
    })
  } catch (error) {
    console.error("内容不明ファイル判定エラー:", error)
    return NextResponse.json({ error: "判定に失敗しました" }, { status: 500 })
  }
}
