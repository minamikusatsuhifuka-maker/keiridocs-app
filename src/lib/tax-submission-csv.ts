// 税理士提出書類一覧CSVビルダー（強化版）
// 種別サマリー・合計行・売上振込情報を含む見やすいCSVを生成

import { listFilesRecursive } from "@/lib/dropbox"
import type { createClient } from "@/lib/supabase/server"

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

interface BuildOpts {
  supabase: SupabaseServerClient
  isAdmin: boolean
  userId: string
  year: number
  month: number
}

interface BuildResult {
  fileName: string
  csvWithBom: string
  csvBody: string
  folderPath: string
  rowCount: number
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
  const monthStr = String(month).padStart(2, "0")
  const folderPath = `/経理書類/税理士提出/${year}年${monthStr}月`

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

  // CSVファイル自身・月計表CSVは除外
  filesInTaxFolder = filesInTaxFolder.filter((f) =>
    !/^提出書類一覧_.*\.csv$/.test(f.name) &&
    !/^月計表_.*\.csv$/.test(f.name)
  )

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

  // 書類データを組み立て
  const allRows = filesInTaxFolder.map((file, idx) => {
    const meta = fileNameMap.get(file.name)
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
      isSales: meta?.type === "売上記録",
    }
  })

  // ====== サマリーセクション ======
  const typeMap = new Map<string, { count: number; total: number }>()
  for (const row of allRows) {
    const existing = typeMap.get(row.type) ?? { count: 0, total: 0 }
    typeMap.set(row.type, {
      count: existing.count + 1,
      total: existing.total + (row.amount ?? 0),
    })
  }

  const grandTotal = allRows.reduce((sum, r) => sum + (r.amount ?? 0), 0)
  const grandCount = allRows.length

  const summaryLines: string[][] = [
    [`【${year}年${monthStr}月 税理士提出書類 サマリー】`, "", "", ""],
    ["種別", "件数", "合計金額", ""],
    ...Array.from(typeMap.entries()).map(([type, { count, total }]) => [
      type,
      `${count}件`,
      formatAmount(total),
      "",
    ]),
    ["", "", "", ""],
    ["合計", `${grandCount}件`, formatAmount(grandTotal), ""],
  ]

  // ====== 詳細セクション ======
  const detailHeaders = [
    "No", "ファイル名", "種別", "取引先 / 振込元", "金額 / 振込金額",
    "発行日 / 振込日", "税区分", "勘定科目", "コピー先パス",
  ]

  const detailRows = allRows.map((r) => [
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
  ])

  // 合計行
  const totalRow = [
    "合計", "", "", "",
    formatAmount(grandTotal),
    "", "", "", `${grandCount}件`,
  ]

  // CSV組み立て
  const allLines: string[][] = [
    ...summaryLines,
    [""],
    [`【書類詳細一覧】`],
    detailHeaders,
    ...detailRows,
    [""],
    totalRow,
  ]

  const csvBody = allLines
    .map((row) => row.map(escapeCsv).join(","))
    .join("\r\n")

  const bom = "﻿"
  const fileName = `提出書類一覧_${year}年${monthStr}月.csv`

  return {
    fileName,
    csvWithBom: bom + csvBody,
    csvBody,
    folderPath,
    rowCount: allRows.length,
  }
}
