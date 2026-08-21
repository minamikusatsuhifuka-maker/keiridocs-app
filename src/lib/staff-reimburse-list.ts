// スタッフ立替専用メニュー（/staff-reimburse）の一覧データ生成。
//
// 目的:
//   小口現金の取引一覧に混ざっていたスタッフ立替を、1件1行の独立した明細として扱う。
//   分割登録（1ファイルに複数の領収証）は合算せず、レコードごとに1行で出す。
//
// 金額の一貫性（重要）:
//   立替額・支給割合・支給額は会計士向け立替明細CSV（lib/staff-reimburse.ts）と
//   まったく同じ元データ（petty_cash_transactions.amount / subsidy_category）と
//   同じ関数（calcSubsidy）で算出する。表示・CSVで金額がずれないようにするため、
//   独自の再計算は行わない。
//
// 日付の定義:
//   申請日 … 実際に申請・登録された日（petty_cash_transactions.created_at・JST）
//            LINEはLINE送信日時、管理画面の承認・手動登録は登録操作の日時。
//   提出日 … 20日締めの月割り判定に使う日（staff_receipts.created_at・JST）
//            承認・手動登録では操作者が明示指定する。LINEは送信日と一致する。
//   支払年月日 … 領収書自身の領収日（ai_raw.issue_date → staff_receipts.date の順）

import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"
import { calcSubsidy, subsidyRate, STAFF_EXPENSE_DETAILS } from "@/lib/subsidy"
import { getSplitGroupInfo, parseAiRawObject } from "@/lib/staff-receipt-split"
import { resolveStaffSubmissionMonth, formatYearMonth } from "@/lib/submission-month"
import { extractIssueDate } from "@/lib/staff-reimburse"
import { fetchAllRows } from "@/lib/supabase/fetch-all"

/** 登録経路 */
export type ReimburseSource = "line" | "admin_approve" | "manual" | "petty_manual"

/** 登録経路の日本語ラベル（画面・CSV共通） */
export const SOURCE_LABELS: Record<ReimburseSource, string> = {
  line: "LINE",
  admin_approve: "管理画面の承認",
  manual: "手動登録",
  petty_manual: "手動登録（小口）",
}

/** 一覧1行 */
export interface StaffReimburseRow {
  transactionId: string
  /** staff_receipts.id（資料リンク・編集・削除に使う。領収書なしの行は null） */
  receiptId: string | null
  staffMemberId: string | null
  staffName: string
  /** 申請日（YYYY-MM-DD・JST） */
  applicationDate: string
  /** 提出日（YYYY-MM-DD・JST。20日締めの月割り判定に使う日付） */
  submitDate: string
  /** 支払年月日（領収日。読み取れていない場合は ""） */
  paymentDate: string
  storeName: string
  /** 費用区分のフル名称 */
  expenseDetail: string
  /** 費用区分キー（編集ダイアログのプリフィル用） */
  detailKey: string
  amount: number
  /** 支給割合が半額か（セミナー2回目以降のみ true） */
  isHalf: boolean
  subsidy: number
  source: ReimburseSource
  registeredBy: string
  /** 登録資料（Dropbox実ファイル）があるか */
  hasFile: boolean
  /** 資料のファイル名（表示用。資料なしは ""） */
  fileName: string
  /** 資料のDropboxパス（Dropboxウェブを開くリンク用。資料なしは ""） */
  dropboxPath: string
  /** 提出月（税理士フォルダの振り分け先。"YYYY-MM"。判定不能は ""） */
  submissionMonth: string
  /** 提出月が手動指定か（false は提出日20日締めの自動判定） */
  submissionMonthManual: boolean
  /** 自動判定した場合の提出月（手動指定を解除したときに戻る月。"YYYY-MM"） */
  autoSubmissionMonth: string
  /** 同一ファイル由来の分割グループID（分割でない行は null） */
  splitGroup: string | null
  /** 分割の何件目か（1始まり。分割でない行は 0） */
  splitIndex: number
  /** 分割の総件数（分割でない行は 0） */
  splitTotal: number
}

/** スタッフ別小計 */
export interface StaffReimburseSubtotal {
  staffMemberId: string | null
  staffName: string
  count: number
  totalAmount: number
  totalSubsidy: number
}

export interface StaffReimburseListResult {
  rows: StaffReimburseRow[]
  subtotals: StaffReimburseSubtotal[]
  totals: { count: number; totalAmount: number; totalSubsidy: number }
}

/** 絞り込みの基準日 */
export type DateBasis = "application" | "submit" | "payment"

