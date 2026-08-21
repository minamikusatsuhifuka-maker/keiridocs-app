import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import ExcelJS from "exceljs"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import {
  buildStaffReimburseList,
  buildStaffReimburseListCsv,
  LIST_HEADERS,
  rowToCells,
  type DateBasis,
} from "@/lib/staff-reimburse-list"
import { fetchAllRows } from "@/lib/supabase/fetch-all"
import { STAFF_EXPENSE_DETAILS } from "@/lib/subsidy"
import type { Database } from "@/types/database"

/**
 * GET /api/staff-reimburse
 *
 * スタッフ立替専用メニューの一覧データ。
 *   ?basis=submit|application|payment  … 期間の基準日（既定: submit＝提出日）
 *   ?start=YYYY-MM-DD&end=YYYY-MM-DD   … 期間（両端含む。省略可）
 *   ?staffMemberId=<uuid>              … スタッフ絞り込み
 *   ?expenseDetail=<フル名称>           … 費用区分絞り込み
 *   ?format=csv | xlsx                 … エクスポート（省略時はJSON）
 *
 * 立替額・支給額は会計士向け立替明細CSVと同一の計算（calcSubsidy）。
 */

/** サービスロールキー（全スタッフ分を扱うため） */
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createClient<Database>(url, serviceKey)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseBasis(value: string | null): DateBasis {
  if (value === "application" || value === "payment" || value === "submit") return value
  return "submit"
}

export async function GET(req: NextRequest) {
  const authSupabase = await createAuthClient()
  const {
    data: { user },
    error: authError,
  } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(req.url)
    const format = searchParams.get("format")
    const start = searchParams.get("start") ?? undefined
    const end = searchParams.get("end") ?? undefined
    const basis = parseBasis(searchParams.get("basis"))
    const staffMemberId = searchParams.get("staffMemberId") ?? undefined
    const expenseDetail = searchParams.get("expenseDetail") ?? undefined
    // 提出月（"YYYY-MM"）＝税理士提出フォルダの振り分け先での絞り込み
    const submissionMonth = searchParams.get("submissionMonth") ?? undefined

    if (start && !DATE_RE.test(start)) {
      return NextResponse.json({ error: "開始日は YYYY-MM-DD 形式で指定してください" }, { status: 400 })
    }
    if (end && !DATE_RE.test(end)) {
      return NextResponse.json({ error: "終了日は YYYY-MM-DD 形式で指定してください" }, { status: 400 })
    }
    if (start && end && end < start) {
      return NextResponse.json({ error: "終了日は開始日以降にしてください" }, { status: 400 })
    }

    const service = createServiceClient()
    const result = await buildStaffReimburseList({
      supabase: service,
      filter: { basis, start, end, staffMemberId, expenseDetail, submissionMonth },
    })

    const periodLabel =
      start || end ? `${start || "指定なし"}〜${end || "指定なし"}` : "全期間"

    if (format === "csv") {
      const csv = buildStaffReimburseListCsv(result, periodLabel)
      const fileName = `スタッフ立替一覧_${periodLabel}.csv`
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="staff_reimburse_list.csv"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        },
      })
    }

    if (format === "xlsx") {
      const buffer = await buildListXlsx(result.rows, result.subtotals, result.totals, periodLabel)
      const fileName = `スタッフ立替一覧_${periodLabel}.xlsx`
      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="staff_reimburse_list.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        },
      })
    }

    // 絞り込みUI用の選択肢（テストスタッフは除外して一覧と揃える）
    const staffMembers = await fetchAllRows<{ id: string; name: string; is_test: boolean | null }>(
      (from, to) =>
        service
          .from("staff_members")
          .select("id, name, is_test")
          .order("name", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
          data: { id: string; name: string; is_test: boolean | null }[] | null
          error: { message: string } | null
        }>
    )

    return NextResponse.json({
      ...result,
      periodLabel,
      staffOptions: staffMembers
        .filter((s) => !s.is_test)
        .map((s) => ({ id: s.id, name: s.name })),
      detailOptions: STAFF_EXPENSE_DETAILS.map((d) => d.fullLabel),
    })
  } catch (e: unknown) {
    console.error("[staff-reimburse]", e)
    const msg = e instanceof Error ? e.message : "unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/** 一覧のExcel（明細＋スタッフ別小計＋合計）。金額はCSVと同一。 */
async function buildListXlsx(
  rows: Awaited<ReturnType<typeof buildStaffReimburseList>>["rows"],
  subtotals: Awaited<ReturnType<typeof buildStaffReimburseList>>["subtotals"],
  totals: { count: number; totalAmount: number; totalSubsidy: number },
  periodLabel: string
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet("スタッフ立替")

  sheet.addRow([`スタッフ立替一覧（${periodLabel}・1件1行）`]).font = { bold: true }
  sheet.addRow([])

  const header = sheet.addRow([...LIST_HEADERS])
  header.font = { bold: true }
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } }
    cell.border = { bottom: { style: "thin" } }
  })
  const widths = [12, 12, 12, 14, 24, 28, 12, 10, 12, 16, 10, 28]
  widths.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w
  })

  for (const r of rows) {
    const cells = rowToCells(r)
    const added = sheet.addRow(cells)
    // 金額列は数値として入れる（Excelで集計できるように）
    added.getCell(7).value = r.amount
    added.getCell(9).value = r.subsidy
  }

  sheet.addRow([])
  for (const s of subtotals) {
    const row = sheet.addRow([])
    row.getCell(1).value = "小計"
    row.getCell(4).value = s.staffName
    row.getCell(6).value = `${s.count}件`
    row.getCell(7).value = s.totalAmount
    row.getCell(9).value = s.totalSubsidy
    row.font = { bold: true }
  }
  const totalRow = sheet.addRow([])
  totalRow.getCell(1).value = "合計"
  totalRow.getCell(6).value = `${totals.count}件`
  totalRow.getCell(7).value = totals.totalAmount
  totalRow.getCell(9).value = totals.totalSubsidy
  totalRow.font = { bold: true }
  totalRow.eachCell((cell) => {
    cell.border = { top: { style: "thin" } }
  })

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}
