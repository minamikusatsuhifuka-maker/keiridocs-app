// 税理士提出書類一覧の「前回提出との差分」を出すためのスナップショット＋差分検出。
//
// 背景:
//   提出書類一覧（CSV/xlsx）は一括コピーのたびに再生成・上書きされるため、税理士側では
//   「前回提出後に何が増えたのか」「提出済みの資料が後から訂正されたのか」が分からない。
//   そこで、リストを生成してDropboxへ保存するたびに、その月の内容をスナップショットとして
//   残し、次回生成時に前回と突き合わせて 新規／修正／変更なし／削除 を判定する。
//
// 保存先（スキーマ変更なし）:
//   既存の実行履歴テーブル tax_folder_copy_runs に run_type='tax_snapshot' の行として保存する。
//   - period_start = period_end = "YYYY-MM"
//   - summary(jsonb) = TaxSnapshot 本体
//   実行履歴画面（/documents/tax-copy-history）には出さない（一覧APIで除外する）。
//
// 変更履歴:
//   各スナップショットは「そのとき検出した変更（changes）」を自分の中に持つ。
//   その月のスナップショットを時系列に並べて changes を連結すれば、
//   最新2回の比較だけでなく、その月に起きた変更がすべて追える。

import { createServiceClient } from "@/lib/staff-refund-core"
import type { Json } from "@/types/database"

/** レコードの状態 */
export type RowStatus = "new" | "modified" | "unchanged" | "removed"

/** 状態の日本語ラベル（CSV・xlsx共通） */
export const STATUS_LABELS: Record<RowStatus, string> = {
  new: "新規",
  modified: "修正",
  unchanged: "変更なし",
  removed: "削除",
}

/** 1項目の変更（変更前 → 変更後） */
export interface FieldChange {
  label: string
  before: string
  after: string
}

/** 変更履歴の1件 */
export interface ChangeEntry {
  /** 変更を検出した日時（＝そのスナップショットの生成日時・ISO） */
  changedAt: string
  /** 実行者（分かる範囲。cronは「自動実行（cron）」等） */
  changedBy: string
  fileName: string
  vendor: string
  status: RowStatus
  /** 修正の場合の項目別変更。新規・削除は空配列 */
  fields: FieldChange[]
}

/** スナップショットに保存する1レコード（リストに出す全項目） */
export interface SnapshotRow {
  /** 照合キー（NFC正規化ファイル名 + 同名内の連番。分割兄弟を区別する） */
  key: string
  fileName: string
  type: string
  vendor: string
  storeName: string
  expenseDetail: string
  amount: number | null
  subsidyLabel: string
  subsidyAmount: number | null
  date: string
  createdDate: string
  baseDate: string
  taxCategory: string
  accountTitle: string
  path: string
  needsReview: boolean
}

/** 月＋scope 単位のスナップショット */
export interface TaxSnapshot {
  version: 1
  kind: "tax_submission_snapshot"
  scope: "all" | "expense" | "sales"
  /** "YYYY-MM" */
  period: string
  /** 生成日時（ISO） */
  generatedAt: string
  /** 実行者 */
  runBy: string
  rows: SnapshotRow[]
  /** 集計対象（要確認・削除を除く）の金額合計 */
  totalAmount: number
  /** このスナップショット生成時に検出した変更 */
  changes: ChangeEntry[]
}

/** 差分判定の結果 */
export interface DiffResult {
  /** key → 状態 */
  statusByKey: Map<string, RowStatus>
  /** key → 項目別の変更（修正のときのみ） */
  changesByKey: Map<string, FieldChange[]>
  /** key → 最終更新日時（ISO）。過去の変更履歴からも引く */
  updatedAtByKey: Map<string, string>
  /** 前回あったが今回無いレコード（行として残して「削除」と明示する） */
  removedRows: SnapshotRow[]
  counts: { added: number; modified: number; unchanged: number; removed: number }
  /** 前回の合計金額（初回は null） */
  prevTotalAmount: number | null
  /** 前回の生成日時（初回は null） */
  prevGeneratedAt: string | null
  /** スナップショットが1件も無い＝機能導入後の初回。全件「変更なし」扱いにする */
  isFirst: boolean
  /** 今回検出した変更（スナップショットに保存する） */
  changes: ChangeEntry[]
}

/* ---------- 比較対象の項目定義 ---------- */

/** 比較する項目（表示ラベル → 値の取り出し）。コピー先パスは移動が雑音になるため比較しない */
const COMPARE_FIELDS: { label: string; get: (r: SnapshotRow) => string }[] = [
  { label: "種別", get: (r) => r.type },
  { label: "取引先", get: (r) => r.vendor },
  { label: "支払先", get: (r) => r.storeName },
  { label: "目的・用途", get: (r) => r.expenseDetail },
  { label: "金額", get: (r) => (r.amount === null ? "" : `¥${r.amount.toLocaleString()}`) },
  { label: "支給割合", get: (r) => r.subsidyLabel },
  {
    label: "支給額",
    get: (r) => (r.subsidyAmount === null ? "" : `¥${r.subsidyAmount.toLocaleString()}`),
  },
  { label: "発行日", get: (r) => r.date },
  { label: "基準日", get: (r) => r.baseDate },
  { label: "税区分", get: (r) => r.taxCategory },
  { label: "勘定科目", get: (r) => r.accountTitle },
  { label: "取り込み日", get: (r) => r.createdDate },
  { label: "要確認", get: (r) => (r.needsReview ? "要確認：DB未登録" : "") },
]

