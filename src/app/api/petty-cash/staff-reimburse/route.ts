import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { buildStaffReimburse, buildStaffReimburseCsv } from "@/lib/staff-reimburse"
import type { Database } from "@/types/database"

/** サービスロールキー（全スタッフ分の集計のため） */
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createClient<Database>(url, serviceKey)
}

/** YYYY-MM-DD を1日進める（終了日=含む → 排他境界に変換） */
function addOneDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** 月の範囲 [start, endExclusive) を返す */
function monthRange(year: number, month: number): { start: string; endExclusive: string } {
  const start = `${year}-${String(month).padStart(2, "0")}-01`
  const endYear = month === 12 ? year + 1 : year
  const endMonth = month === 12 ? 1 : month + 1
  const endExclusive = `${endYear}-${String(endMonth).padStart(2, "0")}-01`
  return { start, endExclusive }
}

/** 現在の年月（JST） */
function currentYearMonthJst(): { year: number; month: number } {
  const ym = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).format(new Date()) // "2026-06"
  const [y, m] = ym.split("-").map(Number)
  return { year: y, month: m }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * GET /api/petty-cash/staff-reimburse
 *   ?year=2026&month=6                … 月で集計（既定: 当月）
 *   ?start=2026-06-01&end=2026-06-30   … 任意期間（end含む）で集計
 *   &format=csv                        … CSVダウンロード（省略時はJSON）
 *
 * 会計士向けスタッフ立替まとめ（申請日ベース・全件給与支給）。
 */
export async function GET(req: NextRequest) {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(req.url)
    const format = searchParams.get("format")
    const start = searchParams.get("start")
    const end = searchParams.get("end")
    const yearParam = searchParams.get("year")
    const monthParam = searchParams.get("month")

    let rangeStart: string
    let rangeEndExclusive: string
    let periodLabel: string
    let fileSuffix: string

    if (start && end) {
      if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
        return NextResponse.json({ error: "start/end は YYYY-MM-DD 形式で指定してください" }, { status: 400 })
      }
      if (end < start) {
        return NextResponse.json({ error: "終了日は開始日以降にしてください" }, { status: 400 })
      }
      rangeStart = start
      rangeEndExclusive = addOneDay(end)
      periodLabel = `${start}〜${end}`
      fileSuffix = `${start}_${end}`
    } else {
      // 月指定（未指定なら当月）
      const fallback = currentYearMonthJst()
      const year = Number(yearParam) || fallback.year
      const month = Number(monthParam) || fallback.month
      if (month < 1 || month > 12) {
        return NextResponse.json({ error: "月が不正です" }, { status: 400 })
      }
      const r = monthRange(year, month)
      rangeStart = r.start
      rangeEndExclusive = r.endExclusive
      periodLabel = `${year}年${String(month).padStart(2, "0")}月`
      fileSuffix = `${year}_${String(month).padStart(2, "0")}`
    }

    const service = createServiceClient()
    const result = await buildStaffReimburse({
      supabase: service,
      start: rangeStart,
      endExclusive: rangeEndExclusive,
    })

    if (format === "csv") {
      const csv = buildStaffReimburseCsv(result, periodLabel)
      const fileName = `スタッフ立替まとめ_${periodLabel}.csv`
      const encodedName = encodeURIComponent(fileName)
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="staff_reimburse_${fileSuffix}.csv"; filename*=UTF-8''${encodedName}`,
        },
      })
    }

    return NextResponse.json({ ...result, periodLabel })
  } catch (e: unknown) {
    console.error("[petty-cash/staff-reimburse]", e)
    const msg = e instanceof Error ? e.message : "unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
