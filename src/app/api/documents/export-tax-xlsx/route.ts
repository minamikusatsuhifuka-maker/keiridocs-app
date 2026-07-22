import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { buildTaxSubmissionCsv } from "@/lib/tax-submission-csv"
import { buildTaxSubmissionXlsxBuffer } from "@/lib/tax-submission-xlsx"

/**
 * 指定年月の税理士提出書類一覧をExcel（.xlsx）で出力する
 *
 * 仕様:
 *  - GET /api/documents/export-tax-xlsx?year=2026&month=07
 *  - 列構成はCSV（export-tax-csv）と同一
 *  - 「コピー先パス」列はDropboxウェブの該当フォルダ/ファイルを開くハイパーリンク
 *    （生成ロジックは lib/tax-submission-xlsx.ts に集約。一括コピー時の自動保存と共通）
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

  const built = await buildTaxSubmissionCsv({
    supabase,
    isAdmin: auth.role === "admin",
    userId: user.id,
    year: yearNum,
    month: monthNum,
  })

  const buffer = await buildTaxSubmissionXlsxBuffer(built.table)
  const fileName = built.fileName.replace(/\.csv$/, ".xlsx")
  const encodedFileName = encodeURIComponent(fileName)

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodedFileName}`,
      "Cache-Control": "no-store",
    },
  })
}
