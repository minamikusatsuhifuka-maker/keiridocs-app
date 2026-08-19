// 税理士提出書類一覧のExcel（.xlsx）生成（共通ロジック）。
// ダウンロードAPI（export-tax-xlsx）と一括コピー時のDropbox自動保存の両方から使う。
//
// シート構成:
//   1. サマリー     … 種別別 件数・合計金額・支給額合計・要確認件数・総合計＋【今回の変更】
//   2. スタッフ立替 … スタッフ領収書の明細＋スタッフ別小計＋合計（該当行が無い場合は省略）
//   3. 経費書類     … スタッフ領収書以外の明細（要確認行含む。ステータス列で判別）
//   4. 変更履歴     … その月に発生した変更の時系列一覧（変更が1件も無い月は省略）
// 「コピー先パス」列は全シートでDropboxウェブを開くハイパーリンク。
//
// 前回提出との差分は行の背景色で示す（各明細シートの先頭に凡例を置く）:
//   新規=緑 / 修正=黄 / 削除=グレー＋取消線 / 変更なし=従来どおり

import ExcelJS from "exceljs"
import { dropboxFileUrl } from "@/lib/dropbox-web-link"
import type { TaxListRow } from "@/lib/tax-submission-csv"
import { STATUS_LABELS, type ChangeEntry, type RowStatus } from "@/lib/tax-submission-snapshot"

/** buildTaxSubmissionCsv の table フィールドと同じ構造 */
export interface TaxSubmissionTable {
  summaryLines: string[][]
  detailTitle: string
  detailHeaders: string[]
  detailRows: Array<{ cells: string[]; path: string }>
  totalRow: string[]
  rows: TaxListRow[]
  /** その月に発生した変更の時系列一覧（省略時は変更履歴シートを作らない） */
  changeHistory?: ChangeEntry[]
}

/** 列幅（ヘッダーラベル → 幅）。未定義のラベルは既定幅 */
const COLUMN_WIDTHS: Record<string, number> = {
  "No": 6,
  "状態": 10,
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
  "更新日": 12,
  "変更内容": 52,
  "基準日（月割り判定）": 22,
  "税区分": 12,
  "勘定科目": 14,
  "コピー先パス": 60,
  "ステータス": 18,
  "変更日時": 18,
  "変更項目": 16,
  "変更前": 22,
  "変更後": 22,
  "変更者": 18,
  "取引先": 20,
}

/** 状態ごとの行背景色（ARGB）。変更なしは着色しない */
const STATUS_FILL: Record<RowStatus, string | null> = {
  new: "FFDFF5DF", // 緑系
  modified: "FFFFF2CC", // 黄／オレンジ系
  removed: "FFE8E8E8", // グレー
  unchanged: null,
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

/**
 * 色の意味を説明する凡例を明細シートの先頭に置く。
 * 税理士が説明なしで読めるように、色そのものをセルに塗って並べる。
 */
function addLegend(sheet: ExcelJS.Worksheet, columnCount: number): void {
  const title = sheet.addRow(["凡例（前回の提出内容との比較）"])
  title.font = { bold: true }

  const legendRow = sheet.addRow([
    "新規（前回になく今回追加）",
    "修正（内容が変わった）",
    "削除（前回はあったが今回なし・集計対象外）",
    "変更なし",
  ])
  legendRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: STATUS_FILL.new! } }
  legendRow.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: STATUS_FILL.modified! } }
  legendRow.getCell(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: STATUS_FILL.removed! } }
  legendRow.getCell(3).font = { strike: true }
  for (let i = 1; i <= Math.min(4, columnCount); i++) {
    legendRow.getCell(i).border = { bottom: { style: "hair" } }
  }
  sheet.addRow([])
}

/** 行に状態の色分けを適用する */
function applyStatusStyle(row: ExcelJS.Row, status: RowStatus, columnCount: number): void {
  const fill = STATUS_FILL[status]
  if (!fill && status !== "removed") return
  for (let i = 1; i <= columnCount; i++) {
    const cell = row.getCell(i)
    if (fill) {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } }
    }
    if (status === "removed") {
      cell.font = { strike: true, color: { argb: "FF808080" } }
    }
  }
}

