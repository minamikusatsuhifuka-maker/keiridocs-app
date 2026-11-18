import { NextResponse } from "next/server"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"
import { fetchAllRows } from "@/lib/supabase/fetch-all"
import { deleteFile } from "@/lib/dropbox"

/**
 * テストスタッフの申請と画像をまとめて削除する。
 *
 * POST /api/staff-receipts/purge-test  { staffMemberId, confirmName }
 *
 * 実機テストを何度かやり直すと、テストの申請と画像が溜まる。
 * 1件ずつ消すのは手間がかかるうえ、消し残しが重複判定に当たって
 * 同じ写真を送り直せなくなるため、まとめて消せるようにする。
 *
 * ■ 本番のデータを消さないための歯止め
 * 1. 対象は **テスト実行中に作られた申請だけ**（ai_raw.test_run_id が付いた記録）。
 *    印の無い記録＝本番の申請は、どんな操作をしても消えない。
 *    「テストスタッフONの人の申請をすべて消す」ようにしてはいけない。
 *    旧アプリから使っている方には本番の申請が残っているため。
 * 2. staff_members.is_test が true の人だけ。
 * 3. 消す前に**一覧**を返す（GET）。日付・支払先・金額を目で確かめられる。
 * 4. 画面で**氏名を入力**してもらい、一致したときだけ実行する。
 *
 * ■ 消すもの
 * - petty_cash_transactions（スタッフ立替の明細）
 * - staff_receipts（LINEからの申請）
 * - Dropboxの画像
 *
 * Dropboxの削除に失敗しても記録の削除は続ける（消せなかったパスを返す）。
 * 画像だけが残っても申請の判定には影響しないため、止めるより進めたほうがよい。
 */

export const maxDuration = 300

/** サービスロールキーでRLSをバイパスするSupabaseクライアント（サーバーサイドのみ） */
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createSupabaseClient<Database>(url, serviceKey)
}

interface ReceiptRow {
  id: string
  dropbox_path: string | null
  date: string | null
  store_name: string | null
  amount: number | null
  created_at: string | null
  test_run_id: string | null
}

/** 対象スタッフを読み、テストスタッフであることを確かめる */
async function loadTestStaff(
  service: ReturnType<typeof createServiceClient>,
  staffMemberId: string
): Promise<{ id: string; name: string } | { error: string; status: number }> {
  const { data, error } = await service
    .from("staff_members")
    .select("id, name, is_test")
    .eq("id", staffMemberId)
    .maybeSingle()
  if (error) return { error: error.message, status: 500 }
  const row = data as { id: string; name: string; is_test: boolean | null } | null
  if (!row) return { error: "スタッフが見つかりません", status: 404 }
  if (!row.is_test) {
    return {
      error:
        "この操作はテストスタッフにだけ使えます。" +
        "本番の申請を誤って消さないための制限です。" +
        "テストの記録を消す場合は、先に「テストスタッフ」をONにしてください。",
      status: 400,
    }
  }
  return { id: row.id, name: row.name }
}

