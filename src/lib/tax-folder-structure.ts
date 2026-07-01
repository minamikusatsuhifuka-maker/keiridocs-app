// 税理士提出フォルダの月内サブフォルダ構造を集約するユーティリティ。
// 「税理士フォルダへ一括コピー」と「追加分の一括取り込み」の双方から使い、
// 本体・追加分とも同じ構造に振り分ける。

/** 月フォルダ直下に作る標準サブフォルダ（この順で作成・表示） */
export const STANDARD_SUBFOLDERS = [
  "請求書",
  "領収書",
  "契約書",
  "社会保険料",
  "その他",
  "売上記録データ",
  "月計表",
  "返金",
  "自動精算機データ",
  "スタッフ領収書",
] as const

/** 売上記録データのサブフォルダ名（旧: 売上） */
export const SALES_SUBFOLDER = "売上記録データ"
/** 旧・売上サブフォルダ名（後方互換の判定に使用） */
export const LEGACY_SALES_SUBFOLDER = "売上"
/** スタッフ領収書のサブフォルダ名 */
export const STAFF_RECEIPT_SUBFOLDER = "スタッフ領収書"

/**
 * ソースフォルダ名（/経理書類/{folder}/）→ 税理士提出の月内サブフォルダ名。
 * 物理配置（ソースフォルダ）で振り分けるため、種別のゆらぎに影響されない。
 */
export function taxSubfolderForSourceFolder(folder: string): string {
  switch (folder) {
    case "請求書":
      return "請求書"
    case "領収書":
      return "領収書"
    case "契約書":
      return "契約書"
    case "社会保険料":
      return "社会保険料"
    case "売上":
      return SALES_SUBFOLDER
    default:
      return "その他"
  }
}

/**
 * 書類種別（documents.type）→ 税理士提出の月内サブフォルダ名。
 * ソースフォルダが判別できない場合のフォールバックに使う。
 */
export function taxSubfolderForType(type: string | null | undefined): string {
  switch ((type ?? "").trim()) {
    case "請求書":
      return "請求書"
    case "領収書":
      return "領収書"
    case "契約書":
      return "契約書"
    case "社会保険料":
      return "社会保険料"
    case "売上記録":
      return SALES_SUBFOLDER
    case "返金":
      return "返金"
    case "月計表":
      return "月計表"
    default:
      return "その他"
  }
}

/** ISO日時/日付文字列（YYYY-MM-DD...）から提出日 YYYY-MM-DD を取り出す */
export function submitDateStr(iso: string | null | undefined): string {
  if (typeof iso !== "string") return ""
  return iso.slice(0, 10)
}

/**
 * スタッフ領収書の対象月を「提出日の20日締め」で判定する（提出日ベース。支払年月日ではない）。
 *   提出日の日 ≤ 20 → その月 / 21日以降 → 翌月（12月は翌年1月）。
 * 例: 6/20→6月, 6/25→7月, 7/5→7月, 12/25→翌年1月。
 * @param submitDate 提出日（YYYY-MM-DD または ISO）
 */
export function staffCutoffMonth(
  submitDate: string | null | undefined
): { year: number; month: number } | null {
  if (typeof submitDate !== "string") return null
  const m = submitDate.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null
  }
  if (day <= 20) return { year, month }
  // 21日以降は翌月（年跨ぎ考慮）
  if (month === 12) return { year: year + 1, month: 1 }
  return { year, month: month + 1 }
}

/** スタッフ領収書フォルダ名「スタッフ名_提出日」（例: 楠葉_2026-06-25） */
export function staffReceiptFolderName(staffName: string, submitDate: string): string {
  return `${staffName}_${submitDate}`
}

/** 月フォルダ直下の標準サブフォルダをすべて作成する（構造を明示） */
export async function ensureMonthStructure(
  monthBase: string,
  ensure: (path: string) => Promise<void>
): Promise<void> {
  for (const sub of STANDARD_SUBFOLDERS) {
    try {
      await ensure(`${monthBase}/${sub}`)
    } catch (err) {
      console.error(`税理士提出サブフォルダ作成エラー (${monthBase}/${sub}):`, err)
    }
  }
}
