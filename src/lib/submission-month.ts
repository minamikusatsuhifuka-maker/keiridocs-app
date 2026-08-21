import { processingMonthOfDate, staffCutoffMonth } from "@/lib/tax-folder-structure"
import { parseAiRawObject } from "@/lib/staff-receipt-split"

/**
 * 「提出月」＝税理士提出フォルダの振り分け先（YYYY年MM月）を決める共通ロジック。
 *
 * ■ 決め方（手動指定が自動判定より優先）
 *   1. 手動指定（documents.ocr_raw.submission_month / staff_receipts.ai_raw.submission_month）
 *   2. 自動判定（従来どおり。挙動は変えない）
 *      - 通常書類    : 基準日（発行日→支払期日→取込日）の翌月（processingMonthOfDate）
 *      - スタッフ領収書: 提出日の20日締め（staffCutoffMonth）
 *
 * ■ 保存場所
 *   スキーマ変更を避け、既存の jsonb（ocr_raw / ai_raw）に "submission_month": "YYYY-MM" を持たせる。
 *   ai_raw は文字列でJSONが入っている行があるため、読み書きとも parseAiRawObject でオブジェクト化して扱い、
 *   書き戻しは元の形式（文字列だったものは文字列）を保つ。
 *
 * ■ 期間基準の統一
 *   ファイル配置（tax-folder-copy）と明細CSV・一覧の集計月は、いずれも本ファイルの解決結果を使う。
 *   これにより「その月のフォルダに入っているファイル」と「その月のCSVの中身」が一致する。
 */

export interface YearMonth {
  year: number
  month: number
}

/** "YYYY-MM" → YearMonth（不正な値は null） */
export function parseYearMonth(value: unknown): YearMonth | null {
  if (typeof value !== "string") return null
  const m = value.match(/^(\d{4})-(\d{2})$/)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null
  return { year, month }
}

/** YearMonth → "YYYY-MM" */
export function formatYearMonth(ym: YearMonth): string {
  return `${ym.year}-${String(ym.month).padStart(2, "0")}`
}

/** YearMonth → 「YYYY年MM月」（フォルダ名・画面表示用） */
export function labelYearMonth(ym: YearMonth): string {
  return `${ym.year}年${String(ym.month).padStart(2, "0")}月`
}

export function sameYearMonth(a: YearMonth | null, b: YearMonth | null): boolean {
  if (!a || !b) return false
  return a.year === b.year && a.month === b.month
}

/** jsonb（オブジェクト or JSON文字列）から手動指定の提出月を読む */
export function readManualSubmissionMonth(raw: unknown): YearMonth | null {
  const obj = parseAiRawObject(raw)
  if (!obj) return null
  return parseYearMonth(obj.submission_month)
}

/**
 * jsonb に手動指定の提出月を書き込んだ値を返す（元の形式を保つ）。
 * month に null を渡すとキーごと削除して自動判定に戻す。
 */
export function withManualSubmissionMonth(raw: unknown, month: YearMonth | null): unknown {
  const obj = { ...(parseAiRawObject(raw) ?? {}) }
  if (month) {
    obj.submission_month = formatYearMonth(month)
  } else {
    delete obj.submission_month
  }
  // 元が JSON文字列だった行は文字列のまま書き戻す（既存の読み取り側の想定を変えない）
  return typeof raw === "string" ? JSON.stringify(obj) : obj
}

/** 提出月の決まり方（画面で自動／手動を区別するために使う） */
export type SubmissionMonthSource = "manual" | "auto" | "none"

export interface ResolvedSubmissionMonth {
  month: YearMonth | null
  source: SubmissionMonthSource
  /** 自動判定の結果（手動指定があっても、元の自動判定が何月かを画面で示せるように保持） */
  autoMonth: YearMonth | null
}

/**
 * 通常書類（documents）の提出月を解決する。
 * @param ocrRaw    documents.ocr_raw（手動指定の保存先）
 * @param baseDate  基準日（発行日 → 支払期日 → 取込日 の優先で呼び出し側が決めた値）
 */
export function resolveDocumentSubmissionMonth(
  ocrRaw: unknown,
  baseDate: string | null | undefined
): ResolvedSubmissionMonth {
  const autoMonth = processingMonthOfDate(baseDate)
  const manual = readManualSubmissionMonth(ocrRaw)
  if (manual) return { month: manual, source: "manual", autoMonth }
  return { month: autoMonth, source: autoMonth ? "auto" : "none", autoMonth }
}

/**
 * スタッフ領収書（staff_receipts）の提出月を解決する。
 * @param aiRaw      staff_receipts.ai_raw（手動指定の保存先）
 * @param submitDate 提出日（JST・YYYY-MM-DD。staff_receipts.created_at が正本）
 */
export function resolveStaffSubmissionMonth(
  aiRaw: unknown,
  submitDate: string | null | undefined
): ResolvedSubmissionMonth {
  const autoMonth = staffCutoffMonth(submitDate)
  const manual = readManualSubmissionMonth(aiRaw)
  if (manual) return { month: manual, source: "manual", autoMonth }
  return { month: autoMonth, source: autoMonth ? "auto" : "none", autoMonth }
}
