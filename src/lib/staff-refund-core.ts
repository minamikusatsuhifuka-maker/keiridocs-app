import { createClient } from "@supabase/supabase-js"
import type { Database, Json } from "@/types/database"
import { normalizeSubsidyCategory, type SubsidyCategory } from "@/lib/subsidy"

/**
 * スタッフ立替領収書（staff_receipts）の精算確定を行う共通ロジック。
 *
 * Webセッション認証ルートと LINE webhook の両方から呼べるよう、
 * サービスロールキー（RLSバイパス）で動作する。
 * - LINEはWebセッションを持たないため、この共通関数を経由して精算する。
 * - 既存の認証必須ルート（from-receipt / staff-refund/manual）は温存しており、
 *   挙動差分リスクを避けるため本関数へのリファクタは行っていない。
 */

type ServiceClient = ReturnType<typeof createClient<Database>>

/** 精算方法。petty_cash=小口現金から返金 / payroll=給与で返金 / storage_only=保管のみ */
export type SettlementMethod = "petty_cash" | "payroll" | "storage_only"

/** 精算方法の日本語ラベル（LINE返信・UI共通で利用） */
export const SETTLEMENT_LABELS: Record<SettlementMethod, string> = {
  petty_cash: "小口現金から返金",
  payroll: "給与で返金",
  storage_only: "保管のみ",
}

/** 精算確定の結果ステータス */
export type SettleStatus = "ok" | "already" | "no_amount" | "not_found"

export interface SettleResult {
  status: SettleStatus
  settlementMethod?: SettlementMethod
  staffName?: string
  storeName?: string | null
  amount?: number | null
  /** 確定後の小口残高（petty_cash以外は変動しないため現残高） */
  balance?: number
}

/** サービスロールキーでRLSをバイパスするSupabaseクライアント */
export function createServiceClient(): ServiceClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createClient<Database>(url, serviceKey)
}

/**
 * staff_receipts のレコードを精算方法に応じて petty_cash_transactions に確定登録する。
 *
 * - 二重押し対策: 同じ staff_receipt_id が既に登録済みなら status='already' を返す
 * - petty_cash のときのみ小口残高を減算（payroll / storage_only は残高を動かさない）
 * - payroll のときは payroll_refund_status='pending'（給与返金待ち）を付与
 *
 * @param params.staffReceiptId   精算対象の staff_receipts.id
 * @param params.settlementMethod 精算方法
 * @param params.registeredBy     登録者名（未指定時は「{スタッフ名}（LINE）」）
 * @param params.client           （任意）既存のサービスクライアントを使い回す場合に指定
 */
export async function settleStaffReceipt(params: {
  staffReceiptId: string
  settlementMethod: SettlementMethod
  /** アチーブメント参加区分（未指定は 'other' = 全額扱い） */
  subsidyCategory?: SubsidyCategory | string | null
  /** スタッフ立替の詳細区分フル名称（expense_detail カラムに保存。任意） */
  expenseDetail?: string | null
  registeredBy?: string
  client?: ServiceClient
}): Promise<SettleResult> {
  const supabase = params.client ?? createServiceClient()
  const { staffReceiptId, settlementMethod } = params
  // 区分（未指定・不正値は 'other' = 全額）。支給額は資料出力時に計算するため、ここでは区分のみ保存
  const subsidyCategory = normalizeSubsidyCategory(params.subsidyCategory)

  // 1. 既に小口（精算）登録済みか確認（二重押し対策）
  const { data: existing } = await supabase
    .from("petty_cash_transactions")
    .select("id")
    .eq("staff_receipt_id", staffReceiptId)
    .limit(1)

  if (existing && existing.length > 0) {
    return { status: "already" }
  }

  // 2. 領収書情報を取得（staff_membersとJOINでスタッフ名を取得）
  const { data: receipt, error: receiptError } = await supabase
    .from("staff_receipts")
    .select("*, staff_members!inner(name)")
    .eq("id", staffReceiptId)
    .single()

  if (receiptError || !receipt) {
    return { status: "not_found" }
  }

  const r = receipt as Record<string, unknown> & { staff_members: { name: string } }
  const staffName = r.staff_members.name
  const storeName = (r.store_name as string | null) ?? null
  const amount = r.amount as number | null

  if (!amount || amount <= 0) {
    return { status: "no_amount", staffName, storeName, amount }
  }

  // 3. 現在の残高取得
  const { data: settingsRaw, error: settingsError } = await supabase
    .from("petty_cash_settings")
    .select("*")
    .limit(1)
    .single()

  if (settingsError) throw settingsError
  const settings = settingsRaw as unknown as { id: string; balance: number }
  const currentBalance = settings.balance ?? 0

  // 小口返金のみ残高を減算。給与返金・保管のみは残高を動かさない
  const deductsBalance = settlementMethod === "petty_cash"
  const newBalance = deductsBalance ? currentBalance - amount : currentBalance

  const registeredBy = params.registeredBy ?? `${staffName}（LINE）`
  const dropboxPath = (r.dropbox_path as string | null) ?? null
  const txDate = (r.date as string | null) || new Date().toISOString().slice(0, 10)
  const description = `${staffName}/${storeName || "不明"}`

  // 4. 取引登録
  // 共通のinsertペイロード（expense_detailは下で条件付きに付与する）
  const basePayload = {
    type: "出金",
    amount,
    description,
    staff_member_id: r.staff_member_id as string,
    staff_receipt_id: staffReceiptId,
    dropbox_path: dropboxPath,
    // 給与返金待ちパネル等でレシートを参照できるようDropboxパスを格納
    receipt_urls: (dropboxPath ? [dropboxPath] : null) as Json,
    registered_by: registeredBy,
    category: "staff_refund",
    note: description,
    created_by: registeredBy,
    transaction_date: txDate,
    balance_after: newBalance,
    settlement_method: settlementMethod,
    // 給与返金のみ返金待ちステータスを付与
    payroll_refund_status: settlementMethod === "payroll" ? "pending" : null,
    // アチーブメント参加区分（支給率の判定に使用）
    subsidy_category: subsidyCategory,
  }

  const expenseDetail = params.expenseDetail?.trim() || null
  // expense_detail カラムは migration 029 で追加される。未適用の環境でも精算を
  // 止めないよう、列が存在しない（PostgRESTスキーマ未認識）エラー時は列なしで再登録する。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const insertPayload: any = expenseDetail
    ? { ...basePayload, expense_detail: expenseDetail }
    : basePayload
  const { error: insertError } = await supabase
    .from("petty_cash_transactions")
    .insert(insertPayload)

  if (insertError) {
    const isMissingColumn =
      insertError.code === "PGRST204" ||
      insertError.code === "42703" ||
      /expense_detail/.test(insertError.message || "")
    if (expenseDetail && isMissingColumn) {
      console.warn(
        "[staff-refund] expense_detail カラム未適用のため詳細区分なしで登録します（migration 029未実行）"
      )
      const { error: retryError } = await supabase
        .from("petty_cash_transactions")
        .insert(basePayload)
      if (retryError) throw retryError
    } else {
      throw insertError
    }
  }

  // 5. 残高更新（小口返金のときだけ）
  if (deductsBalance) {
    const { error: updateError } = await supabase
      .from("petty_cash_settings")
      .update({ balance: newBalance, updated_at: new Date().toISOString() })
      .eq("id", settings.id)
    if (updateError) throw updateError
  }

  return {
    status: "ok",
    settlementMethod,
    staffName,
    storeName,
    amount,
    balance: newBalance,
  }
}
