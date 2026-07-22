// 税理士提出書類一覧のExcel（.xlsx）生成（共通ロジック）。
// ダウンロードAPI（export-tax-xlsx）と一括コピー時のDropbox自動保存の両方から使う。
//
// シート構成:
//   1. サマリー     … 種別別 件数・合計金額・支給額合計・要確認件数・総合計
//   2. スタッフ立替 … スタッフ領収書の明細＋スタッフ別小計＋合計（該当行が無い場合は省略）
//   3. 経費書類     … スタッフ領収書以外の明細（要確認行含む。ステータス列で判別）
// 「コピー先パス」列は全シートでDropboxウェブを開くハイパーリンク。

import ExcelJS from "exceljs"
import { dropboxFileUrl } from "@/lib/dropbox-web-link"
import type { TaxListRow } from "@/lib/tax-submission-csv"

/** buildTaxSubmissionCsv の table フィールドと同じ構造 */
export interface TaxSubmissionTable {
  summaryLines: string[][]
  detailTitle: string
  detailHeaders: string[]
  detailRows: Array<{ cells: string[]; path: string }>
  totalRow: string[]
  rows: TaxListRow[]
}

/** 列幅（ヘッダーラベル → 幅）。未定義のラベルは既定幅 */
const COLUMN_WIDTHS: Record<string, number> = {
  "No": 6,
  "ファイル名": 32,
  "種別": 14,
  "取引先 / 振込元": 20,
  "対象スタッフ": 14,
  "支払先（店名）": 24,
  "目的・用途": 18,
  "金額 / 振込金額": 14,
  "金額（立替額）": 14,
  "支給割合": 10,
  "支給額": 12,
  "発行日 / 振込日": 14,
  "発行日（支払日）": 14,
  "取り込み日": 12,
  "基準日（月割り判定）": 22,
  "税区分": 12,
  "勘定科目": 14,
  "コピー先パス": 60,
  "ステータス": 18,
}

function formatAmount(amount: number | null): string {
  if (amount === null || amount === undefined) return ""
  return `¥${amount.toLocaleString()}`
}

/** ヘッダー行を追加してスタイルを整える */
function addHeaderRow(sheet: ExcelJS.Worksheet, headers: string[]): void {
  const headerRow = sheet.addRow(headers)
  headerRow.font = { bold: true }
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } }
    cell.border = { bottom: { style: "thin" } }
  })
  headers.forEach((label, i) => {
    sheet.getColumn(i + 1).width = COLUMN_WIDTHS[label] ?? 16
  })
}

/** コピー先パスのセルをDropboxウェブへのハイパーリンクにする */
function linkifyPathCell(row: ExcelJS.Row, pathCol: number, path: string): void {
  if (pathCol <= 0 || !path) return
  const cell = row.getCell(pathCol)
  cell.value = { text: path, hyperlink: dropboxFileUrl(path) }
  cell.font = { color: { argb: "FF0563C1" }, underline: true }
}