export interface ListFilter {
  /** 期間の基準日（既定: 提出日＝税理士提出の月割りと同じ軸） */
  basis?: DateBasis
  /** 開始日 YYYY-MM-DD（含む）。未指定なら下限なし */
  start?: string
  /** 終了日 YYYY-MM-DD（含む）。未指定なら上限なし */
  end?: string
  /** スタッフ絞り込み（staff_members.id） */
  staffMemberId?: string
  /** 費用区分のフル名称で絞り込み */
  expenseDetail?: string
  /** 提出月で絞り込み（"YYYY-MM"） */
  submissionMonth?: string
}

interface TxRow {
  id: string
  staff_member_id: string | null
  amount: number | null
  expense_detail: string | null
  subsidy_category: string | null
  created_at: string
  transaction_date: string | null
  description: string | null
  note: string | null
  registered_by: string | null
  staff_receipt_id: string | null
}

interface ReceiptRow {
  id: string
  store_name: string | null
  date: string | null
  created_at: string
  dropbox_path: string | null
  ai_raw: unknown
}

/** ISO日時を日本時間の YYYY-MM-DD に変換（サーバTZがUTCのため明示変換） */
function toJstDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ""
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
}

/** description/note（"スタッフ名/店名" 形式）から店名を取り出す（領収書が無い行のフォールバック） */
function parseStoreFromDescription(text: string | null): string {
  if (!text) return ""
  const idx = text.indexOf("/")
  if (idx < 0) return ""
  return text.slice(idx + 1).trim()
}

/** 手動登録（管理画面）を示す registered_by タグ（api/staff-refund/manual-entry と同じ値） */
const MANUAL_TAG = "手動登録（管理画面）"

/** 登録経路を判定する */
function detectSource(
  registeredBy: string | null,
  aiRaw: Record<string, unknown> | null,
  hasReceipt: boolean
): ReimburseSource {
  const src = typeof aiRaw?.source === "string" ? aiRaw.source : ""
  if (src === "admin_upload") return "admin_approve"
  if (src === "manual_admin") return "manual"
  if (registeredBy === MANUAL_TAG) return "manual"
  if (registeredBy && /（LINE）\s*$/.test(registeredBy)) return "line"
  // 領収書レコードを持たない＝小口現金画面からの手入力
  return hasReceipt ? "admin_approve" : "petty_manual"
}

/**
 * スタッフ立替の一覧を組み立てる。
 *
 * テストスタッフ（staff_members.is_test）の申請は会計士CSVと同じく除外する
 * （新メニューのCSVと立替明細CSVで金額を一致させるため）。
 */
