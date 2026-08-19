import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { buildTaxSubmissionCsv } from "@/lib/tax-submission-csv"
import { loadSnapshots, periodOf } from "@/lib/tax-submission-snapshot"

/**
 * 指定年月の税理士提出書類一覧をCSVで出力する
 *
 * 仕様:
 *  - GET /api/documents/export-tax-csv?year=2026&month=04
 *  - /経理書類/税理士提出/{YYYY年MM月}/ 内のファイルを一覧化
 *  - DB（documentsテーブル）からメタデータを補完
 *  - UTF-8 BOM付き CSV を返す（Excel対応）
 *  - 列: No, ファイル名, 種別, 取引先, 金額, 発行日, 税区分, 勘定科目, コピー先パス
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

  const { fileName, csvWithBom } = await buildTaxSubmissionCsv({
    supabase,
    isAdmin: auth.role === "admin",
    userId: user.id,
    year: yearNum,
    month: monthNum,
    // 状態・更新日・変更内容の列は前回の提出内容との比較で決まる（保存はしない）
    snapshots: await loadSnapshots(periodOf(yearNum, monthNum), "all"),
    runBy: "ダウンロード時点",
  })

  const encodedFileName = encodeURIComponent(fileName)

  return new NextResponse(csvWithBom, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodedFileName}`,
      "Cache-Control": "no-store",
    },
  })
}
