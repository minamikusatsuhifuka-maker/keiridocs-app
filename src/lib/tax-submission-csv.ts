// 税理士提出書類一覧CSVビルダー（強化版）
// 種別サマリー・合計行・売上振込情報を含む見やすいCSVを生成

import { listFilesRecursive } from "@/lib/dropbox"
import type { createClient } from "@/lib/supabase/server"
import { SALES_SUBFOLDER, LEGACY_SALES_SUBFOLDER } from "@/lib/tax-folder-structure"

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

interface BuildOpts {
  supabase: SupabaseServerClient
  isAdmin: boolean
  userId: string
  year: number
  month: number
  // 集計対象の範囲:
  //   all     … 全書類（従来動作・後方互換）
  //   expense … 経費書類のみ（売上サブフォルダ配下を除外）
  //   sales   … 売上書類のみ（売上サブフォルダ配下のみ）
  scope?: "all" | "expense" | "sales"
}

interface BuildResult {
  fileName: string
  csvWithBom: string
  csvBody: string
  folderPath: string
  // CSVの実際の保存先フォルダ（売上CSVは売上サブフォルダ）
  saveFolderPath: string
  rowCount: number
  // DBに一致する書類が無く「要確認」として集計対象外にしたファイル
  needsReviewFiles: Array<{ fileName: string; path: string }>
  // 新旧フォルダ構造の重複として除外した件数
  duplicatesRemoved: number
  // xlsx生成用の構造化データ（CSVと同一の行構成。detailRows.path はハイパーリンク化に使う）
  table: {
    summaryLines: string[][]
    detailTitle: string
    detailHeaders: string[]
    detailRows: Array<{ cells: string[]; path: string }>
    totalRow: string[]
  }
}

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function formatAmount(amount: number | null): string {
  if (amount === null || amount === undefined) return ""
  return `¥${amount.toLocaleString()}`
}

type TaxFolderFile = { name: string; path_display: string; size: number; client_modified: string }

/** 月フォルダ直下（サブフォルダ無し）に置かれているか＝旧・平坦構造 */
function isLegacyFlatPath(pathDisplay: string, folderPath: string): boolean {
  const rest = pathDisplay.slice(folderPath.length + 1)
  return !rest.includes("/")
}

/**
 * 同一ファイル名の重複を除去する。
 * 新旧フォルダ構造の移行時、平坦構造（月フォルダ直下）と現行のサブフォルダ構造の
 * 両方に同じファイルが残っているケースがあるため、現行構造（サブフォルダ配下）を
 * 正としてカウントし、平坦構造側は集計対象から除外する（削除はしない）。
 */
function dedupTaxFolderFiles(
  files: TaxFolderFile[],
  folderPath: string
): { deduped: TaxFolderFile[]; duplicatesRemoved: number } {
  const byName = new Map<string, TaxFolderFile[]>()
  for (const f of files) {
    const group = byName.get(f.name)
    if (group) group.push(f)
    else byName.set(f.name, [f])
  }

  const deduped: TaxFolderFile[] = []
  let duplicatesRemoved = 0
  for (const group of byName.values()) {
    if (group.length === 1) {
      deduped.push(group[0])
      continue
    }
    const nested = group.filter((f) => !isLegacyFlatPath(f.path_display, folderPath))
    if (nested.length > 0) {
      deduped.push(nested[0])
      duplicatesRemoved += group.length - 1
    } else {
      // 現行構造側が無い（想定外）場合は平坦構造から1件だけ残す
      deduped.push(group[0])
      duplicatesRemoved += group.length - 1
    }
  }
  return { deduped, duplicatesRemoved }
}

/**
 * 税理士提出書類一覧CSVを生成する（強化版）
 *
 * 構成:
 *   [1] サマリーセクション（種別ごとの件数・合計金額）
 *   [2] 空行
 *   [3] 書類詳細一覧（全書類）
 *       列: No / ファイル名 / 種別 / 取引先（振込元） / 金額 / 発行日（振込日）/ 税区分 / 勘定科目 / コピー先パス
 *   [4] 空行
 *   [5] 合計行
 */