export async function buildStaffReimburseList(params: {
  supabase: SupabaseClient<Database>
  filter?: ListFilter
}): Promise<StaffReimburseListResult> {
  const { supabase } = params
  const filter = params.filter ?? {}
  const basis: DateBasis = filter.basis ?? "submit"

  // 1. スタッフ立替の取引を全件取得（ページング必須）
  const txRows = await fetchAllRows<TxRow>((from, to) =>
    supabase
      .from("petty_cash_transactions")
      .select(
        "id, staff_member_id, amount, expense_detail, subsidy_category, created_at, transaction_date, description, note, registered_by, staff_receipt_id"
      )
      .eq("category", "staff_refund")
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: TxRow[] | null; error: { message: string } | null }>
  )

  // 2. 参照されている領収書をまとめて取得（200件ずつ）
  const receiptIds = Array.from(
    new Set(txRows.map((t) => t.staff_receipt_id).filter((v): v is string => !!v))
  )
  const receiptMap = new Map<string, ReceiptRow>()
  for (let i = 0; i < receiptIds.length; i += 200) {
    const chunk = receiptIds.slice(i, i + 200)
    const { data } = await supabase
      .from("staff_receipts")
      .select("id, store_name, date, created_at, dropbox_path, ai_raw")
      .in("id", chunk)
    for (const r of (data ?? []) as ReceiptRow[]) receiptMap.set(r.id, r)
  }

  // 3. スタッフ名・テストスタッフ判定
  const staffRaw = await fetchAllRows<{ id: string; name: string; is_test: boolean | null }>((from, to) =>
    supabase
      .from("staff_members")
      .select("id, name, is_test")
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: { id: string; name: string; is_test: boolean | null }[] | null
        error: { message: string } | null
      }>
  )
  const staffNameMap = new Map<string, string>()
  const testStaffIds = new Set<string>()
  for (const s of staffRaw) {
    staffNameMap.set(s.id, s.name)
    if (s.is_test) testStaffIds.add(s.id)
  }

  // 4. 行を組み立て
  const rows: StaffReimburseRow[] = []
  for (const t of txRows) {
    if (t.staff_member_id && testStaffIds.has(t.staff_member_id)) continue

    const receipt = t.staff_receipt_id ? receiptMap.get(t.staff_receipt_id) : undefined
    const aiRaw = parseAiRawObject(receipt?.ai_raw)
    const splitInfo = getSplitGroupInfo(receipt?.ai_raw)

    const applicationDate = toJstDate(t.created_at)
    const submitDate = toJstDate(receipt?.created_at ?? t.created_at)
    // 支払年月日: OCR発行日（ai_raw.issue_date）→ staff_receipts.date → 取引の transaction_date
    const paymentDate = receipt
      ? extractIssueDate(receipt.ai_raw) || (receipt.date ?? "").slice(0, 10)
      : (t.transaction_date ?? "").slice(0, 10)

    const amount = typeof t.amount === "number" ? t.amount : 0
    const expenseDetail = t.expense_detail?.trim() || "（区分未設定）"
    const detailKey =
      (typeof aiRaw?.detail_key === "string" && aiRaw.detail_key) ||
      STAFF_EXPENSE_DETAILS.find((d) => d.fullLabel === (t.expense_detail ?? ""))?.key ||
      ""
    const dropboxPath = receipt?.dropbox_path?.trim() ?? ""
    // 提出月＝手動指定（ai_raw.submission_month）優先、無ければ提出日の20日締め
    const submission = resolveStaffSubmissionMonth(receipt?.ai_raw, submitDate)

    rows.push({
      transactionId: t.id,
      receiptId: t.staff_receipt_id,
      staffMemberId: t.staff_member_id,
      staffName: (t.staff_member_id && staffNameMap.get(t.staff_member_id)) || "不明なスタッフ",
      applicationDate,
      submitDate,
      paymentDate,
      storeName:
        receipt?.store_name?.trim() || parseStoreFromDescription(t.description ?? t.note) || "不明",
      expenseDetail,
      detailKey,
      amount,
      isHalf: subsidyRate(t.subsidy_category) < 1,
      subsidy: calcSubsidy(amount, t.subsidy_category),
      source: detectSource(t.registered_by, aiRaw, !!receipt),
      registeredBy: t.registered_by ?? "",
      submissionMonth: submission.month ? formatYearMonth(submission.month) : "",
      submissionMonthManual: submission.source === "manual",
      autoSubmissionMonth: submission.autoMonth ? formatYearMonth(submission.autoMonth) : "",
      hasFile: dropboxPath !== "",
      fileName: dropboxPath ? (dropboxPath.split("/").pop() ?? "") : "",
      dropboxPath,
      splitGroup: splitInfo?.group ?? null,
      splitIndex: splitInfo?.index ?? 0,
      splitTotal: splitInfo?.total ?? 0,
    })
  }

  // 5. 同一ファイル由来の分割を、split_group を持たない行も含めて補完する。
  //    分割兄弟は同一 dropbox_path を共有するため、ファイル単位で2件以上あれば分割として扱う。
  const byPath = new Map<string, StaffReimburseRow[]>()
  for (const r of rows) {
    const receipt = r.receiptId ? receiptMap.get(r.receiptId) : undefined
    const path = receipt?.dropbox_path?.trim() ?? ""
    if (!path) continue
    const arr = byPath.get(path) ?? []
    arr.push(r)
    byPath.set(path, arr)
  }
  for (const [path, group] of byPath) {
    if (group.length < 2) continue
    // split_index 順（未設定は登録順）に 1/n を振り直す
    const ordered = [...group].sort(
      (a, b) => a.splitIndex - b.splitIndex || a.transactionId.localeCompare(b.transactionId)
    )
    ordered.forEach((r, i) => {
      r.splitGroup = r.splitGroup ?? path
      r.splitIndex = i + 1
      r.splitTotal = ordered.length
    })
  }

  // 6. 絞り込み
  const dateOf = (r: StaffReimburseRow): string =>
    basis === "application" ? r.applicationDate : basis === "payment" ? r.paymentDate : r.submitDate

  const filtered = rows.filter((r) => {
    if (filter.staffMemberId && r.staffMemberId !== filter.staffMemberId) return false
    if (filter.expenseDetail && r.expenseDetail !== filter.expenseDetail) return false
    if (filter.submissionMonth && r.submissionMonth !== filter.submissionMonth) return false
    const d = dateOf(r)
    // 基準日が空（支払年月日が読み取れていない等）の行は期間指定時に除外しない＝取りこぼしを防ぐ
    if (d) {
      if (filter.start && d < filter.start) return false
      if (filter.end && d > filter.end) return false
    }
    return true
  })

  // 7. 並び順の既定: スタッフ名 → 提出日 → 分割順
  filtered.sort(
    (a, b) =>
      a.staffName.localeCompare(b.staffName, "ja") ||
      a.submitDate.localeCompare(b.submitDate) ||
      a.splitIndex - b.splitIndex
  )

  // 8. スタッフ別小計・全体合計
  const subMap = new Map<string, StaffReimburseSubtotal>()
  for (const r of filtered) {
    const key = r.staffMemberId ?? "__unknown__"
    const cur = subMap.get(key) ?? {
      staffMemberId: r.staffMemberId,
      staffName: r.staffName,
      count: 0,
      totalAmount: 0,
      totalSubsidy: 0,
    }
    cur.count += 1
    cur.totalAmount += r.amount
    cur.totalSubsidy += r.subsidy
    subMap.set(key, cur)
  }
  const subtotals = [...subMap.values()].sort((a, b) =>
    a.staffName.localeCompare(b.staffName, "ja")
  )
  const totals = filtered.reduce(
    (acc, r) => {
      acc.count += 1
      acc.totalAmount += r.amount
      acc.totalSubsidy += r.subsidy
      return acc
    },
    { count: 0, totalAmount: 0, totalSubsidy: 0 }
  )

  return { rows: filtered, subtotals, totals }
}

