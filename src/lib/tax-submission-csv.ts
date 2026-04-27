// 税理士提出書類一覧CSVビルダー
// /経理書類/税理士提出/{YYYY年MM月}/ 内のファイルをDBメタデータと突合してCSV化する

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

/**
 * 税理士提出書類一覧CSVを生成する
 *  列: No, ファイル名, 種別, 取引先, 金額, 発行日, 税区分, 勘定科目, コピー先パス
 *  - UTF-8 BOM付きの csvWithBom と、BOM無しの csvBody を返す
 *  - フォルダが存在しない場合は0件のCSV（ヘッダーのみ）を返す
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

  // CSV内に「提出書類一覧_xxx.csv」自身を含めない
  filesInTaxFolder = filesInTaxFolder.filter((f) => !/^提出書類一覧_.*\.csv$/.test(f.name))

  // DB検索: 全documentsのメタデータ（ファイル名インデックス）
  let dbQuery = supabase
    .from("documents")
    .select("dropbox_path, vendor_name, amount, type, issue_date, tax_category, account_title")
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
  }
  const fileNameMap = new Map<string, DocMeta>()
  for (const d of dbDocs ?? []) {
    if (typeof d.dropbox_path !== "string") continue
    const fn = d.dropbox_path.split("/").pop() ?? ""
    if (!fn) continue
    if (!fileNameMap.has(fn)) {
      fileNameMap.set(fn, {
        vendor_name: d.vendor_name ?? null,
        amount: typeof d.amount === "number" ? d.amount : null,
        type: typeof d.type === "string" ? d.type : "",
        issue_date: d.issue_date ?? null,
        tax_category: d.tax_category ?? null,
        account_title: d.account_title ?? null,
      })
    }
  }

  const headers = [
    "No",
    "ファイル名",
    "種別",
    "取引先",
    "金額",
    "発行日",
    "税区分",
    "勘定科目",
    "コピー先パス",
  ]

  const rows: string[][] = filesInTaxFolder.map((file, idx) => {
    const meta = fileNameMap.get(file.name)
    return [
      String(idx + 1),
      file.name,
      meta?.type ?? "",
      meta?.vendor_name ?? "",
      meta?.amount != null ? String(meta.amount) : "",
      meta?.issue_date ?? "",
      meta?.tax_category ?? "",
      meta?.account_title ?? "",
      file.path_display,
    ]
  })

  const csvBody = [headers, ...rows]
    .map((row) => row.map(escapeCsv).join(","))
    .join("\r\n")

  const bom = "﻿"
  const fileName = `提出書類一覧_${year}年${monthStr}月.csv`

  return {
    fileName,
    csvWithBom: bom + csvBody,
    csvBody,
    folderPath,
    rowCount: rows.length,
  }
}

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}
