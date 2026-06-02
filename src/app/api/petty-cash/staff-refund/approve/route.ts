import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { uploadFile } from "@/lib/dropbox"
import type { Database } from "@/types/database"

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createClient<Database>(url, serviceKey)
}

/**
 * POST /api/petty-cash/staff-refund/approve
 *
 * multipart/form-data:
 *  - files: File[]            （analyze で見た領収書を再アップロード）
 *  - staff_member_id: string
 *  - total_amount: string|number
 *  - note: string             明細サマリ等
 *  - transaction_date: string
 *
 * 動作:
 *  1) /経理書類/スタッフ領収書/{スタッフ名}/{YYYY年MM月}/ に全ファイルアップロード
 *  2) petty_cash_transactions に1件登録（receipt_urlsに全パス保存）
 *  3) petty_cash_settings.balance を更新
 */
export async function POST(req: NextRequest) {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const formData = await req.formData()
    const files = formData.getAll("files") as File[]
    const staffMemberId = formData.get("staff_member_id") as string
    const totalAmount = Number(formData.get("total_amount"))
    const note = (formData.get("note") as string) ?? ""
    const transactionDate =
      (formData.get("transaction_date") as string) || new Date().toISOString().slice(0, 10)
    // 精算方法（未指定は後方互換で小口返金扱い）
    const rawSettlement = formData.get("settlement_method") as string | null
    const settlementMethod =
      rawSettlement === "payroll" || rawSettlement === "storage_only"
        ? rawSettlement
        : "petty_cash"

    if (!staffMemberId) {
      return NextResponse.json({ error: "スタッフが選択されていません" }, { status: 400 })
    }
    if (!totalAmount || totalAmount <= 0) {
      return NextResponse.json({ error: "合計金額が不正です" }, { status: 400 })
    }
    if (!files || files.length === 0) {
      return NextResponse.json({ error: "領収書ファイルがありません" }, { status: 400 })
    }

    const { data: roleData } = await authSupabase
      .from("user_roles")
      .select("display_name")
      .eq("user_id", user.id)
      .maybeSingle()
    const registeredBy =
      (roleData?.display_name as string) ||
      (user.user_metadata?.full_name as string) ||
      user.email ||
      "不明"

    const serviceClient = createServiceClient()

    // スタッフ名取得
    const { data: staff } = await serviceClient
      .from("staff_members")
      .select("id, name")
      .eq("id", staffMemberId)
      .single()
    if (!staff) {
      return NextResponse.json({ error: "対象スタッフが存在しません" }, { status: 404 })
    }
    const staffData = staff as unknown as { id: string; name: string }

    // フォルダパス: /経理書類/スタッフ領収書/{スタッフ名}/{YYYY年MM月}/
    const root = process.env.DROPBOX_ROOT_FOLDER || "/経理書類"
    const yyyymm = transactionDate.slice(0, 7).replace("-", "年") + "月"
    const folder = `${root}/スタッフ領収書/${staffData.name}/${yyyymm}`

    // 各ファイルをDropboxへアップロード
    const uploadedPaths: string[] = []
    for (const file of files) {
      const arrayBuffer = await file.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      const ts = Date.now()
      const safeName = file.name.replace(/[\/\\:*?"<>|]/g, "_")
      const path = `${folder}/${ts}_${safeName}`
      const uploaded = await uploadFile(path, buffer)
      uploadedPaths.push(uploaded)
    }

    // 残高更新
    const { data: settingsRaw, error: settingsError } = await serviceClient
      .from("petty_cash_settings")
      .select("*")
      .limit(1)
      .single()
    if (settingsError) throw settingsError
    const settings = settingsRaw as unknown as { id: string; balance: number }
    const currentBalance = settings.balance ?? 0
    // 小口返金のみ残高を減算。給与返金・保管のみは残高を動かさない
    const deductsBalance = settlementMethod === "petty_cash"
    const newBalance = deductsBalance ? currentBalance - totalAmount : currentBalance

    const { data: tx, error: txErr } = await serviceClient
      .from("petty_cash_transactions")
      .insert({
        type: "出金",
        amount: totalAmount,
        description: `${staffData.name} スタッフ返金（${files.length}件）`,
        staff_member_id: staffMemberId,
        registered_by: registeredBy,
        category: "staff_refund",
        receipt_urls: uploadedPaths,
        note,
        created_by: registeredBy,
        transaction_date: transactionDate,
        balance_after: newBalance,
        settlement_method: settlementMethod,
        // 給与返金のみ返金待ちステータスを付与
        payroll_refund_status: settlementMethod === "payroll" ? "pending" : null,
      })
      .select()
      .single()
    if (txErr) throw txErr

    // 残高を動かすのは小口返金のときだけ
    if (deductsBalance) {
      const { error: updateError } = await serviceClient
        .from("petty_cash_settings")
        .update({ balance: newBalance, updated_at: new Date().toISOString() })
        .eq("id", settings.id)
      if (updateError) throw updateError
    }

    return NextResponse.json({
      success: true,
      transaction: tx,
      uploaded: uploadedPaths,
      balance: newBalance,
    })
  } catch (e: unknown) {
    console.error("[staff-refund/approve]", e)
    const msg = e instanceof Error ? e.message : "unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