/**
 * 照合キーを作る。
 * 分割登録されたスタッフ領収書は1ファイルが複数行に展開されるため、
 * 同一ファイル名内の出現順を連番として付ける（並び順は split_index 順で安定している）。
 */
export function makeSnapshotKey(fileName: string, occurrence: number): string {
  return `${fileName.normalize("NFC")}#${occurrence}`
}

/**
 * 前回スナップショットと今回のレコードを突き合わせて差分を出す。
 *
 * @param currentRows 今回のレコード（key付き）
 * @param snapshots   同月・同scopeの過去スナップショット（run_at 昇順＝古い順）
 * @param now         今回の生成日時（ISO）
 * @param runBy       今回の実行者
 */
export function diffSnapshots(
  currentRows: SnapshotRow[],
  snapshots: TaxSnapshot[],
  now: string,
  runBy: string
): DiffResult {
  const statusByKey = new Map<string, RowStatus>()
  const changesByKey = new Map<string, FieldChange[]>()
  const updatedAtByKey = new Map<string, string>()
  const changes: ChangeEntry[] = []

  // 過去の変更履歴から「その資料が最後に変わった日時」を引けるようにする
  for (const snap of snapshots) {
    for (const c of snap.changes ?? []) {
      // 履歴は key を持たないため、ファイル名で引く（同名の分割兄弟は同じ更新日になる）
      updatedAtByKey.set(c.fileName.normalize("NFC"), c.changedAt)
    }
  }

  const previous = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null

  // 機能導入前に提出済みの月は前回スナップショットが無い。
  // ここで全件「新規」にすると税理士に誤った印象を与えるため、全件「変更なし」で記録する。
  if (!previous) {
    for (const r of currentRows) statusByKey.set(r.key, "unchanged")
    return {
      statusByKey,
      changesByKey,
      updatedAtByKey,
      removedRows: [],
      counts: { added: 0, modified: 0, unchanged: currentRows.length, removed: 0 },
      prevTotalAmount: null,
      prevGeneratedAt: null,
      isFirst: true,
      changes: [],
    }
  }

  const prevByKey = new Map<string, SnapshotRow>()
  for (const r of previous.rows ?? []) prevByKey.set(r.key, r)

  let added = 0
  let modified = 0
  let unchanged = 0

  for (const cur of currentRows) {
    const prev = prevByKey.get(cur.key)
    if (!prev) {
      statusByKey.set(cur.key, "new")
      updatedAtByKey.set(cur.fileName.normalize("NFC"), now)
      added++
      changes.push({
        changedAt: now,
        changedBy: runBy,
        fileName: cur.fileName,
        vendor: cur.vendor,
        status: "new",
        fields: [],
      })
      continue
    }
    const fields: FieldChange[] = []
    for (const f of COMPARE_FIELDS) {
      const before = f.get(prev)
      const after = f.get(cur)
      if (before !== after) fields.push({ label: f.label, before, after })
    }
    if (fields.length > 0) {
      statusByKey.set(cur.key, "modified")
      changesByKey.set(cur.key, fields)
      updatedAtByKey.set(cur.fileName.normalize("NFC"), now)
      modified++
      changes.push({
        changedAt: now,
        changedBy: runBy,
        fileName: cur.fileName,
        vendor: cur.vendor,
        status: "modified",
        fields,
      })
    } else {
      statusByKey.set(cur.key, "unchanged")
      unchanged++
    }
  }

  // 前回あったが今回無い＝削除（行としては残し、金額集計からは除外する）
  const currentKeys = new Set(currentRows.map((r) => r.key))
  const removedRows = (previous.rows ?? []).filter((r) => !currentKeys.has(r.key))
  for (const r of removedRows) {
    statusByKey.set(r.key, "removed")
    updatedAtByKey.set(r.fileName.normalize("NFC"), now)
    changes.push({
      changedAt: now,
      changedBy: runBy,
      fileName: r.fileName,
      vendor: r.vendor,
      status: "removed",
      fields: [],
    })
  }

  return {
    statusByKey,
    changesByKey,
    updatedAtByKey,
    removedRows,
    counts: { added, modified, unchanged, removed: removedRows.length },
    prevTotalAmount: previous.totalAmount ?? null,
    prevGeneratedAt: previous.generatedAt ?? null,
    isFirst: false,
    changes,
  }
}

/** 変更内容を「項目：変更前 → 変更後」の形にまとめる（CSV・xlsxの1セル用） */
export function formatFieldChanges(fields: FieldChange[]): string {
  return fields
    .map((f) => `${f.label}：${f.before || "（空）"} → ${f.after || "（空）"}`)
    .join(" / ")
}

/* ---------- 保存・読み出し（tax_folder_copy_runs を流用） ---------- */

