import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"
import { calcSubsidy, subsidyRate } from "@/lib/subsidy"

/**
 * 会計士向け「スタッフ立替まとめ」の集計（共通ロジック）。
 *
 * 新ルール（2026/06改修後）に対応:
 *  - スタッフ立替は全件「給与支給」
 *  - 詳細区分は petty_cash_transactions.expense_detail（6種フル名称）に保存
 *  - 支給率は「セミナー2回目以降」(subsidy_category=achievement_repeat) のみ半額（Math.floor）、他は全額
 *
 * 集計の基準日 = 申請日（アップロード日）。
 *  - staff_receipt_id があれば staff_receipts.created_at（実アップロード日時）を優先
 *  - なければ petty_cash_transactions.created_at（精算登録日時＝申請とほぼ同時）
 *  どちらも日本時間（JST）で日付に変換して期間判定する。
 */

/** 明細1行（各立替） */
export interface ReimburseDetail {
  transactionId: string
  staffMemberId: string | null
  staffName: string
  /** 申請日（YYYY-MM-DD・JST） */
  applicationDate: string
  storeName: string
  /** 区分のフル名称（expense_detail）。未設定は「（区分未設定）」 */
  expenseDetail: string
  /** 立替額 */
  amount: number
  /** 支給率が半額か（セミナー2回目以降のみ true） */
  isHalf: boolean
  /** 支給額（半額計算反映・端数切り捨て） */
  subsidy: number
  /** 過去データ互換用（精算方法。新規は全件 payroll） */
  settlementMethod: string | null
}

/** スタッフ毎サマリー */
export interface ReimburseSummary {
  staffMemberId: string | null
  staffName: string
  count: number
  totalAmount: number
  totalSubsidy: number
}

export interface StaffReimburseResult {
  summaries: ReimburseSummary[]
  details: ReimburseDetail[]
  totals: { count: number; totalAmount: number; totalSubsidy: number }
}

