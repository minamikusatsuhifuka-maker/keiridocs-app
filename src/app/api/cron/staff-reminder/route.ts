import { NextRequest, NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/server"
import { fetchAllRows } from "@/lib/supabase/fetch-all"
import { parseAiRawObject } from "@/lib/staff-receipt-split"
import { isSuspended } from "@/lib/line-staff-profile"
import { notifyAdmins } from "@/lib/line-admin-notify"
import type { Database } from "@/types/database"

/**
 * スタッフと担当への自動のお知らせ（1日1回）。
 *
 * ■ 作る理由
 * 20日締めの分をその月の給与に乗せたい。締めに間に合わないと翌月になり、
 * 本人は「申請したのに入っていない」と感じる。担当も画面を見に行かないと
 * 気づけず、確認もれにつながる。こちらから知らせる。
 *
 * ■ 送るもの
 *   1. 未完了の申請（写真は届いたが区分を選んでいない）
 *      → 本人に1回だけ知らせ、その場で続きに戻れるボタンを付ける
 *   2. 締め日が近い（17日・20日）
 *      → 未完了がある本人に「今日までです」と知らせる
 *   3. 担当へのまとめ（17日・20日）
 *      → 要対応の件数と内訳。確定しないと給与に乗らないため
 *
 * ■ 重複して送らないために
 * 未完了の通知は staff_receipts.ai_raw.incomplete_notified_at に記録し、
 * 1件につき1回だけ送る（毎日届くと無視されるようになるため）。
 */

export const maxDuration = 60

/** 締め日（毎月20日）。これを過ぎた申請は翌月分になる */
const CLOSING_DAY = 20

/** 締め前に知らせる日（20日締めの3日前と当日） */
const REMIND_DAYS = [17, CLOSING_DAY]

/** 操作中の申請を未完了として拾わないための猶予（分） */
const INCOMPLETE_GRACE_MINUTES = 60

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createSupabaseClient<Database>(url, serviceKey)
}

async function checkAuth(request: NextRequest): Promise<boolean> {
  const authHeader = request.headers.get("authorization")
  if (authHeader === `Bearer ${process.env.CRON_SECRET}`) return true
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    return !!user
  } catch {
    return false
  }
}

/** LINEへの送信（失敗しても処理を止めない） */
/**
 * LINEへ送る。
 *
 * @param actions 付けるボタン（クイックリプライ）。
 *   文章で「トークのボタンから続けてください」と書いても、過去のやり取りに
 *   埋もれて見つけられない。その申請を直接続けられるボタンを一緒に送る。
 */
async function push(
  userId: string,
  text: string,
  actions?: { label: string; data: string; displayText: string }[]
): Promise<boolean> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token || !userId) return false
  try {
    const message: Record<string, unknown> = { type: "text", text: text.slice(0, 4900) }
    if (actions && actions.length > 0) {
      message.quickReply = {
        items: actions.slice(0, 13).map((a) => ({
          type: "action",
          action: {
            type: "postback",
            label: a.label.slice(0, 20),
            data: a.data,
            displayText: a.displayText,
          },
        })),
      }
    }
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: userId, messages: [message] }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** 今日の日付（JST） */
function jstToday(): { date: string; day: number } {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000)
  return { date: now.toISOString().slice(0, 10), day: now.getUTCDate() }
}

interface StaffRow {
  id: string
  name: string
  line_user_id: string | null
  retired_at?: string | null
  is_test?: boolean | null
  line_profile?: unknown
}

interface ReceiptRow {
  id: string
  staff_member_id: string | null
  store_name: string | null
  amount: number | null
  created_at: string
  ai_raw?: unknown
}