/** 削除の対象（テスト実行中に作られた申請）の一覧を返す（実行前の確認用） */
export async function GET(request: Request) {
  const authSupabase = await createAuthClient()
  const {
    data: { user },
  } = await authSupabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  const staffMemberId = new URL(request.url).searchParams.get("staffMemberId")
  if (!staffMemberId) {
    return NextResponse.json({ error: "スタッフが指定されていません" }, { status: 400 })
  }

  const service = createServiceClient()
  const staff = await loadTestStaff(service, staffMemberId)
  if ("error" in staff) {
    return NextResponse.json({ error: staff.error }, { status: staff.status })
  }

  try {
    const receipts = await listReceipts(service, staffMemberId)
    const transactions = await countTransactions(
      service,
      staffMemberId,
      receipts.map((r) => r.id)
    )

    return NextResponse.json({
      staffName: staff.name,
      receipts: receipts.length,
      photos: receipts.filter((r) => r.dropbox_path).length,
      transactions,
      // 目で確かめられるように一覧も返す（新しい順）
      items: receipts
        .slice()
        .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
        .map((r) => ({
          id: r.id,
          date: r.date,
          store: r.store_name,
          amount: r.amount,
          testRunId: r.test_run_id,
          createdAt: r.created_at,
          hasPhoto: !!r.dropbox_path,
        })),
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "件数を取得できませんでした" },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  const authSupabase = await createAuthClient()
  const {
    data: { user },
  } = await authSupabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as {
    staffMemberId?: string
    confirmName?: string
  }
  if (!body.staffMemberId) {
    return NextResponse.json({ error: "スタッフが指定されていません" }, { status: 400 })
  }

  const service = createServiceClient()
  const staff = await loadTestStaff(service, body.staffMemberId)
  if ("error" in staff) {
    return NextResponse.json({ error: staff.error }, { status: staff.status })
  }

  // 氏名の入力が一致したときだけ実行する（押し間違いで消えないように）
  const typed = (body.confirmName ?? "").replace(/[\s　]/g, "")
  if (typed !== staff.name.replace(/[\s　]/g, "")) {
    return NextResponse.json(
      { error: `確認のため、お名前「${staff.name}」を正しく入力してください。` },
      { status: 400 }
    )
  }

  try {
    const receipts = await listReceipts(service, body.staffMemberId)

    if (receipts.length === 0) {
      return NextResponse.json({
        ok: true,
        staffName: staff.name,
        deletedReceipts: 0,
        deletedPhotos: 0,
        failedPaths: [],
      })
    }

    // 1. 明細を先に消す（staff_receipts を先に消すと参照が外れた明細が残るため）。
    //    対象はテスト実行の申請に紐づく明細だけ。本番の明細には触れない。
    const { error: txError } = await service
      .from("petty_cash_transactions")
      .delete()
      .eq("category", "staff_refund")
      .eq("staff_member_id", body.staffMemberId)
      .in(
        "staff_receipt_id",
        receipts.map((r) => r.id)
      )
    if (txError) throw new Error(`明細を削除できませんでした: ${txError.message}`)

    // 2. Dropboxの画像を消す（失敗しても続ける）
    const failedPaths: string[] = []
    for (const r of receipts) {
      if (!r.dropbox_path) continue
      try {
        await deleteFile(r.dropbox_path)
      } catch {
        failedPaths.push(r.dropbox_path)
      }
      // Dropbox APIのRate Limit対策（リクエスト間に50ms以上空ける）
      await new Promise((resolve) => setTimeout(resolve, 60))
    }

    // 3. 申請を消す（IDを指定して、テスト実行の分だけ）
    const { error: receiptError } = await service
      .from("staff_receipts")
      .delete()
      .in(
        "id",
        receipts.map((r) => r.id)
      )
    if (receiptError) throw new Error(`申請を削除できませんでした: ${receiptError.message}`)

    return NextResponse.json({
      ok: true,
      staffName: staff.name,
      deletedReceipts: receipts.length,
      deletedPhotos: receipts.filter((r) => r.dropbox_path).length - failedPaths.length,
      failedPaths,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "削除できませんでした" },
      { status: 500 }
    )
  }
}

/**
 * 削除の対象＝**テスト実行中に作られた申請**を全件取得する。
 *
 * ai_raw.test_run_id が付いている記録だけを返す。
 * 印の無い記録（旧アプリからの申請を含む本番の記録）は決して返さない。
 * ここが本番データを守る要なので、条件を緩めないこと。
 */
async function listReceipts(
  service: ReturnType<typeof createServiceClient>,
  staffMemberId: string
): Promise<ReceiptRow[]> {
  type Row = {
    id: string
    dropbox_path: string | null
    date: string | null
    store_name: string | null
    amount: number | null
    created_at: string | null
    ai_raw: unknown
  }
  const rows = await fetchAllRows<Row>((from, to) =>
    service
      .from("staff_receipts")
      .select("id, dropbox_path, date, store_name, amount, created_at, ai_raw")
      .eq("staff_member_id", staffMemberId)
      .not("ai_raw->>test_run_id", "is", null)
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: Row[] | null
        error: { message: string } | null
      }>
  )
  return rows
    .map((r) => {
      const raw = (r.ai_raw && typeof r.ai_raw === "object" ? r.ai_raw : {}) as Record<string, unknown>
      return {
        id: r.id,
        dropbox_path: r.dropbox_path,
        date: r.date,
        store_name: r.store_name,
        amount: r.amount,
        created_at: r.created_at,
        test_run_id: typeof raw.test_run_id === "string" ? raw.test_run_id : null,
      }
    })
    // 念のため二重に確かめる（印の無いものは絶対に消さない）
    .filter((r) => !!r.test_run_id)
}

/** 対象の申請に紐づく立替明細の件数 */
async function countTransactions(
  service: ReturnType<typeof createServiceClient>,
  staffMemberId: string,
  receiptIds: string[]
): Promise<number> {
  if (receiptIds.length === 0) return 0
  const { count } = await service
    .from("petty_cash_transactions")
    .select("id", { count: "exact", head: true })
    .eq("category", "staff_refund")
    .eq("staff_member_id", staffMemberId)
    .in("staff_receipt_id", receiptIds)
  return count ?? 0
}
