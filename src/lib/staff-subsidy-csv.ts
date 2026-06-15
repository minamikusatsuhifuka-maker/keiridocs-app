import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"
import { calcSubsidy, normalizeSubsidyCategory } from "@/lib/subsidy"

/**
 * 税理士向け「スタッフ別支給額一覧」CSVの生成。
 *
 * 対象月のスタッフ返金（category='staff_refund'）を集計し、
 * スタッフごとに 立替額合計 / 区分内訳 / 支給額合計（半額計算反映）/ 精算方法内訳 をまとめる。
 *
 * 支給額は資料出力時に calcSubsidy で計算する（2回目以降のみ半額・端数切り捨て）。
 * 精算方法が petty_cash / payroll（および後方互換のNULL=小口）の行を「支給」とみなし、
 * storage_only（保管のみ）は支給額には含めない（件数のみ表示）。
 */

interface StaffSubsidyRow {
  staff_member_id: string | null
  amount: number | null
  subsidy_category: string | null
  settlement_method: string | null
  transaction_date: string | null
  created_at: string | null
}

interface StaffAggregate {
  staffName: string
  /** 立替額合計（全staff_refund行） */
  totalAmount: number
  /** 区分別件数 */
  countFirst: number
  countRepeat: number
  countOther: number
  /** 支給額（精算方法別。storage_onlyは支給とみなさない） */
  subsidyPettyCash: number
  subsidyPayroll: number
  /** 精算方法別件数 */
  countPettyCash: number
  countPayroll: number
  countStorage: number
}

export interface StaffSubsidyCsvResult {
  csvWithBom: string
  fileName: string
  rowCount: number
}

/** 月の範囲（[start, endExclusive)）を YYYY-MM-DD で返す */
function monthRange(year: number, month: number): { start: string; endExclusive: string } {
  const start = `${year}-${String(month).padStart(2, "0")}-01`
  const endYear = month === 12 ? year + 1 : year
  const endMonth = month === 12 ? 1 : month + 1
  const endExclusive = `${endYear}-${String(endMonth).padStart(2, "0")}-01`
  return { start, endExclusive }
}

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return ""
  const s = String(value)
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/**
 * スタッフ別支給額CSVを生成する。
 * @param params.supabase 読み取り可能なSupabaseクライアント（認証 or サービスロール）
 * @param params.year     対象年
 * @param params.month    対象月（1-12）
 */
export async function buildStaffSubsidyCsv(params: {
  supabase: SupabaseClient<Database>
  year: number
  month: number
}): Promise<StaffSubsidyCsvResult> {
  const { supabase, year, month } = params
  const { start, endExclusive } = monthRange(year, month)
  const monthStr = String(month).padStart(2, "0")

  // 対象月のスタッフ返金行を取得（transaction_date 優先、NULLは created_at でフィルタ）
  const { data, error } = await supabase
    .from("petty_cash_transactions")
    .select("staff_member_id, amount, subsidy_category, settlement_method, transaction_date, created_at")
    .eq("category", "staff_refund")

  if (error) throw error

  const rows = ((data as unknown as StaffSubsidyRow[]) ?? []).filter((r) => {
    const basis =
      (typeof r.transaction_date === "string" && r.transaction_date) ||
      (typeof r.created_at === "string" ? r.created_at.slice(0, 10) : "")
    if (!basis) return false
    return basis >= start && basis < endExclusive
  })

  // スタッフ名マップ
  const { data: staffRaw } = await supabase.from("staff_members").select("id, name")
  const staffNameMap = new Map<string, string>()
  for (const s of (staffRaw ?? []) as { id: string; name: string }[]) {
    staffNameMap.set(s.id, s.name)
  }

  // スタッフごとに集計
  const agg = new Map<string, StaffAggregate>()
  for (const r of rows) {
    const key = r.staff_member_id ?? "__unknown__"
    const staffName =
      (r.staff_member_id && staffNameMap.get(r.staff_member_id)) || "不明なスタッフ"
    let a = agg.get(key)
    if (!a) {
      a = {
        staffName,
        totalAmount: 0,
        countFirst: 0,
        countRepeat: 0,
        countOther: 0,
        subsidyPettyCash: 0,
        subsidyPayroll: 0,
        countPettyCash: 0,
        countPayroll: 0,
        countStorage: 0,
      }
      agg.set(key, a)
    }

    const amount = typeof r.amount === "number" ? r.amount : 0
    const category = normalizeSubsidyCategory(r.subsidy_category)
    const subsidy = calcSubsidy(amount, category) // 2回目以降のみ半額・端数切り捨て

    a.totalAmount += amount
    if (category === "achievement_first") a.countFirst++
    else if (category === "achievement_repeat") a.countRepeat++
    else a.countOther++

    // 精算方法（NULLは後方互換で小口返金扱い）
    const method = r.settlement_method
    if (method === "payroll") {
      a.countPayroll++
      a.subsidyPayroll += subsidy
    } else if (method === "storage_only") {
      // 保管のみは支給とみなさない（件数のみ）
      a.countStorage++
    } else {
      a.countPettyCash++
      a.subsidyPettyCash += subsidy
    }
  }

  // CSV組み立て
  const header = [
    "スタッフ名",
    "立替額合計",
    "初参加(件)",
    "2回目以降(件)",
    "それ以外(件)",
    "支給額合計",
    "小口支給額",
    "給与支給額",
    "保管のみ(件)",
  ]

  // スタッフ名の昇順で安定ソート
  const aggregates = [...agg.values()].sort((a, b) =>
    a.staffName.localeCompare(b.staffName, "ja")
  )

  const bodyRows = aggregates.map((a) => {
    const subsidyTotal = a.subsidyPettyCash + a.subsidyPayroll
    return [
      a.staffName,
      a.totalAmount,
      a.countFirst,
      a.countRepeat,
      a.countOther,
      subsidyTotal,
      a.subsidyPettyCash,
      a.subsidyPayroll,
      a.countStorage,
    ]
  })

  // 合計行
  const totals = aggregates.reduce(
    (acc, a) => {
      acc.totalAmount += a.totalAmount
      acc.countFirst += a.countFirst
      acc.countRepeat += a.countRepeat
      acc.countOther += a.countOther
      acc.subsidyPettyCash += a.subsidyPettyCash
      acc.subsidyPayroll += a.subsidyPayroll
      acc.countStorage += a.countStorage
      return acc
    },
    {
      totalAmount: 0,
      countFirst: 0,
      countRepeat: 0,
      countOther: 0,
      subsidyPettyCash: 0,
      subsidyPayroll: 0,
      countStorage: 0,
    }
  )
  const totalRow = [
    "合計",
    totals.totalAmount,
    totals.countFirst,
    totals.countRepeat,
    totals.countOther,
    totals.subsidyPettyCash + totals.subsidyPayroll,
    totals.subsidyPettyCash,
    totals.subsidyPayroll,
    totals.countStorage,
  ]

  const allRows = [header, ...bodyRows, totalRow]
  // BOM付きUTF-8（Excel互換）、改行はCRLF
  const csvWithBom = "﻿" + allRows.map((row) => row.map(escapeCsv).join(",")).join("\r\n")

  return {
    csvWithBom,
    fileName: `スタッフ別支給額_${year}年${monthStr}月.csv`,
    rowCount: bodyRows.length,
  }
}