export async function buildTaxSubmissionCsv(opts: BuildOpts): Promise<BuildResult> {
  const { supabase, isAdmin, userId, year, month } = opts
  const scope = opts.scope ?? "all"
  const monthStr = String(month).padStart(2, "0")
  const folderPath = `/経理書類/税理士提出/${year}年${monthStr}月`
  // 売上書類は税理士提出/{月}/売上記録データ/ サブフォルダに配置される（旧: 売上/ も後方互換で判定）。
  // DBに無いファイルでも確実に経費/売上を分離できるよう、パスで判定する。
  const salesPrefixes = [
    `${folderPath}/${SALES_SUBFOLDER}/`,
    `${folderPath}/${LEGACY_SALES_SUBFOLDER}/`,
  ]

  // 税理士提出フォルダ内のファイル一覧
  let filesInTaxFolder: Array<{
    name: string
    path_display: string
    size: number
    client_modified: string
  }> = []
  try {
    filesInTaxFolder = await listFilesRecursive(folderPath)
  } catch (err) {
    console.error("税理士フォルダ取得エラー:", err)
  }

  // CSVファイル自身（提出書類一覧・売上提出一覧・スタッフ立替明細）・月計表CSVは除外
  filesInTaxFolder = filesInTaxFolder.filter((f) =>
    !/^提出書類一覧_.*\.csv$/.test(f.name) &&
    !/^売上提出一覧_.*\.csv$/.test(f.name) &&
    !/^月計表_.*\.csv$/.test(f.name) &&
    !/^スタッフ立替明細_.*\.csv$/.test(f.name)
  )

  // 新旧フォルダ構造の重複除去（現行のサブフォルダ構造を正としてカウント）
  const { deduped, duplicatesRemoved } = dedupTaxFolderFiles(filesInTaxFolder, folderPath)
  filesInTaxFolder = deduped

  // scope による絞り込み（売上サブフォルダ配下かどうかをパスで判定）
  if (scope !== "all") {
    filesInTaxFolder = filesInTaxFolder.filter((f) => {
      const isSalesFile = salesPrefixes.some((p) => f.path_display.startsWith(p))
      return scope === "sales" ? isSalesFile : !isSalesFile
    })
  }

  // DBからメタデータ取得
  let dbQuery = supabase
    .from("documents")
    .select("dropbox_path, vendor_name, amount, type, issue_date, tax_category, account_title, ocr_raw")
    .not("dropbox_path", "is", null)

  if (!isAdmin) {
    dbQuery = dbQuery.eq("user_id", userId)
  }

  const { data: dbDocs } = await dbQuery

  type DocMeta = {
    vendor_name: string | null
    amount: number | null
    type: string
    issue_date: string | null
    tax_category: string | null
    account_title: string | null
    // 売上記録専用: 振込元・振込日・振込金額
    transfer_from: string | null
    transfer_date: string | null
    transfer_total: number | null
  }

  const fileNameMap = new Map<string, DocMeta>()
  for (const d of dbDocs ?? []) {
    if (typeof d.dropbox_path !== "string") continue
    const fn = d.dropbox_path.split("/").pop() ?? ""
    if (!fn || fileNameMap.has(fn)) continue

    // ocr_rawから振込情報を追加抽出（売上記録の場合）
    let transferFrom: string | null = null
    let transferDate: string | null = null
    let transferTotal: number | null = null

    if (d.type === "売上記録" && d.ocr_raw && typeof d.ocr_raw === "object") {
      const ocr = d.ocr_raw as Record<string, unknown>
      transferFrom = typeof ocr.transfer_from === "string" ? ocr.transfer_from
        : typeof ocr.vendor_name === "string" ? ocr.vendor_name : null
      transferDate = typeof ocr.transfer_date === "string" ? ocr.transfer_date
        : typeof ocr.issue_date === "string" ? ocr.issue_date : null
      transferTotal = typeof ocr.transfer_total === "number" ? ocr.transfer_total
        : typeof ocr.amount === "number" ? ocr.amount : null
    }

    fileNameMap.set(fn, {
      vendor_name: d.vendor_name ?? null,
      amount: typeof d.amount === "number" ? d.amount : null,
      type: typeof d.type === "string" ? d.type : "",
      issue_date: d.issue_date ?? null,
      tax_category: d.tax_category ?? null,
      account_title: d.account_title ?? null,
      transfer_from: transferFrom,
      transfer_date: transferDate,
      transfer_total: transferTotal,
    })
  }

  // スタッフ立替領収書（LINE申請等）は documents ではなく staff_receipts に登録されるため、
  // documents で一致しないファイルは staff_receipts のファイル名でも照合する。
  // 表示は 種別「スタッフ領収書」・取引先=スタッフ名・発行日=支払年月日・金額=立替額。
  const staffReceiptMap = new Map<string, DocMeta>()
  try {
    const [{ data: staffReceipts }, { data: staffMembers }] = await Promise.all([
      supabase
        .from("staff_receipts")
        .select("file_name, date, amount, tax_category, account_title, staff_member_id"),
      supabase.from("staff_members").select("id, name"),
    ])
    const staffNameMap = new Map<string, string>()
    for (const s of staffMembers ?? []) {
      if (typeof s.id === "string" && typeof s.name === "string") staffNameMap.set(s.id, s.name)
    }
    for (const r of staffReceipts ?? []) {
      if (typeof r.file_name !== "string" || !r.file_name || staffReceiptMap.has(r.file_name)) continue
      staffReceiptMap.set(r.file_name, {
        vendor_name: staffNameMap.get(r.staff_member_id ?? "") ?? null,
        amount: typeof r.amount === "number" ? r.amount : null,
        type: "スタッフ領収書",
        issue_date: r.date ?? null,
        tax_category: r.tax_category ?? null,
        account_title: r.account_title ?? null,
        transfer_from: null,
        transfer_date: null,
        transfer_total: null,
      })
    }
  } catch (err) {
    // staff_receipts が読めない場合も CSV 生成自体は継続する（従来どおり要確認扱いになる）
    console.error("staff_receipts照合エラー:", err)
  }

  // 書類データを組み立て（documents優先 → staff_receiptsフォールバック）
  const allRows = filesInTaxFolder.map((file, idx) => {
    const meta = fileNameMap.get(file.name) ?? staffReceiptMap.get(file.name)
    return {
      no: idx + 1,
      fileName: file.name,
      type: meta?.type ?? "",
      vendor: meta?.vendor_name ?? "",
      amount: meta?.amount ?? null,
      date: meta?.issue_date ?? "",
      taxCategory: meta?.tax_category ?? "",
      accountTitle: meta?.account_title ?? "",
      path: file.path_display,
      transferFrom: meta?.transfer_from ?? "",
      transferDate: meta?.transfer_date ?? "",
      transferTotal: meta?.transfer_total ?? null,
      // DBに無いファイルでも売上判定できるよう、サブフォルダのパスも見る
      isSales: salesPrefixes.some((p) => file.path_display.startsWith(p)) || meta?.type === "売上記録",
      // DBに一致する書類が無い＝内容不明（未登録・手動配置等）。集計対象外にする
      needsReview: !meta,
    }
  })

  const needsReviewRows = allRows.filter((r) => r.needsReview)
  const countedRows = allRows.filter((r) => !r.needsReview)

  // ====== サマリーセクション（要確認ファイルは集計に含めない） ======
  const typeMap = new Map<string, { count: number; total: number }>()
  for (const row of countedRows) {
    const existing = typeMap.get(row.type) ?? { count: 0, total: 0 }
    typeMap.set(row.type, {
      count: existing.count + 1,
      total: existing.total + (row.amount ?? 0),
    })
  }

  const grandTotal = countedRows.reduce((sum, r) => sum + (r.amount ?? 0), 0)
  const grandCount = countedRows.length

  const summaryTitle = scope === "sales"
    ? `【${year}年${monthStr}月 売上提出一覧 サマリー】`
    : `【${year}年${monthStr}月 税理士提出書類 サマリー】`

  const summaryLines: string[][] = [
    [summaryTitle, "", "", ""],
    ["種別", "件数", "合計金額", ""],
    ...Array.from(typeMap.entries()).map(([type, { count, total }]) => [
      type,
      `${count}件`,
      formatAmount(total),
      "",
    ]),
    ...(needsReviewRows.length > 0
      ? [["要確認（DB未登録・内容不明）", `${needsReviewRows.length}件`, "", "集計対象外"]]
      : []),
    ...(duplicatesRemoved > 0
      ? [["（新旧フォルダ構造の重複を除外）", `${duplicatesRemoved}件`, "", ""]]
      : []),
    ["", "", "", ""],
    ["合計", `${grandCount}件`, formatAmount(grandTotal), ""],
  ]

  // ====== 詳細セクション ======
  const detailHeaders = [
    "No", "ファイル名", "種別", "取引先 / 振込元", "金額 / 振込金額",
    "発行日 / 振込日", "税区分", "勘定科目", "コピー先パス", "ステータス",
  ]

  const detailRows = allRows.map((r) => ({
    path: r.path,
    cells: [
      String(r.no),
      r.fileName,
      r.type,
      r.isSales && r.transferFrom ? r.transferFrom : r.vendor,
      r.isSales && r.transferTotal !== null
        ? formatAmount(r.transferTotal)
        : r.amount !== null ? formatAmount(r.amount) : "",
      r.isSales && r.transferDate ? r.transferDate : r.date,
      r.taxCategory,
      r.accountTitle,
      r.path,
      r.needsReview ? "要確認：DB未登録" : "",
    ],
  }))

  // 合計行（要確認ファイルの金額は含まない）
  const totalRow = [
    "合計", "", "", "",
    formatAmount(grandTotal),
    "", "", "", `${grandCount}件`, "",
  ]

  // CSV組み立て
  const detailTitle = "【書類詳細一覧】"
  const allLines: string[][] = [
    ...summaryLines,
    [""],
    [detailTitle],
    detailHeaders,
    ...detailRows.map((r) => r.cells),
    [""],
    totalRow,
  ]

  const csvBody = allLines
    .map((row) => row.map(escapeCsv).join(","))
    .join("\r\n")

  const bom = "﻿"
  // 売上CSVは専用ファイル名＋売上サブフォルダに保存
  const fileName = scope === "sales"
    ? `売上提出一覧_${year}年${monthStr}月.csv`
    : `提出書類一覧_${year}年${monthStr}月.csv`
  const saveFolderPath = scope === "sales" ? `${folderPath}/${SALES_SUBFOLDER}` : folderPath

  return {
    fileName,
    csvWithBom: bom + csvBody,
    csvBody,
    folderPath,
    saveFolderPath,
    rowCount: allRows.length,
    needsReviewFiles: needsReviewRows.map((r) => ({ fileName: r.fileName, path: r.path })),
    duplicatesRemoved,
    table: {
      summaryLines,
      detailTitle,
      detailHeaders,
      detailRows,
      totalRow,
    },
  }
}
