import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { PaymentsClient, type PaymentDoc, type VendorMaster } from "./payments-client"
import type { BankInfo } from "@/lib/gemini"
import { resolvePaymentCategory, requiresTransfer } from "@/lib/payment-methods"

// 支払管理ページ
// 要振込リスト = 支払方法カテゴリが「都度振込」「要確認」のもののみ（口座振替は除外）。
// 口座振替の請求書は別セクション/タブで確認できる（記録は消さない）。
// 支払方法は AI判定（documents.payment_method）に支払先マスタ（vendor_payment_methods）を重ねて最終判定する（マスタ優先）。
export default async function PaymentsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return (
      <div>
        <h1 className="text-2xl font-bold" style={{ color: "#1A1A1A" }}>
          支払管理
        </h1>
        <p className="mt-2 text-sm" style={{ color: "#4A4A4A" }}>
          ログインしてください
        </p>
      </div>
    )
  }

  const role = await getCurrentUserRole()
  const isAdminUser = role?.role === "admin"

  // 請求書を全件取得（口座振替も含めて取得し、最終判定でセクション分けする）
  let query = supabase
    .from("documents")
    .select("id, vendor_name, amount, due_date, type, payment_method, bank_info, payment_status, status")
    .eq("type", "請求書")
    .neq("status", "アーカイブ")
    .order("due_date", { ascending: true, nullsFirst: false })

  if (!isAdminUser) {
    query = query.eq("user_id", user.id)
  }

  const { data, error } = await query
  if (error) {
    console.error("支払管理データ取得エラー:", error)
  }

  // 支払先マスタ（全件）を取得して vendor_name → method のマップを作る
  const { data: masterRows, error: masterError } = await supabase
    .from("vendor_payment_methods")
    .select("vendor_name, method, updated_at")
    .order("updated_at", { ascending: false })

  if (masterError) {
    console.error("支払先マスタ取得エラー:", masterError)
  }

  const masterMap = new Map<string, string>()
  for (const row of masterRows ?? []) {
    if (typeof row.vendor_name === "string") {
      masterMap.set(row.vendor_name, row.method)
    }
  }

  // 各請求書の最終カテゴリを判定して、要振込 / 口座振替 に振り分ける
  const payDocs: PaymentDoc[] = []
  const debitDocs: PaymentDoc[] = []

  for (const doc of data ?? []) {
    const vendorName = doc.vendor_name ?? ""
    const masterMethod = vendorName ? masterMap.get(vendorName) ?? null : null
    const category = resolvePaymentCategory(doc.payment_method, masterMethod)

    const mapped: PaymentDoc = {
      id: doc.id,
      vendor_name: doc.vendor_name,
      amount: doc.amount,
      due_date: doc.due_date,
      payment_method: doc.payment_method ?? "unknown",
      bank_info: (doc.bank_info as BankInfo | null) ?? null,
      payment_status: doc.payment_status ?? "未対応",
      category,
      master_method: masterMethod,
    }

    if (category === "口座振替") {
      debitDocs.push(mapped)
    } else if (requiresTransfer(category)) {
      payDocs.push(mapped)
    }
    // 「その他」（現金・カード等）は要振込にも口座振替にも載せない（従来どおり除外）
  }

  // 口座振替の支払先マスタ一覧（専用メニュー用）
  const vendorMasters: VendorMaster[] = (masterRows ?? [])
    .filter((r) => r.method === "口座振替" && typeof r.vendor_name === "string")
    .map((r) => ({
      vendor_name: r.vendor_name,
      method: r.method,
      updated_at: r.updated_at,
    }))

  return (
    <PaymentsClient
      payDocs={payDocs}
      debitDocs={debitDocs}
      vendorMasters={vendorMasters}
    />
  )
}