/** 変更されたセル自体を強調する（修正行のみ）。変更内容の項目名から対象列を引く */
function highlightChangedCells(
  row: ExcelJS.Row,
  changeSummary: string,
  headers: string[],
  labelToHeader: Record<string, string>
): void {
  if (!changeSummary) return
  // 「項目：変更前 → 変更後」を " / " で連結した形なので、項目名だけを取り出す
  const labels = changeSummary
    .split(" / ")
    .map((part) => part.split("：")[0]?.trim())
    .filter((v): v is string => !!v)
  for (const label of labels) {
    const header = labelToHeader[label]
    if (!header) continue
    const idx = headers.indexOf(header)
    if (idx < 0) continue
    const cell = row.getCell(idx + 1)
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFD966" } }
    cell.font = { bold: true }
  }
}

/** コピー先パスのセルをDropboxウェブへのハイパーリンクにする */
function linkifyPathCell(row: ExcelJS.Row, pathCol: number, path: string, status: RowStatus): void {
  if (pathCol <= 0 || !path) return
  const cell = row.getCell(pathCol)
  cell.value = { text: path, hyperlink: dropboxFileUrl(path) }
  cell.font =
    status === "removed"
      ? { color: { argb: "FF808080" }, underline: true, strike: true }
      : { color: { argb: "FF0563C1" }, underline: true }
}

