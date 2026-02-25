// アプリ固有の型定義

/** 書類種別 */
export type DocumentType = "請求書" | "領収書" | "契約書" | string

/** 書類ステータス */
export type DocumentStatus = "未処理" | "処理済み" | "アーカイブ"

/** 入力経路 */
export type InputMethod = "camera" | "upload" | "email"

/** メール承認ステータス */
export type MailPendingStatus = "pending" | "approved" | "rejected"