/** 提出書類一覧の xlsx バッファを生成する（3シート構成） */
export async function buildTaxSubmissionXlsxBuffer(table: TaxSubmissionTable): Promise<Buffer> {
  const { summaryLines, rows } = table

  const workbook = new ExcelJS.Workbook()

  /* ---------- 1枚目: サマリー ---------- */
  const summarySheet = workbook.addWorksheet("サマリー")
  for (const line of summaryLines) {
    summarySheet.addRow(line)
  }
  summarySheet.getRow(1).font = { bold: true }
  ;[34, 10, 16, 24].forEach((w, i) => {
    summarySheet.getColumn(i + 1).width = w
  })

  /* ---------- 2枚目: スタッフ立替（該当行がある場合のみ） ---------- */
  const staffRows = rows.filter((r) => r.type === "スタッフ領収書")
  if (staffRows.length > 0) {
    const sheet = workbook.addWorksheet("スタッフ立替")
    const headers = [
      "No", "ファイル名", "対象スタッフ", "支払先（店名）", "目的・用途",
      "金額（立替額）", "支給割合", "支給額",
      "発行日（支払日）", "取り込み日", "基準日（月割り判定）", "税区分", "勘定科目", "コピー先パス",
    ]
    addHeaderRow(sheet, headers)
    const PATH_COL = headers.indexOf("コピー先パス") + 1
    const AMOUNT_COL = headers.indexOf("金額（立替額）") + 1
    const SUBSIDY_COL = headers.indexOf("支給額") + 1

    staffRows.forEach((r, i) => {
      const added = sheet.addRow([
        String(i + 1),
        r.fileName,
        r.vendor,
        r.storeName,
        r.expenseDetail,
        formatAmount(r.amount),
        r.subsidyLabel,
        formatAmount(r.subsidyAmount),
        r.date,
        r.createdDate,
        r.baseDate,
        r.taxCategory,
        r.accountTitle,
        r.path,
      ])
      linkifyPathCell(added, PATH_COL, r.path)
    })

    // 末尾: スタッフごとの小計（立替額・支給額）＋合計行
    sheet.addRow([])
    const byStaff = new Map<string, { amount: number; subsidy: number; count: number }>()
    for (const r of staffRows) {
      const key = r.vendor || "（不明）"
      const cur = byStaff.get(key) ?? { amount: 0, subsidy: 0, count: 0 }
      byStaff.set(key, {
        amount: cur.amount + (r.amount ?? 0),
        subsidy: cur.subsidy + (r.subsidyAmount ?? 0),
        count: cur.count + 1,
      })
    }
    for (const [staff, sums] of byStaff.entries()) {
      const subtotal = sheet.addRow([])
      subtotal.getCell(1).value = "小計"
      subtotal.getCell(3).value = staff
      subtotal.getCell(5).value = `${sums.count}件`
      subtotal.getCell(AMOUNT_COL).value = formatAmount(sums.amount)
      subtotal.getCell(SUBSIDY_COL).value = formatAmount(sums.subsidy)
      subtotal.font = { bold: true }
    }
    const totalAmount = staffRows.reduce((s, r) => s + (r.amount ?? 0), 0)
    const totalSubsidy = staffRows.reduce((s, r) => s + (r.subsidyAmount ?? 0), 0)
    const totalRow = sheet.addRow([])
    totalRow.getCell(1).value = "合計"
    totalRow.getCell(5).value = `${staffRows.length}件`
    totalRow.getCell(AMOUNT_COL).value = formatAmount(totalAmount)
    totalRow.getCell(SUBSIDY_COL).value = formatAmount(totalSubsidy)
    totalRow.font = { bold: true }
    totalRow.eachCell((cell) => {
      cell.border = { top: { style: "thin" } }
    })
  }

  /* ---------- 3枚目: 経費書類（スタッフ領収書以外。要確認行含む） ---------- */
  const expenseRows = rows.filter((r) => r.type !== "スタッフ領収書")
  const sheet = workbook.addWorksheet("経費書類")
  const headers = [
    "No", "ファイル名", "種別", "取引先 / 振込元", "金額 / 振込金額",
    "発行日 / 振込日", "基準日（月割り判定）", "税区分", "勘定科目", "コピー先パス", "ステータス",
  ]
  addHeaderRow(sheet, headers)
  const PATH_COL = headers.indexOf("コピー先パス") + 1
  const AMOUNT_COL = headers.indexOf("金額 / 振込金額") + 1

  expenseRows.forEach((r, i) => {
    const added = sheet.addRow([
      String(i + 1),
      r.fileName,
      r.type,
      r.isSales && r.transferFrom ? r.transferFrom : r.vendor,
      r.isSales && r.transferTotal !== null
        ? formatAmount(r.transferTotal)
        : formatAmount(r.amount),
      r.isSales && r.transferDate ? r.transferDate : r.date,
      r.baseDate,
      r.taxCategory,
      r.accountTitle,
      r.path,
      r.needsReview ? "要確認：DB未登録" : "",
    ])
    linkifyPathCell(added, PATH_COL, r.path)
  })

  // 合計行（要確認行の金額は含めない）
  const countedExpense = expenseRows.filter((r) => !r.needsReview)
  const expenseTotal = countedExpense.reduce((s, r) => s + (r.amount ?? 0), 0)
  sheet.addRow([])
  const totalRow = sheet.addRow([])
  totalRow.getCell(1).value = "合計"
  totalRow.getCell(4).value = `${countedExpense.length}件（要確認除く）`
  totalRow.getCell(AMOUNT_COL).value = formatAmount(expenseTotal)
  totalRow.font = { bold: true }
  totalRow.eachCell((cell) => {
    cell.border = { top: { style: "thin" } }
  })

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}
