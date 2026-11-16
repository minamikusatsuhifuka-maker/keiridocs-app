import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { fetchAllRows } from "@/lib/supabase/fetch-all"
import type { Database } from "@/types/database"

/**
 * 未完了の申請（スタッフが途中でやめた申請）の一覧。
 *
 * GET /api/staff-reimburse/incomplete
 *
 * ■ 何が「未完了」か
 *   LINEで領収書の写真を受け取ると、AI解析と重複チェックのあと
 *   「Dropboxに保存 → staff_receipts に登録 → 費用区分を選択 → 確定」の順に進む。
 *   区分を選ばずに離脱すると staff_receipts の行だけが残り、精算（petty_cash_transactions）が作られない。
 *   この行はスタッフ立替の一覧にも税理士提出にも出てこないため、
 *   **本人は申請したつもりなのに支給されない**まま誰も気づけない。それを拾い上げる。
 *
 * ■ 除外するもの
 *   - 会話セクションのタイムアウト（30分）前の申請＝まだ操作中かもしれないので60分未満は出さない
 *   - テストスタッフ（is_test）の申請
 */

export const maxDuration = 60

/** 操作中の申請を拾わないための猶予（分） */
const GRACE_MINUTES = 60

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Supabaseの接続情報が設定されていません")
  return createClient<Database>(url, key)
}

interface ReceiptRow {
  id: string
  staff_member_id: string | null
  file_name: string | null
  dropbox_path: string | null
  store_name: string | null
  amount: number | null
  date: string | null
  created_at: string
}

export async function GET() {
  const authSupabase = await createAuthClient()
  const {
    data: { user },
    error: authError,
  } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const supabase = createServiceClient()
    const cutoff = new Date(Date.now() - GRACE_MINUTES * 60 * 1000).toISOString()

    // 1. 精算済みの領収書IDを集める（1000件上限に当たらないよう全件取得する）
    const txRows = await fetchAllRows<{ staff_receipt_id: string | null }>((from, to) =>
      supabase
        .from("petty_cash_transactions")
        .select("staff_receipt_id")
        .eq("category", "staff_refund")
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
          data: { staff_receipt_id: string | null }[] | null
          error: { message: string } | null
        }>
    )
    const settled = new Set(
      txRows.map((t) => t.staff_receipt_id).filter((v): v is string => !!v)
    )

    // 2. 猶予を過ぎた領収書を全件取得
    const receipts = await fetchAllRows<ReceiptRow>((from, to) =>
      supabase
        .from("staff_receipts")
        .select("id, staff_member_id, file_name, dropbox_path, store_name, amount, date, created_at")
        .lt("created_at", cutoff)
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
          data: ReceiptRow[] | null
          error: { message: string } | null
        }>
    )

    // 3. スタッフ名とテストスタッフ判定
    const staffRaw = await fetchAllRows<{ id: string; name: string; is_test: boolean | null }>(
      (from, to) =>
        supabase
          .from("staff_members")
          .select("id, name, is_test")
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
            data: { id: string; name: string; is_test: boolean | null }[] | null
            error: { message: string } | null
          }>
    )
    const staffNameMap = new Map(staffRaw.map((s) => [s.id, s.name]))
    const testStaffIds = new Set(staffRaw.filter((s) => s.is_test).map((s) => s.id))

    // 4. 精算されていないものだけを残す
    const rows = receipts
      .filter((r) => !settled.has(r.id))
      .filter((r) => !(r.staff_member_id && testStaffIds.has(r.staff_member_id)))
      .map((r) => ({
        receiptId: r.id,
        staffName: (r.staff_member_id && staffNameMap.get(r.staff_member_id)) || "不明なスタッフ",
        storeName: r.store_name?.trim() || "不明",
        amount: r.amount ?? 0,
        paymentDate: r.date ?? "",
        submittedAt: r.created_at,
        fileName: r.file_name ?? "",
        dropboxPath: r.dropbox_path ?? "",
      }))
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))

    return NextResponse.json({ rows, count: rows.length, graceMinutes: GRACE_MINUTES })
  } catch (e) {
    const message = e instanceof Error ? e.message : "未完了の申請を取得できませんでした"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
