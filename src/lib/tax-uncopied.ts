import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"
import { fetchAllRows } from "@/lib/supabase/fetch-all"
import { listFilesRecursive } from "@/lib/dropbox"
import { staffCutoffMonth, STAFF_RECEIPT_SUBFOLDER } from "@/lib/tax-folder-structure"

/**
 * 税理士提出フォルダへ「まだコピーされていない」スタッフ立替を検出する。
 *
 * ■ 背景
 *  提出書類一覧（xlsx / CSV）は「税理士提出フォルダにコピー済みのファイル」を起点に作られるため、
 *  コピー実行後に申請された分は、次にコピーが走るまでリストに現れない。
 *  実際に 2026-08-20 22:00（cron実行）の後に申請された22件が、8月分の提出リストから抜けていた。
 *  漏れているのか単に未コピーなのかを画面で判別できるよう、
 *  DB側の対象月データと Dropbox 側のファイル一覧を突き合わせて差分を返す。
 *
 * ■ 対象月の判定
 *  ファイル配置と同じ「提出日の20日締め」（前月21日〜当月20日提出分 → 当月）。
 *  提出日の正本は staff_receipts.created_at（無ければ取引の created_at にフォールバック）。
 */

type Client = SupabaseClient<Database>

/** 未コピーの1件 */
export interface UncopiedStaffItem {
  transactionId: string
  staffName: string
  /** 提出日（JST・YYYY-MM-DD） */
  submitDate: string
  /** 目的・用途（expense_detail） */
  expenseDetail: string
  /** 立替額 */
  amount: number
  /** 領収書のファイル名 */
  fileName: string
}

export interface UncopiedStaffResult {
  year: number
  month: number
  /** 対象月のスタッフ立替のうち、税理士提出フォルダに未コピーのもの */
  items: UncopiedStaffItem[]
  /** 対象月のスタッフ立替の総件数（コピー済みを含む） */
  totalCount: number
  /** 対象月を含む最後のコピー実行日時（JST「YYYY-MM-DD HH:mm」。履歴が無ければ null） */
  lastCopiedAt: string | null
  /** 最後のコピーの実行者（cron自動実行なら実行種別が入る） */
  lastCopiedBy: string | null
  /** Dropboxの一覧が取得できなかった場合 true（この場合 items は空にして誤警告を避ける） */
  dropboxUnavailable: boolean
}

/** ISO日時 → JSTの YYYY-MM-DD */
function toJstDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
}

