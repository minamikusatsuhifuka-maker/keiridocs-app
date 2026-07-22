import { NextRequest, NextResponse } from "next/server"
import ExcelJS from "exceljs"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { buildTaxSubmissionCsv } from "@/lib/tax-submission-csv"
import { dropboxFileUrl } from "@/lib/dropbox-web-link"

/**
 * 指定年月の税理士提出書類一覧をExcel（.xlsx）で出力する
 *
 * 仕様:
 *  - GET /api/documents/export-tax-xlsx?year=2026&month=07
 *  - 列構成はCSV（export-tax-csv）と同一
 *  - 「コピー先パス」列はDropboxウェブの該当フォルダ/ファイルを開くハイパーリンク
 *    （表示テキストはパスのまま）
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
  const { summaryLines, detailTitle, detailHeaders, detailRows, totalRow } = built.table

  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet("提出書類一覧")

  // [1] サマリーセクション
  for (const line of summaryLines) {
    sheet.addRow(line)
  }
  sheet.getRow(1).font = { bold: true }

  // [2] 空行 + 詳細タイトル
  sheet.addRow([])
  const titleRow = sheet.addRow([detailTitle])
  titleRow.font = { bold: true }

  // [3] 詳細ヘッダー
  const headerRow = sheet.addRow(detailHeaders)
  headerRow.font = { bold: true }
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } }
    cell.border = { bottom: { style: "thin" } }
  })

  // [4] 詳細行（コピー先パス列＝9列目をハイパーリンク化）
  const PATH_COL = detailHeaders.indexOf("コピー先パス") + 1
  for (const row of detailRows) {
    const added = sheet.addRow(row.cells)
    if (PATH_COL > 0 && row.path) {
      const cell = added.getCell(PATH_COL)
      cell.value = { text: row.path, hyperlink: dropboxFileUrl(row.path) }
      cell.font = { color: { argb: "FF0563C1" }, underline: true }
    }
  }

  // [5] 空行 + 合計行
  sheet.addRow([])
  const total = sheet.addRow(totalRow)
  total.font = { bold: true }

  // 列幅（No, ファイル名, 種別, 取引先, 金額, 発行日, 基準日, 税区分, 勘定科目, コピー先パス, ステータス）
  const widths = [6, 32, 14, 20, 14, 14, 22, 12, 14, 60, 18]
  widths.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w
  })

  const buffer = await workbook.xlsx.writeBuffer()
  const fileName = built.fileName.replace(/\.csv$/, ".xlsx")
  const encodedFileName = encodeURIComponent(fileName)

  return new NextResponse(Buffer.from(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodedFileName}`,
      "Cache-Control": "no-store",
    },
  })
}
