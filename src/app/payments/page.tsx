import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { PaymentsClient, type PaymentDoc } from "./payments-client"
import type { BankInfo } from "@/lib/gemini"

// 支払管理ページ（要振込の請求書のみ・支払期限順・未払い管理）
// 対象: type='請求書' かつ payment_method が bank_transfer / unknown / NULL（自動引落し・カード払いは除外）
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

  // 要振込の請求書を取得（自動引落し・カード払いは除外、NULL=既存データは不明として含める）
  let query = supabase
    .from("documents")
    .select("id, vendor_name, amount, due_date, type, payment_method, bank_info, payment_status, status")
    .eq("type", "請求書")
    .neq("status", "アーカイブ")
    .or("payment_method.in.(bank_transfer,unknown),payment_method.is.null")
    .order("due_date", { ascending: true, nullsFirst: false })

  // admin以外は自分の書類のみ
  if (!isAdminUser) {
    query = query.eq("user_id", user.id)
  }

  const { data, error } = await query

  if (error) {
    console.error("支払管理データ取得エラー:", error)
  }

  const documents: PaymentDoc[] = (data ?? []).map((doc) => ({
    id: doc.id,
    vendor_name: doc.vendor_name,
    amount: doc.amount,
    due_date: doc.due_date,
    payment_method: doc.payment_method ?? "unknown",
    bank_info: (doc.bank_info as BankInfo | null) ?? null,
    payment_status: doc.payment_status ?? "未対応",
  }))

  return <PaymentsClient documents={documents} />
}
