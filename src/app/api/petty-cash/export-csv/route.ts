import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import type { Database } from "@/types/database"

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createClient<Database>(url, serviceKey)
}

interface CsvRow {
  id: string
  transaction_date: string | null
  created_at: string
  type: string
  amount: number
  balance_after: number | null
  category: string | null
  subcategory: string | null
  note: string | null
  description: string | null
  created_by: string | null
  registered_by: string | null
  receipt_urls: string[] | null
  staff_members: { name: string } | { name: string }[] | null
}

/**
 * GET /api/petty-cash/export-csv?year=2026&month=5
 * 月次の小口現金取引をCSVで出力
 *
 * 項目: 日付 / 種別 / サブ種別 / 内容 / 金額 / 残高 / 登録者 / スタッフ名 / Dropboxリンク
 */
export async function GET(req: NextRequest) {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(req.url)
    const year = Number(searchParams.get("year"))
    const month = Number(searchParams.get("month"))

    if (!year || !month) {
      return NextResponse.json({ error: "year/monthが必要です" }, { status: 400 })
    }

    const start = `${year}-${String(month).padStart(2, "0")}-01`
    const endMonth = month === 12 ? 1 : month + 1
    const endYear = month === 12 ? year + 1 : year
    const end = `${endYear}-${String(endMonth).padStart(2, "0")}-01`

    const serviceClient = createServiceClient()

    // transaction_date が NULL の旧データもあるので、両方の期間でフィルタする
    const { data, error } = await serviceClient
      .from("petty_cash_transactions")
      .select(
        `
        id, transaction_date, created_at, type, amount, balance_after,
        category, subcategory, note, description, created_by, registered_by, receipt_urls,
        staff_members ( name )
      `
      )
      .or(
        `and(transaction_date.gte.${start},transaction_date.lt.${end}),and(transaction_date.is.null,created_at.gte.${start}T00:00:00,created_at.lt.${end}T00:00:00)`
      )
      .order("transaction_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })

    if (error) throw error

    const rowsData = (data as unknown as CsvRow[]) ?? []

    const categoryLabel = (c: string | null, t: string | null) => {
      if (c === "patient_response") return "患者対応"
      if (c === "staff_refund") return "スタッフ返金"
      if (c === "cash_in") return "入金"
      if (c === "other") return "その他"
      // category が未設定の旧データは type で表示
      return t ?? ""
    }

    const subLabel = (s: string | null) =>
      s === "insurance_refund"
        ? "保険診療返金"
        : s === "self_pay_refund"
        ? "自費診療返金"
        : s === "other"
        ? "その他"
        : ""

    const escape = (v: unknown) => {
      if (v === null || v === undefined) return ""
      const s = String(v)
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return '"' + s.replace(/"/g, '""') + '"'
      }
      return s
    }

    const signedAmount = (r: CsvRow) => {
      // type='出金' は支出（マイナス表示）、それ以外（入金/返金）はプラス
      if (r.type === "出金") return -r.amount
      return r.amount
    }

    const header = [
      "日付",
      "種別",
      "サブ種別",
      "内容",
      "金額",
      "残高",
      "登録者",
      "スタッフ名",
      "Dropboxリンク",
    ]
    const rows = rowsData.map((r) => {
      const urls = Array.isArray(r.receipt_urls) ? r.receipt_urls.join(" | ") : ""
      const staff = Array.isArray(r.staff_members)
        ? r.staff_members[0]?.name
        : r.staff_members?.name
      const dateStr = r.transaction_date ?? r.created_at?.slice(0, 10) ?? ""
      return [
        dateStr,
        categoryLabel(r.category, r.type),
        subLabel(r.subcategory),
        r.note ?? r.description ?? "",
        signedAmount(r),
        r.balance_after ?? "",
        r.created_by ?? r.registered_by ?? "",
        staff ?? "",
        urls,
      ]
        .map(escape)
        .join(",")
    })

    // BOM付きでExcel互換にする
    const csv = "﻿" + [header.join(","), ...rows].join("\r\n")

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="petty_cash_${year}_${String(month).padStart(2, "0")}.csv"`,
      },
    })
  } catch (e: unknown) {
    console.error("[petty-cash/export-csv]", e)
    const msg = e instanceof Error ? e.message : "unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