/* ---------- CSV出力 ---------- */

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return ""
  const s = String(value)
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/** 一覧の列定義（CSV・xlsx・画面で共有する） */
export const LIST_HEADERS = [
  "申請日",
  "提出日",
  "支払年月日",
  "スタッフ名",
  "支払先",
  "目的・用途",
  "立替額",
  "支給割合",
  "支給額",
  "登録経路",
  "分割",
  "資料",
] as const

/** 1行をセル配列にする（CSV・xlsxで共有） */
export function rowToCells(r: StaffReimburseRow): string[] {
  return [
    r.applicationDate,
    r.submitDate,
    r.paymentDate,
    r.staffName,
    r.storeName,
    r.expenseDetail,
    String(r.amount),
    r.isHalf ? "半額" : "全額",
    String(r.subsidy),
    SOURCE_LABELS[r.source],
    r.splitTotal > 1 ? `分割 ${r.splitIndex}/${r.splitTotal}` : "",
    r.hasFile ? r.fileName : "資料なし",
  ]
}

/**
 * スタッフ立替一覧のCSV（BOM付きUTF-8・CRLF）。
 * 立替額・支給額は会計士向け立替明細CSVと同じ計算のため、同一期間・同一条件なら金額が一致する。
 */
export function buildStaffReimburseListCsv(
  result: StaffReimburseListResult,
  periodLabel: string
): string {
  const lines: string[][] = []
  lines.push([`スタッフ立替一覧（${periodLabel}・1件1行）`])
  lines.push([])
  lines.push([...LIST_HEADERS])

  // スタッフごとに明細→小計（既定の並び順はスタッフ名でまとまっている）
  const sorted = [...result.rows].sort(
    (a, b) =>
      a.staffName.localeCompare(b.staffName, "ja") ||
      a.submitDate.localeCompare(b.submitDate) ||
      a.splitIndex - b.splitIndex
  )
  let i = 0
  while (i < sorted.length) {
    const key = sorted[i].staffMemberId ?? "__unknown__"
    const staffName = sorted[i].staffName
    let amount = 0
    let subsidy = 0
    while (i < sorted.length && (sorted[i].staffMemberId ?? "__unknown__") === key) {
      lines.push(rowToCells(sorted[i]))
      amount += sorted[i].amount
      subsidy += sorted[i].subsidy
      i++
    }
    lines.push([`${staffName} 小計`, "", "", "", "", "", String(amount), "", String(subsidy), "", "", ""])
  }

  lines.push([
    "合計",
    "",
    "",
    "",
    "",
    "",
    String(result.totals.totalAmount),
    "",
    String(result.totals.totalSubsidy),
    `${result.totals.count}件`,
    "",
    "",
  ])

  const body = lines.map((row) => row.map(escapeCsv).join(",")).join("\r\n")
  return "﻿" + body
}
