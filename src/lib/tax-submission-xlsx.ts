// 税理士提出書類一覧のExcel（.xlsx）生成（共通ロジック）。
// ダウンロードAPI（export-tax-xlsx）と一括コピー時のDropbox自動保存の両方から使う。
// 列構成はCSV（buildTaxSubmissionCsv）と同一で、「コピー先パス」列は
// Dropboxウェブを開くハイパーリンクとして埋め込む（表示テキストはパスのまま）。

import ExcelJS from "exceljs"
import { dropboxFileUrl } from "@/lib/dropbox-web-link"

/** buildTaxSubmissionCsv の table フィールドと同じ構造 */
export interface TaxSubmissionTable {
  summaryLines: string[][]
  detailTitle: string
  detailHeaders: string[]
  detailRows: Array<{ cells: string[]; path: string }>
  totalRow: string[]
}

/** 列幅（detailHeaders のラベル → 幅）。未定義のラベルは既定幅 */
const COLUMN_WIDTHS: Record<string, number> = {
  "No": 6,
  "ファイル名": 32,
  "種別": 14,
  "取引先 / 振込元": 20,
  "支払先（店名）": 24,
  "目的・用途": 18,
  "金額 / 振込金額": 14,
  "支給割合": 10,
  "支給額": 12,
  "発行日 / 振込日": 14,
  "基準日（月割り判定）": 22,
  "税区分": 12,
  "勘定科目": 14,
  "コピー先パス": 60,
  "ステータス": 18,
}

/** 提出書類一覧の xlsx バッファを生成する */
export async function buildTaxSubmissionXlsxBuffer(table: TaxSubmissionTable): Promise<Buffer> {
  const { summaryLines, detailTitle, detailHeaders, detailRows, totalRow } = table

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

  // [4] 詳細行（コピー先パス列をハイパーリンク化）
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

  // 列幅（ヘッダーラベルに応じて設定。列構成が変わっても自動で追従する）
  detailHeaders.forEach((label, i) => {
    sheet.getColumn(i + 1).width = COLUMN_WIDTHS[label] ?? 16
  })

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}