/** 提出書類一覧の xlsx バッファを生成する（サマリー／スタッフ立替／経費書類／変更履歴） */
export async function buildTaxSubmissionXlsxBuffer(table: TaxSubmissionTable): Promise<Buffer> {
  const { summaryLines, rows } = table

  const workbook = new ExcelJS.Workbook()

  /* ---------- 1枚目: サマリー ---------- */
  const summarySheet = workbook.addWorksheet("サマリー")
  for (const line of summaryLines) {
    const added = summarySheet.addRow(line)
    // セクション見出し（【…】）は太字にして読みやすくする
    if (typeof line[0] === "string" && /^【.*】$/.test(line[0])) {
      added.font = { bold: true }
    }
  }
  summarySheet.getRow(1).font = { bold: true }
  ;[34, 16, 16, 28].forEach((w, i) => {
    summarySheet.getColumn(i + 1).width = w
  })

  /* ---------- 2枚目: スタッフ立替（該当行がある場合のみ） ---------- */
  const staffRows = rows.filter((r) => r.type === "スタッフ領収書")
  if (staffRows.length > 0) {
    const sheet = workbook.addWorksheet("スタッフ立替")
    const headers = [
      "No", "状態", "ファイル名", "対象スタッフ", "支払先（店名）", "目的・用途",
      "金額（立替額）", "支給割合", "支給額",
      "発行日（支払日）", "取り込み日", "更新日", "変更内容",
      "基準日（月割り判定）", "税区分", "勘定科目", "コピー先パス",
    ]
    addLegend(sheet, headers.length)
    addHeaderRow(sheet, headers)
    const PATH_COL = headers.indexOf("コピー先パス") + 1
    const AMOUNT_COL = headers.indexOf("金額（立替額）") + 1
    const SUBSIDY_COL = headers.indexOf("支給額") + 1
    // 変更項目名 → この表の列見出し（変更されたセルを強調するため）
    const labelToHeader: Record<string, string> = {
      取引先: "対象スタッフ",
      支払先: "支払先（店名）",
      "目的・用途": "目的・用途",
      金額: "金額（立替額）",
      支給割合: "支給割合",
      支給額: "支給額",
      発行日: "発行日（支払日）",
      基準日: "基準日（月割り判定）",
      税区分: "税区分",
      勘定科目: "勘定科目",
      取り込み日: "取り込み日",
    }

    staffRows.forEach((r, i) => {
      const added = sheet.addRow([
        String(i + 1),
        STATUS_LABELS[r.status],
        r.fileName,
        r.vendor,
        r.storeName,
        r.expenseDetail,
        formatAmount(r.amount),
        r.subsidyLabel,
        formatAmount(r.subsidyAmount),
        r.date,
        r.createdDate,
        r.updatedDate,
        r.changeSummary,
        r.baseDate,
        r.taxCategory,
        r.accountTitle,
        r.path,
      ])
      applyStatusStyle(added, r.status, headers.length)
      if (r.status === "modified") {
        highlightChangedCells(added, r.changeSummary, headers, labelToHeader)
      }
      linkifyPathCell(added, PATH_COL, r.path, r.status)
    })

    // 末尾: スタッフごとの小計（立替額・支給額）＋合計行。削除行は集計に含めない
    sheet.addRow([])
    const countedStaffRows = staffRows.filter((r) => r.status !== "removed")
    const byStaff = new Map<string, { amount: number; subsidy: number; count: number }>()
    for (const r of countedStaffRows) {
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
      subtotal.getCell(4).value = staff
      subtotal.getCell(6).value = `${sums.count}件`
      subtotal.getCell(AMOUNT_COL).value = formatAmount(sums.amount)
      subtotal.getCell(SUBSIDY_COL).value = formatAmount(sums.subsidy)
      subtotal.font = { bold: true }
    }
    const totalAmount = countedStaffRows.reduce((s, r) => s + (r.amount ?? 0), 0)
    const totalSubsidy = countedStaffRows.reduce((s, r) => s + (r.subsidyAmount ?? 0), 0)
    const totalRow = sheet.addRow([])
    totalRow.getCell(1).value = "合計"
    totalRow.getCell(6).value = `${countedStaffRows.length}件`
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
    "No", "状態", "ファイル名", "種別", "取引先 / 振込元", "金額 / 振込金額",
    "発行日 / 振込日", "取り込み日", "更新日", "変更内容",
    "基準日（月割り判定）", "税区分", "勘定科目", "コピー先パス", "ステータス",
  ]
  addLegend(sheet, headers.length)
  addHeaderRow(sheet, headers)
  const PATH_COL = headers.indexOf("コピー先パス") + 1
  const AMOUNT_COL = headers.indexOf("金額 / 振込金額") + 1
  const labelToHeader: Record<string, string> = {
    種別: "種別",
    取引先: "取引先 / 振込元",
    金額: "金額 / 振込金額",
    発行日: "発行日 / 振込日",
    基準日: "基準日（月割り判定）",
    税区分: "税区分",
    勘定科目: "勘定科目",
    取り込み日: "取り込み日",
    要確認: "ステータス",
  }

  expenseRows.forEach((r, i) => {
    const added = sheet.addRow([
      String(i + 1),
      STATUS_LABELS[r.status],
      r.fileName,
      r.type,
      r.isSales && r.transferFrom ? r.transferFrom : r.vendor,
      r.isSales && r.transferTotal !== null
        ? formatAmount(r.transferTotal)
        : formatAmount(r.amount),
      r.isSales && r.transferDate ? r.transferDate : r.date,
      r.createdDate,
      r.updatedDate,
      r.changeSummary,
      r.baseDate,
      r.taxCategory,
      r.accountTitle,
      r.path,
      r.needsReview ? "要確認：DB未登録" : r.status === "removed" ? "削除（集計対象外）" : "",
    ])
    applyStatusStyle(added, r.status, headers.length)
    if (r.status === "modified") {
      highlightChangedCells(added, r.changeSummary, headers, labelToHeader)
    }
    linkifyPathCell(added, PATH_COL, r.path, r.status)
  })

  // 合計行（要確認行・削除行の金額は含めない）
  const countedExpense = expenseRows.filter((r) => !r.needsReview && r.status !== "removed")
  const expenseTotal = countedExpense.reduce((s, r) => s + (r.amount ?? 0), 0)
  sheet.addRow([])
  const totalRow = sheet.addRow([])
  totalRow.getCell(1).value = "合計"
  totalRow.getCell(5).value = `${countedExpense.length}件（要確認・削除除く）`
  totalRow.getCell(AMOUNT_COL).value = formatAmount(expenseTotal)
  totalRow.font = { bold: true }
  totalRow.eachCell((cell) => {
    cell.border = { top: { style: "thin" } }
  })

  /* ---------- 4枚目: 変更履歴（その月に発生した変更を時系列で） ---------- */
  const history = table.changeHistory ?? []
  if (history.length > 0) {
    const hSheet = workbook.addWorksheet("変更履歴")
    const hHeaders = ["変更日時", "状態", "ファイル名", "取引先", "変更項目", "変更前", "変更後", "変更者"]
    addHeaderRow(hSheet, hHeaders)
    for (const entry of history) {
      const when = formatJstDateTime(entry.changedAt)
      if (entry.fields.length === 0) {
        // 新規・削除は項目別の差分を持たないため1行で表す
        const row = hSheet.addRow([
          when,
          STATUS_LABELS[entry.status],
          entry.fileName,
          entry.vendor,
          "",
          "",
          "",
          entry.changedBy,
        ])
        applyStatusStyle(row, entry.status, hHeaders.length)
        continue
      }
      for (const f of entry.fields) {
        const row = hSheet.addRow([
          when,
          STATUS_LABELS[entry.status],
          entry.fileName,
          entry.vendor,
          f.label,
          f.before,
          f.after,
          entry.changedBy,
        ])
        applyStatusStyle(row, entry.status, hHeaders.length)
      }
    }
  }

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}

/** ISO日時を「YYYY-MM-DD HH:mm」（JST）に整形する */
function formatJstDateTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`
}