interface TxRow {
  id: string
  staff_member_id: string | null
  amount: number
  expense_detail: string | null
  subsidy_category: string | null
  settlement_method: string | null
  created_at: string
  description: string | null
  note: string | null
  staff_receipt_id: string | null
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

/** description/note（"スタッフ名/店名" 形式）から店名を取り出す（受領レシートが無い行のフォールバック） */
function parseStoreFromDescription(text: string | null): string {
  if (!text) return ""
  const idx = text.indexOf("/")
  if (idx < 0) return ""
  return text.slice(idx + 1).trim()
}

/**
 * 期間（申請日ベース・[start, endExclusive)）でスタッフ立替を集計する。
 * @param params.start        開始日（YYYY-MM-DD・JST・含む）
 * @param params.endExclusive 終了日（YYYY-MM-DD・JST・含まない）
 */
export async function buildStaffReimburse(params: {
  supabase: SupabaseClient<Database>
  start: string
  endExclusive: string
}): Promise<StaffReimburseResult> {
  const { supabase, start, endExclusive } = params

  // 1. スタッフ立替の取引行（全件）を取得し、JSで申請日フィルタ
  const { data: txRaw, error: txError } = await supabase
    .from("petty_cash_transactions")
    .select(
      "id, staff_member_id, amount, expense_detail, subsidy_category, settlement_method, created_at, description, note, staff_receipt_id"
    )
    .eq("category", "staff_refund")
  if (txError) throw txError
  const txRows = (txRaw as unknown as TxRow[]) ?? []

  // 2. 参照されている領収書（店名・アップロード日時）をまとめて取得
  const receiptIds = Array.from(
    new Set(txRows.map((t) => t.staff_receipt_id).filter((v): v is string => !!v))
  )
  const receiptMap = new Map<string, { store_name: string | null; created_at: string }>()
  if (receiptIds.length > 0) {
    const { data: receipts } = await supabase
      .from("staff_receipts")
      .select("id, store_name, created_at")
      .in("id", receiptIds)
    for (const r of (receipts ?? []) as { id: string; store_name: string | null; created_at: string }[]) {
      receiptMap.set(r.id, { store_name: r.store_name, created_at: r.created_at })
    }
  }

  // 3. スタッフ名マップ
  const { data: staffRaw } = await supabase.from("staff_members").select("id, name")
  const staffNameMap = new Map<string, string>()
  for (const s of (staffRaw ?? []) as { id: string; name: string }[]) {
    staffNameMap.set(s.id, s.name)
  }

  // 4. 明細を組み立て（申請日で期間フィルタ）
  const details: ReimburseDetail[] = []
  for (const t of txRows) {
    const receipt = t.staff_receipt_id ? receiptMap.get(t.staff_receipt_id) : undefined
    // 申請日（アップロード日）: 領収書のcreated_atを優先、無ければ取引のcreated_at
    const applicationDate = toJstDate(receipt?.created_at ?? t.created_at)
    if (!applicationDate || applicationDate < start || applicationDate >= endExclusive) continue

    const amount = typeof t.amount === "number" ? t.amount : 0
    const storeName =
      receipt?.store_name?.trim() || parseStoreFromDescription(t.description ?? t.note) || "不明"
    const expenseDetail = t.expense_detail?.trim() || "（区分未設定）"
    const isHalf = subsidyRate(t.subsidy_category) < 1
    const subsidy = calcSubsidy(amount, t.subsidy_category)
    const staffName =
      (t.staff_member_id && staffNameMap.get(t.staff_member_id)) || "不明なスタッフ"

    details.push({
      transactionId: t.id,
      staffMemberId: t.staff_member_id,
      staffName,
      applicationDate,
      storeName,
      expenseDetail,
      amount,
      isHalf,
      subsidy,
      settlementMethod: t.settlement_method,
    })
  }

  // 5. スタッフ毎サマリー
  const aggMap = new Map<string, ReimburseSummary>()
  for (const d of details) {
    const key = d.staffMemberId ?? "__unknown__"
    let a = aggMap.get(key)
    if (!a) {
      a = {
        staffMemberId: d.staffMemberId,
        staffName: d.staffName,
        count: 0,
        totalAmount: 0,
        totalSubsidy: 0,
      }
      aggMap.set(key, a)
    }
    a.count += 1
    a.totalAmount += d.amount
    a.totalSubsidy += d.subsidy
  }

  // 並び順: スタッフ名昇順、明細はスタッフ名→申請日
  const summaries = [...aggMap.values()].sort((a, b) => a.staffName.localeCompare(b.staffName, "ja"))
  details.sort(
    (a, b) =>
      a.staffName.localeCompare(b.staffName, "ja") || a.applicationDate.localeCompare(b.applicationDate)
  )

  const totals = details.reduce(
    (acc, d) => {
      acc.count += 1
      acc.totalAmount += d.amount
      acc.totalSubsidy += d.subsidy
      return acc
    },
    { count: 0, totalAmount: 0, totalSubsidy: 0 }
  )

  return { summaries, details, totals }
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

/**
 * 会計士向けCSV（BOM付きUTF-8・CRLF）。
 * 上段にスタッフ毎サマリー、下段に明細を1ファイルにまとめる（給与反映にそのまま使える構成）。
 */
export function buildStaffReimburseCsv(result: StaffReimburseResult, periodLabel: string): string {
  const lines: string[][] = []

  lines.push([`スタッフ立替まとめ（${periodLabel}・申請日ベース・全件給与支給）`])
  lines.push([])

  // サマリー
  lines.push(["■ スタッフ毎サマリー"])
  lines.push(["スタッフ名", "立替件数", "立替額合計", "支給額合計"])
  for (const s of result.summaries) {
    lines.push([s.staffName, String(s.count), String(s.totalAmount), String(s.totalSubsidy)])
  }
  lines.push([
    "合計",
    String(result.totals.count),
    String(result.totals.totalAmount),
    String(result.totals.totalSubsidy),
  ])
  lines.push([])

  // 明細
  lines.push(["■ 明細"])
  lines.push(["スタッフ名", "申請日", "店名", "区分", "立替額", "支給率", "支給額"])
  for (const d of result.details) {
    lines.push([
      d.staffName,
      d.applicationDate,
      d.storeName,
      d.expenseDetail,
      String(d.amount),
      d.isHalf ? "半額" : "全額",
      String(d.subsidy),
    ])
  }

  const body = lines.map((row) => row.map(escapeCsv).join(",")).join("\r\n")
  // BOM付きUTF-8（Excel互換）
  return "﻿" + body
}
