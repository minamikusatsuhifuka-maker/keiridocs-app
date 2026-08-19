// スタッフ領収書の「1ファイルに複数の領収証」分割登録の共通ロジック。
// 管理画面の取込（staff-refund/analyze・approve）と LINE webhook の両方から使う。
//
// グループ化の方針（書類側の documents.split_group と同じ考え方）:
//  - 分割した各レコードは同一ファイル（同一 dropbox_path）を共有する（コピーしない）
//  - グループIDは staff_receipts.ai_raw 内の split_group / split_index / split_total に保存する
//    （スキーマ変更なし。ALTER直後のPostgRESTスキーマキャッシュ遅延による部分失敗事故を避けるため、
//     専用カラムは追加せず jsonb の ai_raw に記録する）
//  - 兄弟判定は「同一スタッフ かつ 同一 dropbox_path かつ 同一 split_group」

import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"
import type { OcrResult } from "@/lib/gemini"

/** 分割登録候補の1件分（AI解析の payments から導出した表示・登録用データ） */
export interface ReceiptCandidate {
  /** 店名（払込先）。空の場合は書類全体の vendor_name を継承済み */
  store: string
  /** 立替額（>0 が保証される） */
  amount: number
  /** その領収証自身の領収日・決済日（YYYY-MM-DD）。読み取れない場合は "" */
  date: string
  /** 但し書き・内容 */
  note: string
}

/**
 * ai_raw（jsonb）を寛容にオブジェクト化する。
 * 実データには二重エンコードされたJSON文字列スカラーが存在するため（staff-reimburse.ts と同じ罠）、
 * オブジェクト・JSON文字列の両方を受ける。それ以外は null。
 */
export function parseAiRawObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // JSONでない文字列は情報なし扱い
    }
  }
  return null
}

/**
 * AI解析結果（payments）から複数領収証の分割候補を導出する。
 * - payments が2件以上、かつ全件の金額が正の数のときのみ候補を返す
 * - 1件でも金額不明があれば空配列（安全側＝分割しない。誤分割で金額が消える事故を防ぐ）
 */
export function deriveReceiptCandidates(ocr: OcrResult): ReceiptCandidate[] {
  if (!Array.isArray(ocr.payments) || ocr.payments.length < 2) return []
  const out: ReceiptCandidate[] = []
  for (const p of ocr.payments) {
    if (typeof p.amount !== "number" || !Number.isFinite(p.amount) || p.amount <= 0) return []
    out.push({
      store: (p.vendor_name || ocr.vendor_name || "").trim(),
      amount: Math.round(p.amount),
      // 日付はその領収証自身の領収日を最優先。無ければ書類全体の日付（呼び出し側で今日に補完）
      date: (p.issue_date || ocr.issue_date || "").slice(0, 10),
      note: p.description?.trim() || "",
    })
  }
  return out
}

/** ai_raw に記録する分割グループ情報 */
export interface SplitGroupInfo {
  group: string
  index: number
  total: number
}

/** ai_raw から分割グループ情報を取り出す（無ければ null＝通常の単独レコード） */
export function getSplitGroupInfo(aiRaw: unknown): SplitGroupInfo | null {
  const obj = parseAiRawObject(aiRaw)
  if (!obj) return null
  const group = obj.split_group
  if (typeof group !== "string" || group === "") return null
  const index = typeof obj.split_index === "number" ? obj.split_index : 0
  const total = typeof obj.split_total === "number" ? obj.split_total : 0
  return { group, index, total }
}

/** 分割兄弟レコード（確認画面・一括精算で使う最小情報） */
export interface SiblingReceipt {
  id: string
  amount: number | null
  store_name: string | null
  date: string | null
  created_at: string
  splitIndex: number
}

/**
 * 指定レコードの分割兄弟（自分を含む）を取得する。
 * 分割レコードでなければ自分1件だけの配列を返す。
 * 兄弟 = 同一スタッフ・同一 dropbox_path・同一 split_group。split_index 順に並べる。
 */
export async function fetchSplitSiblings(
  client: SupabaseClient<Database>,
  receipt: {
    id: string
    staff_member_id: string
    dropbox_path: string | null
    amount: number | null
    store_name: string | null
    date: string | null
    created_at: string
    ai_raw: unknown
  }
): Promise<SiblingReceipt[]> {
  const self: SiblingReceipt = {
    id: receipt.id,
    amount: receipt.amount,
    store_name: receipt.store_name,
    date: receipt.date,
    created_at: receipt.created_at,
    splitIndex: getSplitGroupInfo(receipt.ai_raw)?.index ?? 0,
  }
  const info = getSplitGroupInfo(receipt.ai_raw)
  if (!info || !receipt.dropbox_path) return [self]

  const { data, error } = await client
    .from("staff_receipts")
    .select("id, amount, store_name, date, created_at, ai_raw")
    .eq("staff_member_id", receipt.staff_member_id)
    .eq("dropbox_path", receipt.dropbox_path)
  if (error || !data) {
    console.warn("[staff-receipt-split] 兄弟レコード取得に失敗（単独として扱う）:", error?.message)
    return [self]
  }

  const siblings: SiblingReceipt[] = []
  for (const r of data as Array<{
    id: string
    amount: number | null
    store_name: string | null
    date: string | null
    created_at: string
    ai_raw: unknown
  }>) {
    const rInfo = getSplitGroupInfo(r.ai_raw)
    if (rInfo?.group !== info.group) continue
    siblings.push({
      id: r.id,
      amount: r.amount,
      store_name: r.store_name,
      date: r.date,
      created_at: r.created_at,
      splitIndex: rInfo.index,
    })
  }
  if (siblings.length === 0) return [self]
  siblings.sort((a, b) => a.splitIndex - b.splitIndex)
  return siblings
}
