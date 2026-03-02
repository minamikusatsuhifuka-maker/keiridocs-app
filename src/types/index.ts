// アプリ固有の型定義

/** 書類種別 */
export type DocumentType = "請求書" | "領収書" | "契約書" | string

/** 書類ステータス */
export type DocumentStatus = "未処理" | "処理済み" | "アーカイブ"

/** 入力経路 */
export type InputMethod = "camera" | "upload" | "email"

/** メール承認ステータス */
export type MailPendingStatus = "pending" | "approved" | "rejected"

/** 税区分 */
export type TaxCategory = "課税10%" | "課税8%（軽減）" | "非課税" | "免税" | "不課税" | "未判定"

/** 勘定科目 */
export type AccountTitle = "仕入高" | "消耗品費" | "通信費" | "水道光熱費" | "地代家賃" | "リース料" | "支払手数料" | "広告宣伝費" | "修繕費" | "保険料" | "福利厚生費" | "雑費"

/** ユーザー権限 */
export type UserRole = "admin" | "staff" | "viewer"
