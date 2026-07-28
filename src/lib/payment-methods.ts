// 支払方法の最終判定ロジック（AI判定 × 支払先マスタ）を集約するユーティリティ。
// ページ（server component）とAPIの双方から使う。

/** 支払方法カテゴリ（画面表示・絞り込みで使う最終区分） */
export type PaymentCategory = "都度振込" | "口座振替" | "その他" | "要確認"

/** 支払先マスタ（vendor_payment_methods）に登録できる支払方法 */
export const MASTER_METHODS = ["都度振込", "口座振替", "その他"] as const
export type MasterMethod = (typeof MASTER_METHODS)[number]

/**
 * documents.payment_method（AIコード）を支払方法カテゴリに変換する。
 *   bank_transfer → 都度振込 / auto_debit → 口座振替 / credit_card → その他 / それ以外 → 要確認
 */
export function codeToCategory(paymentMethod: string | null | undefined): PaymentCategory {
  switch (paymentMethod) {
    case "bank_transfer":
      return "都度振込"
    case "auto_debit":
      return "口座振替"
    case "credit_card":
      return "その他"
    default:
      return "要確認"
  }
}

/**
 * 支払先マスタを優先しつつ、最終的な支払方法カテゴリを決定する。
 * マスタに登録があればそれを優先し、無ければAIコードから判定する。
 */
export function resolvePaymentCategory(
  paymentMethod: string | null | undefined,
  masterMethod: string | null | undefined
): PaymentCategory {
  if (masterMethod && (MASTER_METHODS as readonly string[]).includes(masterMethod)) {
    return masterMethod as MasterMethod
  }
  return codeToCategory(paymentMethod)
}

/**
 * 要振込リスト（＝人が都度手動で振り込む必要があるもの）に載せるカテゴリか。
 * 「要確認（未確定）」は含めない。未確定のものは専用セクションで仕分けする。
 */
export function requiresTransfer(category: PaymentCategory): boolean {
  return category === "都度振込"
}

/** 支払方法が未確定（AI判定も支払先マスタも付いていない）か */
export function isUnconfirmed(category: PaymentCategory): boolean {
  return category === "要確認"
}