/** ISO日時 → JSTの「YYYY-MM-DD HH:mm」（最終コピー実行日時の表示用） */
function toJstDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`
}

type TxRow = {
  id: string
  staff_member_id: string | null
  staff_receipt_id: string | null
  amount: number | null
  expense_detail: string | null
  created_at: string
  receipt_urls: unknown
}

/**
 * 指定年月について、税理士提出フォルダに未コピーのスタッフ立替を洗い出す。
 * 参照のみで、DBもDropboxも変更しない。
 */
export async function findUncopiedStaffReimburse(params: {
  supabase: Client
  year: number
  month: number
}): Promise<UncopiedStaffResult> {
  const { supabase, year, month } = params
  const monthStr = String(month).padStart(2, "0")
  const ym = `${year}-${monthStr}`

  // 1. スタッフ立替の取引を全件取得（PostgRESTの1000件上限があるためページング必須）
  const txRows = await fetchAllRows<TxRow>((from, to) =>
    supabase
      .from("petty_cash_transactions")
      .select("id, staff_member_id, staff_receipt_id, amount, expense_detail, created_at, receipt_urls")
      .eq("category", "staff_refund")
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: TxRow[] | null; error: { message: string } | null }>
  )

  // 2. 提出日の正本（staff_receipts.created_at）をまとめて取得
  const receiptIds = Array.from(
    new Set(txRows.map((t) => t.staff_receipt_id).filter((v): v is string => !!v))
  )
  const receiptCreatedAt = new Map<string, string>()
  for (let i = 0; i < receiptIds.length; i += 200) {
    const { data } = await supabase
      .from("staff_receipts")
      .select("id, created_at")
      .in("id", receiptIds.slice(i, i + 200))
    for (const r of (data ?? []) as { id: string; created_at: string }[]) {
      receiptCreatedAt.set(r.id, r.created_at)
    }
  }

  // 3. スタッフ名・テストスタッフ（コピー対象外なので警告からも除く）
  const staffRows = await fetchAllRows<{ id: string; name: string; is_test: boolean | null }>((from, to) =>
    supabase
      .from("staff_members")
      .select("id, name, is_test")
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: { id: string; name: string; is_test: boolean | null }[] | null
        error: { message: string } | null
      }>
  )
  const staffMap = new Map(staffRows.map((s) => [s.id, s]))

  // 4. 対象月（提出日20日締め）のスタッフ立替を抽出
  const targets: UncopiedStaffItem[] = []
  for (const t of txRows) {
    const staff = t.staff_member_id ? staffMap.get(t.staff_member_id) : undefined
    if (staff?.is_test) continue

    const submitSource =
      (t.staff_receipt_id ? receiptCreatedAt.get(t.staff_receipt_id) : undefined) ?? t.created_at
    const submitDate = toJstDate(submitSource)
    const cutoff = staffCutoffMonth(submitDate)
    if (!cutoff || cutoff.year !== year || cutoff.month !== month) continue

    // コピー対象は receipt_urls にファイルがあるものだけ（tax-folder-copy と同条件）
    const urls = Array.isArray(t.receipt_urls)
      ? (t.receipt_urls as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0)
      : []
    if (urls.length === 0) continue

    targets.push({
      transactionId: t.id,
      staffName: staff?.name ?? "不明なスタッフ",
      submitDate,
      expenseDetail: t.expense_detail?.trim() || "（区分未設定）",
      amount: typeof t.amount === "number" ? t.amount : 0,
      fileName: urls[0].split("/").pop() ?? "",
    })
  }

  // 5. 最終コピー実行日時（対象月を含む実行。提出リストの保存＝tax_snapshot は除く）
  let lastCopiedAt: string | null = null
  let lastCopiedBy: string | null = null
  const { data: runs } = await supabase
    .from("tax_folder_copy_runs")
    .select("run_at, run_by, run_type, period_start, period_end")
    .neq("run_type", "tax_snapshot")
    .lte("period_start", ym)
    .gte("period_end", ym)
    .order("run_at", { ascending: false })
    .limit(1)
  const lastRun = (runs ?? [])[0] as { run_at: string; run_by: string | null } | undefined
  if (lastRun) {
    lastCopiedAt = toJstDateTime(lastRun.run_at)
    lastCopiedBy = lastRun.run_by ?? null
  }

  // 6. 税理士提出フォルダ側のファイル名一覧（取得できない場合は誤警告を避けて空で返す）
  const staffFolder = `/経理書類/税理士提出/${year}年${monthStr}月/${STAFF_RECEIPT_SUBFOLDER}`
  let copiedNames: Set<string>
  try {
    const files = await listFilesRecursive(staffFolder)
    copiedNames = new Set(files.map((f) => f.name))
  } catch (e) {
    console.warn("[tax-uncopied] 税理士提出フォルダの一覧取得に失敗:", e)
    return {
      year,
      month,
      items: [],
      totalCount: targets.length,
      lastCopiedAt,
      lastCopiedBy,
      dropboxUnavailable: true,
    }
  }

  const items = targets
    .filter((t) => t.fileName && !copiedNames.has(t.fileName))
    .sort((a, b) => a.submitDate.localeCompare(b.submitDate) || a.staffName.localeCompare(b.staffName))

  return {
    year,
    month,
    items,
    totalCount: targets.length,
    lastCopiedAt,
    lastCopiedBy,
    dropboxUnavailable: false,
  }
}

/**
 * 「今の対象月」（提出日20日締め）を返す。
 * 例: 8/20までは8月分、8/21以降は9月分が受け付け中の対象月になる。
 */
export function currentSubmissionMonth(now: Date = new Date()): { year: number; month: number } {
  const jst = toJstDate(now.toISOString())
  return staffCutoffMonth(jst) ?? { year: now.getFullYear(), month: now.getMonth() + 1 }
}

/** 1つ前の対象月（＝直前の締め済み月）。締め当日の夜に申請された分の取りこぼしはここに出る */
export function previousSubmissionMonth(now: Date = new Date()): { year: number; month: number } {
  const { year, month } = currentSubmissionMonth(now)
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 }
}
