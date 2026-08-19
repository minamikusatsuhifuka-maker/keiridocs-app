import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"

/**
 * スタッフ立替領収書の重複判定（共通ロジック）。
 *
 * LINE登録時のハードブロックと、管理画面（/staff-receipts/admin）の重複バッジで
 * 同じ基準を使うために共通化する。判定基準は次のいずれか:
 *  - 画像の重複: 画像バイト列の SHA-256 ハッシュ一致（全スタッフ照合）
 *  - 内容の重複: 店名（正規化）＋金額＋日付 一致（同一スタッフ内）
 *
 * ※ このファイルはクライアント（管理画面）からも import するため、Node専用の
 *   crypto には依存しない（ハッシュ計算は呼び出し側＝サーバで行う）。
 */

/** 店名の正規化: NFKC → trim → 連続空白を1つに圧縮 → 小文字化 */
export function normalizeStoreName(name: string | null | undefined): string {
  if (!name) return ""
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()
}

/** 日付を YYYY-MM-DD に正規化（先頭10文字） */
export function normalizeDate(date: string | null | undefined): string {
  return (date || "").slice(0, 10)
}

/** 内容一致キー（店名+金額+日付）。同一スタッフ内で比較する前提 */
export function contentKey(
  store: string | null | undefined,
  amount: number | null | undefined,
  date: string | null | undefined
): string {
  const s = normalizeStoreName(store)
  const a = typeof amount === "number" ? String(Math.round(amount)) : ""
  const d = normalizeDate(date)
  return `${s}|${a}|${d}`
}

/** 内容一致を重複判定に使えるか（店名・金額・日付がすべて揃っているときのみ） */
export function isContentKeyComplete(
  store: string | null | undefined,
  amount: number | null | undefined,
  date: string | null | undefined
): boolean {
  return (
    normalizeStoreName(store) !== "" &&
    typeof amount === "number" &&
    amount > 0 &&
    normalizeDate(date) !== ""
  )
}

/* ---------- 管理画面用: リスト内の重複検出 ---------- */

export interface DedupReceiptLike {
  id: string
  staff_member_id: string
  store_name: string | null
  amount: number | null
  date: string | null
  image_hash?: string | null
  /** 分割兄弟判定用（同一ファイルを共有する分割レコードを重複扱いしないため） */
  dropbox_path?: string | null
}

/**
 * グループ全員が同一ファイル（同一 dropbox_path）を共有しているか。
 * 1ファイル複数領収証の分割登録では兄弟レコードが同じ画像ハッシュ・同じファイルを持つため、
 * 同一パスのグループは「1つの論理ファイルの分割」とみなして重複扱いしない。
 */
function isSameFileGroup(rows: DedupReceiptLike[]): boolean {
  const first = (rows[0]?.dropbox_path || "").trim()
  if (!first) return false
  return rows.every((r) => (r.dropbox_path || "").trim() === first)
}

/**
 * リスト内で重複している領収書のIDセットを返す。
 *  - 画像ハッシュ一致: 全体照合（別スタッフでも怪しいため）
 *  - 内容一致（店名+金額+日付）: 同一スタッフ内のみ
 *  - ただし同一 dropbox_path を共有するグループ（分割兄弟）は重複扱いしない
 */
export function findDuplicateIds(receipts: DedupReceiptLike[]): Set<string> {
  const dup = new Set<string>()

  // 1) 画像ハッシュ（全体照合）
  const byHash = new Map<string, DedupReceiptLike[]>()
  for (const r of receipts) {
    const h = (r.image_hash || "").trim()
    if (!h) continue
    const arr = byHash.get(h) ?? []
    arr.push(r)
    byHash.set(h, arr)
  }
  for (const rows of byHash.values()) {
    if (rows.length > 1 && !isSameFileGroup(rows)) rows.forEach((r) => dup.add(r.id))
  }

  // 2) 内容一致（同一スタッフ内）
  const byContent = new Map<string, DedupReceiptLike[]>()
  for (const r of receipts) {
    if (!isContentKeyComplete(r.store_name, r.amount, r.date)) continue
    const key = `${r.staff_member_id}|${contentKey(r.store_name, r.amount, r.date)}`
    const arr = byContent.get(key) ?? []
    arr.push(r)
    byContent.set(key, arr)
  }
  for (const rows of byContent.values()) {
    if (rows.length > 1 && !isSameFileGroup(rows)) rows.forEach((r) => dup.add(r.id))
  }

  return dup
}

/* ---------- LINE登録用: 既存DBとの照合 ---------- */

/** 既存の重複領収書（警告メッセージ表示に使う最小情報） */
export interface ExistingDuplicate {
  id: string
  store_name: string | null
  amount: number | null
  date: string | null
  created_at: string
  /** 一致種別（image=画像ハッシュ / content=店名+金額+日付） */
  matchType: "image" | "content"
}

type ExistingRow = {
  id: string
  store_name: string | null
  amount: number | null
  date: string | null
  created_at: string
}

/**
 * 画像ハッシュで既存領収書を全体照合する（解析前に判定可能）。
 * image_hash カラムが未適用（migration 030未実行）の環境ではエラーを握りつぶし null を返す。
 */
export async function findImageHashDuplicate(
  supabase: SupabaseClient<Database>,
  imageHash: string | null
): Promise<ExistingDuplicate | null> {
  if (!imageHash) return null
  const { data, error } = await supabase
    .from("staff_receipts")
    // image_hash は型に存在するが、未適用環境では実行時エラーになるため下でハンドリング
    .select("id, store_name, amount, date, created_at")
    .eq("image_hash", imageHash)
    .order("created_at", { ascending: true })
    .limit(1)

  if (error) {
    // 列未適用（42703 / PGRST204）等は重複なし扱いで継続（精算フローを止めない）
    console.warn("[dedup] image_hash 照合をスキップ:", error.message)
    return null
  }
  const rows = (data ?? []) as ExistingRow[]
  if (rows.length === 0) return null
  return { ...rows[0], matchType: "image" }
}

/**
 * 内容（店名+金額+日付）で同一スタッフの既存領収書を照合する（解析後に判定）。
 * 店名は正規化して比較するため、金額・日付でDB側を絞り込んだ後にクライアント側で店名一致を確認する。
 */
export async function findContentDuplicate(
  supabase: SupabaseClient<Database>,
  params: {
    staffMemberId: string
    storeName: string | null
    amount: number | null
    date: string | null
  }
): Promise<ExistingDuplicate | null> {
  const { staffMemberId, storeName, amount, date } = params
  if (!isContentKeyComplete(storeName, amount, date) || amount == null) return null

  const { data, error } = await supabase
    .from("staff_receipts")
    .select("id, store_name, amount, date, created_at")
    .eq("staff_member_id", staffMemberId)
    .eq("amount", amount)
    .eq("date", normalizeDate(date))
    .order("created_at", { ascending: true })

  if (error) {
    console.warn("[dedup] 内容照合をスキップ:", error.message)
    return null
  }
  const rows = (data ?? []) as ExistingRow[]
  const target = normalizeStoreName(storeName)
  const match = rows.find((r) => normalizeStoreName(r.store_name) === target)
  return match ? { ...match, matchType: "content" } : null
}
