import { NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { parseAiRawObject } from "@/lib/staff-receipt-split"
import { fetchAllRows } from "@/lib/supabase/fetch-all"
import type { Database } from "@/types/database"

/**
 * 「申請したのに見つからない」を調べる画面のためのAPI。
 *
 * GET /api/staff-receipts/diagnose?staffMemberId=...&days=14
 *
 * ■ なぜ必要か
 * 申請が支給の対象にならない理由は複数ある（明細が作られていない、
 * テストスタッフ扱い、テストの印が残っている、取り消し済み、など）。
 * どれに当たるかは画面から分からず、担当も本人も原因を追えなかった。
 *
 * この一覧は**除外されたものも含めて**全件返し、1件ずつ理由を日本語で付ける。
 * 記録は一切変更しない（読み取りのみ）。
 */

export const maxDuration = 60

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Supabaseの接続情報が設定されていません")
  return createSupabaseClient<Database>(url, key)
}

export interface DiagnoseItem {
  receiptId: string
  staffMemberId: string | null
  staffName: string
  /** 申請日時（ISO） */
  createdAt: string
  /** 領収書の日付 */
  date: string | null
  storeName: string | null
  amount: number | null
  /** 明細（petty_cash_transactions）があるか＝支給の対象になっているか */
  settled: boolean
  /** 本人が取り消したか（取り消し済みは担当も登録できない） */
  cancelled: boolean
  expenseDetail: string | null
  holdReason: string | null
  /** 支給の対象になっているか（最終判定） */
  counted: boolean
  /** そうなっている理由（日本語・画面にそのまま出す） */
  reasons: string[]
  /** 担当が押せる手当て */
  fix: "clear_test_mark" | "turn_off_test_staff" | "resume_in_line" | "approve_hold" | "none"
}

export async function GET(request: Request) {
  const auth = await createAuthClient()
  const {
    data: { user },
  } = await auth.auth.getUser()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  const url = new URL(request.url)
  const staffMemberId = url.searchParams.get("staffMemberId")
  const days = Math.min(120, Math.max(1, Number(url.searchParams.get("days") ?? 14)))
  const since = new Date(Date.now() - days * 86400000).toISOString()

  try {
    const service = createServiceClient()

    // スタッフ（テストスタッフかどうかを見るため）
    const staff = await fetchAllRows<{ id: string; name: string; is_test: boolean | null }>((from, to) =>
      service
        .from("staff_members")
        .select("id, name, is_test")
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
          data: { id: string; name: string; is_test: boolean | null }[] | null
          error: { message: string } | null
        }>
    )
    const staffById = new Map(staff.map((s) => [s.id, s]))

    // 申請（期間内の全件。除外されているものも必ず含める）
    let query = service
      .from("staff_receipts")
      .select("id, staff_member_id, date, store_name, amount, created_at, ai_raw")
      .gte("created_at", since)
    if (staffMemberId) query = query.eq("staff_member_id", staffMemberId)
    const { data: receiptRows, error } = await query.order("created_at", { ascending: false }).limit(300)
    if (error) throw error

    const receipts = (receiptRows ?? []) as {
      id: string
      staff_member_id: string | null
      date: string | null
      store_name: string | null
      amount: number | null
      created_at: string
      ai_raw: unknown
    }[]

    // 明細（支給の対象になっているか）
    const txByReceipt = new Map<string, { expense_detail: string | null; hold_reason: string | null }>()
    const ids = receipts.map((r) => r.id)
    for (let i = 0; i < ids.length; i += 200) {
      const { data: txs } = await service
        .from("petty_cash_transactions")
        .select("staff_receipt_id, expense_detail, hold_reason")
        .eq("category", "staff_refund")
        .in("staff_receipt_id", ids.slice(i, i + 200))
      for (const t of (txs ?? []) as {
        staff_receipt_id: string | null
        expense_detail: string | null
        hold_reason: string | null
      }[]) {
        if (t.staff_receipt_id) txByReceipt.set(t.staff_receipt_id, t)
      }
    }

    const items: DiagnoseItem[] = receipts.map((r) => {
      const raw = parseAiRawObject(r.ai_raw) ?? {}
      const member = r.staff_member_id ? staffById.get(r.staff_member_id) : undefined
      const tx = txByReceipt.get(r.id)
      const reasons: string[] = []
      let fix: DiagnoseItem["fix"] = "none"

      if (raw.cancelled_at) {
        reasons.push("本人が取り消した申請です。")
      }
      if (!tx && !raw.cancelled_at) {
        reasons.push(
          "最後まで進んでいないため、精算の明細が作られていません（支給されません）。" +
            "LINEの「申請履歴」から「この申請を続ける」で終えられます。"
        )
        fix = "resume_in_line"
      }
      if (member?.is_test) {
        reasons.push(
          "この方は「テストスタッフ」がONです。ONの間の申請は、給与集計と会計士さんへの提出から外れます。"
        )
        if (fix === "none") fix = "turn_off_test_staff"
      }
      if (typeof raw.test_run_id === "string" && raw.test_run_id) {
        reasons.push(
          "テストの印が付いています。テストを終える前の申請として扱われ、支給の対象から外れます。"
        )
        if (fix === "none" || fix === "turn_off_test_staff") fix = "clear_test_mark"
      }
      if (tx?.hold_reason) {
        reasons.push("担当の確認待ちです（上限超過・講座待ちなど）。確認すると支給額が確定します。")
        if (fix === "none") fix = "approve_hold"
      }
      // 支払日が読み取れていないものは、担当が確認して入れ直す必要がある
      if (raw.date_unconfirmed || !/^\d{4}-\d{2}-\d{2}$/.test((r.date ?? "").slice(0, 10))) {
        reasons.push(
          "支払年月日が読み取れていません（申請日を仮に入れています）。領収書を見て、明細の「編集」から正しい日付に直してください。"
        )
      }
      if (raw.duplicate_override_at) {
        reasons.push(
          "重複の案内を越えて、本人が「それでも登録する」で申請したものです。二重申請になっていないか確認してください。"
        )
      }
      if (raw.pending_dismissed_at) {
        reasons.push("担当が「対応済みにして隠す」を押したため、要対応の一覧から外れています。")
      }

      const counted =
        !!tx && !tx.hold_reason && !member?.is_test && !raw.test_run_id && !raw.cancelled_at
      if (counted) reasons.push("支給の対象になっています。")

      return {
        receiptId: r.id,
        staffMemberId: r.staff_member_id,
        staffName: member?.name ?? "不明なスタッフ",
        createdAt: r.created_at,
        date: r.date,
        storeName: r.store_name,
        amount: r.amount,
        settled: !!tx,
        cancelled: !!raw.cancelled_at,
        expenseDetail: tx?.expense_detail ?? null,
        holdReason: tx?.hold_reason ?? null,
        counted,
        reasons,
        fix,
      }
    })

    return NextResponse.json({
      items,
      days,
      counts: {
        total: items.length,
        counted: items.filter((i) => i.counted).length,
        notCounted: items.filter((i) => !i.counted).length,
      },
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "調べられませんでした" },
      { status: 500 }
    )
  }
}