export async function GET(request: NextRequest) {
  if (!(await checkAuth(request))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const supabase = createServiceClient()
    const { day } = jstToday()
    const isRemindDay = REMIND_DAYS.includes(day)

    // 1. スタッフ（退職者・テスト・休止中は対象外）
    const staffRaw = await fetchAllRows<StaffRow>((from, to) =>
      supabase
        .from("staff_members")
        .select("id, name, line_user_id, retired_at, is_test, line_profile")
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
          data: StaffRow[] | null
          error: { message: string } | null
        }>
    )
    const staff = new Map(
      staffRaw
        .filter((m) => !m.retired_at && !m.is_test && !isSuspended(m.line_profile))
        .map((m) => [m.id, m])
    )

    // 2. 未完了の申請（精算が作られていない領収書）
    const settledRows = await fetchAllRows<{ staff_receipt_id: string | null }>((from, to) =>
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
    const settled = new Set(settledRows.map((t) => t.staff_receipt_id).filter((v): v is string => !!v))

    const cutoff = new Date(Date.now() - INCOMPLETE_GRACE_MINUTES * 60 * 1000).toISOString()
    const receipts = await fetchAllRows<ReceiptRow>((from, to) =>
      supabase
        .from("staff_receipts")
        .select("id, staff_member_id, store_name, amount, created_at, ai_raw")
        .lt("created_at", cutoff)
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
          data: ReceiptRow[] | null
          error: { message: string } | null
        }>
    )

    const incomplete = receipts.filter(
      (r) =>
        !settled.has(r.id) &&
        r.staff_member_id &&
        staff.has(r.staff_member_id) &&
        !parseAiRawObject(r.ai_raw)?.pending_dismissed_at
    )

    // 3. 未完了を本人へ（1件につき1回だけ）
    let notified = 0
    for (const r of incomplete) {
      const ai = parseAiRawObject(r.ai_raw) ?? {}
      if (ai.incomplete_notified_at) continue
      const member = staff.get(r.staff_member_id!)
      if (!member?.line_user_id) continue

      const store = r.store_name?.trim() || "お送りいただいた領収書"
      const amount = r.amount ? `¥${r.amount.toLocaleString("ja-JP")}` : "金額の読み取り中"
      const ok = await push(
        member.line_user_id,
        "【申請が途中のままです】\n" +
          `${store}（${amount}）は、最後まで進んでいないため\n` +
          "まだ支給の対象になっていません。\n\n" +
          "下の「この申請を続ける」を押すと、続きから進められます。\n" +
          "写真を送り直す必要はありません。\n\n" +
          `※${CLOSING_DAY}日までに確定した分が、その月のお給与に反映されます。`,
        [
          {
            label: "この申請を続ける",
            data: `action=rsm&rid=${r.id}`,
            displayText: "この申請を続けます",
          },
        ]
      )
      if (ok) {
        notified++
        await supabase
          .from("staff_receipts")
          .update({
            ai_raw: JSON.parse(
              JSON.stringify({ ...ai, incomplete_notified_at: new Date().toISOString() })
            ),
          })
          .eq("id", r.id)
      }
    }

    // 4. 締め日が近い日は、未完了が残っている本人にもう一度知らせる
    let closingNotified = 0
    if (isRemindDay) {
      const byStaff = new Map<string, number>()
      for (const r of incomplete) {
        const id = r.staff_member_id!
        byStaff.set(id, (byStaff.get(id) ?? 0) + 1)
      }
      for (const [staffId, count] of byStaff) {
        const member = staff.get(staffId)
        if (!member?.line_user_id) continue
        const ok = await push(
          member.line_user_id,
          day === CLOSING_DAY
            ? "【本日が締め日です】\n" +
              `区分が選ばれていない申請が ${count}件 あります。\n` +
              "本日中に選んでいただくと、今月のお給与に反映されます。\n\n" +
              "お困りのときは、メニューの「問い合わせ」からご連絡ください。"
            : "【締め日が近づいています】\n" +
              `区分が選ばれていない申請が ${count}件 あります。\n` +
              `${CLOSING_DAY}日までに選んでいただくと、今月のお給与に反映されます。\n\n` +
              "お困りのときは、メニューの「問い合わせ」からご連絡ください。"
        )
        if (ok) closingNotified++
      }
    }

    // 5. 担当へのまとめ（締め前）。確定しないと給与に乗らないため件数を知らせる
    let adminNotified = false
    if (isRemindDay) {
      const holds = await fetchAllRows<{ hold_reason: string | null }>((from, to) =>
        supabase
          .from("petty_cash_transactions")
          .select("hold_reason")
          .eq("category", "staff_refund")
          .not("hold_reason", "is", null)
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
            data: { hold_reason: string | null }[] | null
            error: { message: string } | null
          }>
      ).catch(() => [] as { hold_reason: string | null }[])

      const total = holds.length + incomplete.length
      // ふだん確認するのは担当なので、院長だけでなく担当にも送る
      const sentCount = await notifyAdmins(
        supabase as never,
        (day === CLOSING_DAY ? "【本日が締め日です】\n" : "【締め日が近づいています】\n") +
          `要対応：${total}件\n` +
          `　確認待ちの申請：${holds.length}件\n` +
          `　区分が未選択：${incomplete.length}件\n\n` +
          "確定するまで税理士提出にも給与集計にも入りません。\n" +
          "アプリの「スタッフ立替」の画面で確認・承認をお願いします。"
      )
      adminNotified = sentCount > 0
    }

    return NextResponse.json({
      ok: true,
      day,
      isRemindDay,
      incompleteCount: incomplete.length,
      notified,
      closingNotified,
      adminNotified,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "処理できませんでした"
    console.error("[staff-reminder]", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
