// 補助情報（登録番号・電話番号・住所）から取引先を特定する
//
// 社名が印影で隠れている・ロゴ画像でしか印字されていない書類では、
// AIが社名を読み取れず「それらしい社名」を創作してしまうことがある。
// 書類には社名以外にも発行元を一意に示す情報があるため、
// 過去に登録済みの書類（ocr_raw に同じ補助情報を持つもの）と突き合わせて取引先名を確定する。
import type { VendorIdentifiers, VendorResolvedBy } from "@/lib/gemini-shared"

/** 特定結果 */
export interface ResolvedVendor {
  vendor_name: string
  resolved_by: VendorResolvedBy
}

/** documents テーブルを引くのに必要な最小限のクライアント形状 */
interface MinimalQuery {
  eq: (column: string, value: unknown) => MinimalQuery
  ilike: (column: string, pattern: string) => MinimalQuery
  not: (column: string, operator: string, value: unknown) => MinimalQuery
  limit: (n: number) => Promise<{ data: { vendor_name: string | null }[] | null }>
}
interface MinimalSupabase {
  from: (table: string) => { select: (columns: string) => MinimalQuery }
}

/** 登録番号を正規化する（全角・空白・ハイフンを除去して大文字に） */
export function normalizeRegistrationNumber(raw: string): string {
  const v = raw.normalize("NFKC").replace(/[\s　\-‐－—]/g, "").toUpperCase()
  // 適格請求書発行事業者の登録番号は T + 13桁
  return /^T\d{13}$/.test(v) ? v : ""
}

/** 電話番号を正規化する（数字だけにする） */
export function normalizePhone(raw: string): string {
  const digits = raw.normalize("NFKC").replace(/\D/g, "")
  // 市外局番込みで10〜11桁のものだけを識別子として扱う
  return digits.length >= 10 && digits.length <= 11 ? digits : ""
}

/**
 * 住所から照合に使える特徴部分（丁目・番地）を取り出す。
 * 「東京都江東区有明3-7-18 有明セントラルタワー19階」→「3-7-18」
 * 番地が取れない住所は照合に使わない（都道府県名だけでは別会社と衝突するため）。
 */
export function addressKey(raw: string): string {
  const v = raw.normalize("NFKC").replace(/[\s　]/g, "")
  const m = v.match(/\d+[-－‐]\d+[-－‐]\d+|\d+丁目\d+[-－‐]?\d*/)
  return m ? m[0].replace(/[－‐]/g, "-") : ""
}

/** 取引先名の多数決（同じ識別子で複数の表記があった場合、最頻の表記を採る） */
function mostCommonName(rows: { vendor_name: string | null }[]): string {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const name = (r.vendor_name ?? "").trim()
    if (!name) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  let best = ""
  let bestCount = 0
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name
      bestCount = count
    }
  }
  return best
}

/**
 * 補助情報から過去の取引先名を引く関数を作る。
 * analyzeDocument の resolveVendorByIdentifiers オプションに渡して使う。
 *
 * 照合の優先順位は 登録番号 → 電話番号 → 住所（番地）。
 * 登録番号は事業者ごとに一意なので最も信頼できる。
 */
export function createVendorResolver(
  supabase: unknown,
  userId: string
): (identifiers: VendorIdentifiers) => Promise<ResolvedVendor | null> {
  const client = supabase as MinimalSupabase

  /** ocr_raw の指定キーが値と一致する過去の書類から取引先名を引く */
  async function lookup(
    jsonKey: string,
    matcher: (q: MinimalQuery) => MinimalQuery
  ): Promise<string> {
    try {
      const query = client.from("documents").select("vendor_name").eq("user_id", userId)
      const { data } = await matcher(query)
        .not("vendor_name", "is", null)
        .limit(50)
      return Array.isArray(data) ? mostCommonName(data) : ""
    } catch (err) {
      console.error(`取引先の照合に失敗（${jsonKey}）:`, err)
      return ""
    }
  }

  return async (identifiers: VendorIdentifiers) => {
    const regNo = normalizeRegistrationNumber(identifiers.vendor_registration_number ?? "")
    if (regNo) {
      const name = await lookup("vendor_registration_number", (q) =>
        q.eq("ocr_raw->>vendor_registration_number", regNo)
      )
      if (name) return { vendor_name: name, resolved_by: "registration_number" }
    }

    const phone = normalizePhone(identifiers.vendor_phone ?? "")
    if (phone) {
      // 保存時の表記ゆれ（ハイフン有無）に備え、数字並びを部分一致で探す
      const pattern = `%${phone.slice(0, 6)}%${phone.slice(6)}%`
      const name = await lookup("vendor_phone", (q) =>
        q.ilike("ocr_raw->>vendor_phone", pattern)
      )
      if (name) return { vendor_name: name, resolved_by: "phone" }
    }

    const addr = addressKey(identifiers.vendor_address ?? "")
    if (addr) {
      const name = await lookup("vendor_address", (q) =>
        q.ilike("ocr_raw->>vendor_address", `%${addr}%`)
      )
      if (name) return { vendor_name: name, resolved_by: "address" }
    }

    return null
  }
}