/** スナップショット行を示す run_type（実行履歴一覧からは除外する） */
export const SNAPSHOT_RUN_TYPE = "tax_snapshot"

/** "YYYY-MM" 形式の期間文字列 */
export function periodOf(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`
}

/**
 * 指定月・指定scopeの過去スナップショットを古い順で取得する。
 *
 * 差分判定に必要なのは「最新1件の全レコード」と「全件の changes（変更履歴）」だけなので、
 * 過去分は changes のみを取り出す（全スナップショットの rows まで読むと、
 * 月内で何度も実行した月では取得量が一気に膨らむ）。
 * 返す配列の末尾＝最新スナップショットだけが rows を持つ。
 *
 * 取得に失敗した場合は空配列（差分機能のせいでリスト生成を止めない）。
 */
export async function loadSnapshots(
  period: string,
  scope: "all" | "expense" | "sales"
): Promise<TaxSnapshot[]> {
  try {
    const service = createServiceClient()

    // ① 変更履歴だけを軽量に取得（古い順）
    const { data: historyRows, error: historyError } = await service
      .from("tax_folder_copy_runs")
      .select("run_at, changes:summary->changes, generatedAt:summary->>generatedAt")
      .eq("run_type", SNAPSHOT_RUN_TYPE)
      .eq("period_start", period)
      .eq("summary->>scope", scope)
      .order("run_at", { ascending: true })
      .limit(100)
    // jsonbパス指定のselectが使えない環境では、全件をそのまま読む方式にフォールバックする
    if (historyError) return await loadSnapshotsFallback(period, scope)

    const out: TaxSnapshot[] = ((historyRows ?? []) as unknown as {
      changes: ChangeEntry[] | null
      generatedAt: string | null
    }[]).map((row) => ({
      version: 1,
      kind: "tax_submission_snapshot",
      scope,
      period,
      generatedAt: row.generatedAt ?? "",
      runBy: "",
      // 過去分の rows は差分判定に使わないため読み込まない（最新分だけ下で差し替える）
      rows: [],
      totalAmount: 0,
      changes: Array.isArray(row.changes) ? row.changes : [],
    }))

    if (out.length === 0) return []

    // ② 最新1件だけ全レコードを取得して末尾を差し替える（前回との突き合わせに使う）
    const { data: latestRows, error: latestError } = await service
      .from("tax_folder_copy_runs")
      .select("summary")
      .eq("run_type", SNAPSHOT_RUN_TYPE)
      .eq("period_start", period)
      .eq("summary->>scope", scope)
      .order("run_at", { ascending: false })
      .limit(1)
    if (latestError) return await loadSnapshotsFallback(period, scope)
    const latest = ((latestRows ?? [])[0] as { summary: unknown } | undefined)?.summary as
      | TaxSnapshot
      | undefined
    if (latest && latest.kind === "tax_submission_snapshot") {
      out[out.length - 1] = latest
    }

    return out
  } catch (err) {
    console.error("[tax-snapshot] スナップショット取得エラー:", err)
    return []
  }
}

/**
 * jsonbパス指定のselectが使えない場合のフォールバック（全件をそのまま読む）。
 * scope の絞り込みもJS側で行う。
 */
async function loadSnapshotsFallback(
  period: string,
  scope: "all" | "expense" | "sales"
): Promise<TaxSnapshot[]> {
  try {
    const service = createServiceClient()
    const { data, error } = await service
      .from("tax_folder_copy_runs")
      .select("summary")
      .eq("run_type", SNAPSHOT_RUN_TYPE)
      .eq("period_start", period)
      .order("run_at", { ascending: true })
      .limit(100)
    if (error) throw error
    const out: TaxSnapshot[] = []
    for (const row of (data ?? []) as { summary: unknown }[]) {
      const snap = row.summary as TaxSnapshot | null
      if (!snap || snap.kind !== "tax_submission_snapshot") continue
      if (snap.scope !== scope) continue
      out.push(snap)
    }
    // 直近1件以外は rows を捨てる（差分判定に使うのは最新分だけ）
    return out.map((snap, i) => (i === out.length - 1 ? snap : { ...snap, rows: [] }))
  } catch (err) {
    console.error("[tax-snapshot] スナップショット取得エラー（フォールバック）:", err)
    return []
  }
}

/**
 * スナップショットを1件保存する。
 * 失敗してもリスト生成自体は成功扱いにする（差分は次回から復帰する）。
 */
export async function saveSnapshot(snapshot: TaxSnapshot): Promise<boolean> {
  try {
    const service = createServiceClient()
    const { error } = await service.from("tax_folder_copy_runs").insert({
      run_by: snapshot.runBy,
      run_type: SNAPSHOT_RUN_TYPE,
      period_start: snapshot.period,
      period_end: snapshot.period,
      target_folders: [],
      // jsonb カラムに構造体をそのまま格納する
      summary: snapshot as unknown as Json,
      issues: null,
    })
    if (error) throw error
    return true
  } catch (err) {
    console.error("[tax-snapshot] スナップショット保存エラー:", err)
    return false
  }
}
