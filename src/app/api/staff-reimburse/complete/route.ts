import { NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { settleStaffReceipt } from "@/lib/staff-refund-core"
import { STAFF_EXPENSE_DETAILS } from "@/lib/subsidy"
import { parseAiRawObject } from "@/lib/staff-receipt-split"
import type { Database } from "@/types/database"

/**
 * 未完了の申請を、担当が代わりに完了させる。
 *
 * ■ なぜ必要か
 * スタッフが写真を送ったあと、区分を選ばずに離脱すると明細が作られず、
 * そのままでは給与に入らない。これまでは本人が最後まで進めるしかなく、
 * 締め日に本人の操作を待つことになっていた（連絡がつかないと支給できない）。
 *
 * ■ できること
 * 本人の申請（staff_receipts）をそのまま使って明細を作る。
 * 写真も申請日もそのまま残るため、本人のLINEの「申請履歴」でも
 * 同じ1件が「登録済み」に変わる（担当の画面と本人の画面が一致する）。
 *
 * ■ 安全のための制限
 * - すでに明細がある申請は二重に作らない
 * - 取り消し済みの申請は対象にしない
 * - 誰が代わりに登録したかを記録する（ai_raw.completed_by_admin）
 */

export const maxDuration = 60

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Supabaseの接続情報が設定されていません")
  return createSupabaseClient<Database>(url, key)
}

/** 本人が申請したものを担当が完了させた印（一覧で見分けるため） */
const ADMIN_COMPLETE_TAG = "担当が代わりに登録"

export async function POST(request: Request) {
  const auth = await createAuthClient()
  const {
    data: { user },
  } = await auth.auth.getUser()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as {
    receiptId?: string
    detailKey?: string
    amount?: number
    storeName?: string
    paymentDate?: string
    courseId?: string
    expenseItem?: string
  }

  if (!body.receiptId) {
    return NextResponse.json({ error: "対象の申請が指定されていません" }, { status: 400 })
  }
  const detail = STAFF_EXPENSE_DETAILS.find((d) => d.key === body.detailKey) ?? null
  if (!detail) {
    return NextResponse.json({ error: "費用区分を選択してください" }, { status: 400 })
  }
  if (body.courseId && !body.expenseItem) {
    return NextResponse.json(
      { error: "講座を選んだ場合は内訳も選んでください" },
      { status: 400 }
    )
  }

  try {
    const service = createServiceClient()

    const { data: receiptRow, error: readError } = await service
      .from("staff_receipts")
      .select("id, staff_member_id, amount, store_name, date, ai_raw")
      .eq("id", body.receiptId)
      .maybeSingle()
    if (readError) throw readError
    if (!receiptRow) {
      return NextResponse.json({ error: "対象の申請が見つかりません" }, { status: 404 })
    }
    const receipt = receiptRow as {
      id: string
      staff_member_id: string | null
      amount: number | null
      store_name: string | null
      date: string | null
      ai_raw: unknown
    }
    const raw = parseAiRawObject(receipt.ai_raw) ?? {}

    if (raw.cancelled_at) {
      return NextResponse.json(
        { error: "この申請は本人が取り消しています。登録できません。" },
        { status: 409 }
      )
    }

    // すでに明細があれば二重に作らない
    const { data: existing } = await service
      .from("petty_cash_transactions")
      .select("id")
      .eq("staff_receipt_id", receipt.id)
      .limit(1)
    if (existing && existing.length > 0) {
      return NextResponse.json(
        { error: "この申請はすでに登録されています。" },
        { status: 409 }
      )
    }

    // 金額・支払先・支払年月日は、読み取り違いを担当が直せるようにする
    const patch: Record<string, unknown> = {}
    if (typeof body.amount === "number" && body.amount > 0) patch.amount = Math.round(body.amount)
    if (typeof body.storeName === "string" && body.storeName.trim()) {
      patch.store_name = body.storeName.trim()
    }
    if (body.paymentDate) patch.date = body.paymentDate

    // 誰が代わりに登録したかを残す（本人の申請であることは変えない）
    patch.ai_raw = JSON.parse(
      JSON.stringify({
        ...raw,
        completed_by_admin: { at: new Date().toISOString(), by: user.email ?? "担当" },
        ...(body.paymentDate ? { issue_date: body.paymentDate } : {}),
        detail_key: detail.key,
      })
    )

    const { error: updateError } = await service
      .from("staff_receipts")
      .update(patch)
      .eq("id", receipt.id)
    if (updateError) throw updateError

    // 講座と内訳が指定されていれば、上限・支給率の判定を使う（LINEと同じ経路）
    let phase2: Parameters<typeof settleStaffReceipt>[0]["phase2"] | undefined
    if (body.courseId && body.expenseItem) {
      const { data: course } = await service
        .from("courses")
        .select("kind, rule")
        .eq("id", body.courseId)
        .single()
      if (!course) {
        return NextResponse.json({ error: "指定された講座が見つかりません" }, { status: 400 })
      }
      phase2 = {
        item: body.expenseItem as NonNullable<typeof phase2>["item"],
        courseId: body.courseId,
        courseKind: (course as { kind: string }).kind as NonNullable<typeof phase2>["courseKind"],
        courseRule: (course as { rule: string }).rule as NonNullable<typeof phase2>["courseRule"],
      }
    } else if (body.expenseItem) {
      phase2 = { item: body.expenseItem as NonNullable<typeof phase2>["item"] }
    }

    const result = await settleStaffReceipt({
      staffReceiptId: receipt.id,
      settlementMethod: "payroll",
      subsidyCategory: detail.subsidyCategory,
      expenseDetail: detail.fullLabel,
      registeredBy: ADMIN_COMPLETE_TAG,
      client: service,
      phase2,
    })
    if (result.status !== "ok") {
      return NextResponse.json(
        { error: `登録できませんでした（${result.status}）` },
        { status: 500 }
      )
    }

    return NextResponse.json({
      ok: true,
      amount: result.amount ?? null,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "登録できませんでした" },
      { status: 500 }
    )
  }
}
