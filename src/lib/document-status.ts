// 書類ステータスの自動判定ロジックを集約するユーティリティ。
// 「人の対応が必要なのは手動振込が必要な請求書だけ」という運用方針に基づき、
// 取り込み時に 要振込 / 処理済み を自動決定する。
//
// 要振込 = 種別が請求書 かつ 支払方法カテゴリが振込を要する（都度振込・要確認） かつ 未払い。
// それ以外（口座振替・その他・請求書以外・支払い済み）は自動で処理済み。
// ※ 支払方法の最終判定（AI判定×支払先マスタ）は payment-methods.ts の既存ロジックを流用する。

import { resolvePaymentCategory, requiresTransfer } from "@/lib/payment-methods"

/** 要振込ステータス値（documents.status） */
export const STATUS_TRANSFER_REQUIRED = "要振込"
/** 処理済みステータス値（documents.status） */
export const STATUS_DONE = "処理済み"

interface AutoStatusInput {
  /** 書類種別（請求書のみ要振込の対象） */
  type: string | null | undefined
  /** documents.payment_method（AI判定コード: bank_transfer / auto_debit / credit_card / unknown） */
  paymentMethod: string | null | undefined
  /** 支払先マスタ（vendor_payment_methods.method）。無ければ null */
  masterMethod: string | null | undefined
  /** documents.payment_status（「支払い済み」なら要振込にしない）。未指定は未払い扱い */
  paymentStatus?: string | null
}

/**
 * 取り込み時・支払い状態変更時の自動ステータスを判定する。
 * 要振込 or 処理済み のどちらかを返す（アーカイブ等の手動ステータスはここでは扱わない）。
 */
export function resolveAutoDocumentStatus(input: AutoStatusInput): "要振込" | "処理済み" {
  if (input.type !== "請求書") return STATUS_DONE
  if (input.paymentStatus === "支払い済み") return STATUS_DONE
  const category = resolvePaymentCategory(input.paymentMethod, input.masterMethod)
  return requiresTransfer(category) ? STATUS_TRANSFER_REQUIRED : STATUS_DONE
}

/** supabase クライアントの最小インターフェース（server / service 両クライアント対応） */
interface MinimalSupabase {
  from(table: "vendor_payment_methods"): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): Promise<{ data: { method?: string | null } | null }>
      }
    }
  }
}

/**
 * 支払先マスタ（vendor_payment_methods）から該当取引先の支払方法を取得する。
 * 見つからない・エラー時は null（＝AI判定にフォールバック）。
 * 引数は server / service どちらのクライアントも受けられるよう unknown で受けて内部で絞る
 * （実クライアントの深いジェネリクスに対する構造チェックを避けるため）。
 */
export async function fetchVendorMasterMethod(
  supabase: unknown,
  vendorName: string | null | undefined
): Promise<string | null> {
  if (!vendorName) return null
  try {
    const client = supabase as MinimalSupabase
    const { data } = await client
      .from("vendor_payment_methods")
      .select("method")
      .eq("vendor_name", vendorName)
      .maybeSingle()
    return typeof data?.method === "string" ? data.method : null
  } catch (err) {
    console.error("支払先マスタ取得エラー:", err)
    return null
  }
}
