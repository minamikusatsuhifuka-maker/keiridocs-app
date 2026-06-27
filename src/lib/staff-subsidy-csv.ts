import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"
import { buildStaffReimburse, buildStaffReimburseCsv } from "@/lib/staff-reimburse"

/**
 * 税理士提出フォルダへコピーする会計士向けCSVの生成。
 *
 * 領収書1件ごとの明細（7列）に統一する:
 *   対象スタッフ / 支払年月日 / 支払先 / 目的・用途 / 支払金額 / 支給割合 / 支給額
 * ＋ スタッフごとの小計行 ＋ 全体合計行。
 *
 * 旧サマリーCSV（小口支給額・給与支給額・保管のみ件数）は廃止（全件給与支給のため不要）。
 * 集計・支給額計算（calcSubsidy）は buildStaffReimburse に集約し、本ファイルはCSV出力の入口のみ担う。
 * 支払年月日は領収書のOCR発行日（未取得は申請日を代用し明記）。期間は申請日ベース。
 */

export interface StaffSubsidyCsvResult {
  csvWithBom: string
  fileName: string
  /** 明細行数（領収書件数）。0なら税理士フォルダへのCSV作成をスキップする判定に使う */
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

/**
 * 会計士向けスタッフ立替明細CSVを生成する。
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
  const periodLabel = `${year}年${monthStr}月`

  const result = await buildStaffReimburse({ supabase, start, endExclusive })
  const csvWithBom = buildStaffReimburseCsv(result, periodLabel)

  return {
    csvWithBom,
    fileName: `スタッフ立替明細_${year}年${monthStr}月.csv`,
    rowCount: result.details.length,
  }
}
