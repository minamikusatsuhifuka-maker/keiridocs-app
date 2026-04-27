import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { listFilesRecursive } from "@/lib/dropbox"
import { getCurrentUserRole } from "@/lib/auth"

/**
 * 指定年月の税理士提出書類一覧をCSVで出力する
 *
 * 仕様:
 *  - GET /api/documents/export-tax-csv?year=2026&month=04
 *  - /経理書類/税理士提出/{YYYY年MM月}/ 内のファイルを一覧化
 *  - 各ファイルをDB（documentsテーブル）でファイル名 or dropbox_pathから検索しメタデータを補完
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

  const monthStr = String(monthNum).padStart(2, "0")
  const taxFolderBase = `/経理書類/税理士提出/${yearNum}年${monthStr}月`

  // 税理士提出フォルダ内のファイル一覧
  let filesInTaxFolder: Array<{
    name: string
    path_display: string
    size: number
    client_modified: string
  }> = []
  try {
    filesInTaxFolder = await listFilesRecursive(taxFolderBase)
  } catch (err) {
    console.error("税理士フォルダ取得エラー:", err)
  }

  // DB検索用: 全documentsのメタデータ（ファイル名インデックス）
  let dbQuery = supabase
    .from("documents")
    .select("dropbox_path, vendor_name, amount, type, issue_date, tax_category, account_title")
    .not("dropbox_path", "is", null)

  if (auth.role !== "admin") {
    dbQuery = dbQuery.eq("user_id", user.id)
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
    const fileName = d.dropbox_path.split("/").pop() ?? ""
    if (!fileName) continue
    if (!fileNameMap.has(fileName)) {
      fileNameMap.set(fileName, {
        vendor_name: d.vendor_name ?? null,
        amount: typeof d.amount === "number" ? d.amount : null,
        type: typeof d.type === "string" ? d.type : "",
        issue_date: d.issue_date ?? null,
        tax_category: d.tax_category ?? null,
        account_title: d.account_title ?? null,
      })
    }
  }

  // CSV行を構築
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

  // UTF-8 BOM 付き
  const bom = "﻿"
  const fileName = `提出書類一覧_${yearNum}年${monthStr}月.csv`
  const encodedFileName = encodeURIComponent(fileName)

  return new NextResponse(bom + csvBody, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodedFileName}`,
      "Cache-Control": "no-store",
    },
  })
}

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}
