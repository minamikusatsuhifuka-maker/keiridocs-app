import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { uploadFile } from "@/lib/dropbox"
import type { Database } from "@/types/database"

// RLSバイパス用サービスクライアント（既存 petty-cash と同方式）
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createClient<Database>(url, serviceKey)
}

// 拡張子をMIMEタイプから推定
function extFromMime(mime: string): string {
  if (mime.includes("png")) return "png"
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg"
  if (mime.includes("webp")) return "webp"
  if (mime.includes("pdf")) return "pdf"
  return "bin"
}

type MemoRow = Database["public"]["Tables"]["payment_memos"]["Row"]
type ItemRow = Database["public"]["Tables"]["payment_memo_items"]["Row"]

// 一覧取得（支払項目を元メモと紐付けて返す。未払い優先・期限順）
export async function GET() {
  const supabase = await createAuthClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const { data: memosRaw, error: memosError } = await supabase
      .from("payment_memos")
      .select("*")
      .order("created_at", { ascending: false })
    if (memosError) throw memosError

    const { data: itemsRaw, error: itemsError } = await supabase
      .from("payment_memo_items")
      .select("*")
    if (itemsError) throw itemsError

    const memos = (memosRaw || []) as MemoRow[]
    const items = (itemsRaw || []) as ItemRow[]
    const memoMap = new Map(memos.map((m) => [m.id, m]))

    // 各項目に元メモ情報を添付
    const joined = items.map((it) => ({
      ...it,
      memo: it.memo_id ? memoMap.get(it.memo_id) ?? null : null,
    }))

    // 未払い優先 → 期限の早い順（期限なしは後ろ） → 登録日時降順
    joined.sort((a, b) => {
      const unpaidA = a.payment_status === "未払い" ? 0 : 1
      const unpaidB = b.payment_status === "未払い" ? 0 : 1
      if (unpaidA !== unpaidB) return unpaidA - unpaidB
      const dueA = a.due_date || "9999-12-31"
      const dueB = b.due_date || "9999-12-31"
      if (dueA !== dueB) return dueA < dueB ? -1 : 1
      return a.created_at < b.created_at ? 1 : -1
    })

    // 未払い合計
    const unpaidTotal = joined
      .filter((it) => it.payment_status === "未払い")
      .reduce((sum, it) => sum + (it.amount ?? 0), 0)

    return NextResponse.json({ items: joined, unpaidTotal })
  } catch (error) {
    console.error("支払いメモ一覧取得エラー:", error)
    return NextResponse.json({ error: "支払いメモの取得に失敗しました" }, { status: 500 })
  }
}

interface SaveItem {
  vendor_name?: string | null
  amount?: number | null
  due_date?: string | null
  payment_method?: string | null
  note?: string | null
}

// メモ＋抽出項目を保存（画像があればDropboxへ保存）
export async function POST(request: NextRequest) {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = (await request.json()) as {
      raw_text?: string
      ai_summary?: string
      image_base64?: string
      image_mime_type?: string
      items?: SaveItem[]
    }

    const items = Array.isArray(body.items) ? body.items : []
    if (items.length === 0) {
      return NextResponse.json({ error: "保存する支払項目がありません" }, { status: 400 })
    }

    const serviceClient = createServiceClient()

    // 登録者名取得
    const { data: roleData } = await authSupabase
      .from("user_roles")
      .select("display_name")
      .eq("user_id", user.id)
      .maybeSingle()
    const createdBy =
      (roleData?.display_name as string) ||
      (user.user_metadata?.full_name as string) ||
      user.email ||
      "不明"

    // 画像があれば Dropbox の支払いメモフォルダに保存
    let imageUrl: string | null = null
    if (body.image_base64 && body.image_mime_type) {
      try {
        const now = new Date()
        const ym = `${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, "0")}月`
        const ext = extFromMime(body.image_mime_type)
        const fileName = `paymemo_${now.getTime()}.${ext}`
        const dropboxPath = `/経理書類/支払いメモ/${ym}/${fileName}`
        const buffer = Buffer.from(body.image_base64, "base64")
        if (buffer.length > 0) {
          imageUrl = await uploadFile(dropboxPath, buffer)
        }
      } catch (e) {
        // 画像保存に失敗してもメモ本体の保存は続行する
        console.error("支払いメモ画像のDropbox保存に失敗:", e)
      }
    }

    // メモ本体を保存
    const { data: memo, error: memoError } = await serviceClient
      .from("payment_memos")
      .insert({
        raw_text: body.raw_text?.trim() || null,
        image_url: imageUrl,
        ai_summary: body.ai_summary?.trim() || null,
        created_by: createdBy,
      })
      .select()
      .single()
    if (memoError) throw memoError
    const memoRow = memo as MemoRow

    // 支払項目を保存
    const allowedMethods = ["bank_transfer", "credit_card", "auto_debit", "unknown"]
    const itemRows = items.map((it) => ({
      memo_id: memoRow.id,
      vendor_name: it.vendor_name?.trim() || null,
      amount: typeof it.amount === "number" && !Number.isNaN(it.amount) ? it.amount : null,
      due_date: it.due_date?.trim() || null,
      payment_method:
        it.payment_method && allowedMethods.includes(it.payment_method)
          ? it.payment_method
          : "unknown",
      note: it.note?.trim() || null,
      payment_status: "未払い",
    }))

    const { data: savedItems, error: itemsError } = await serviceClient
      .from("payment_memo_items")
      .insert(itemRows)
      .select()
    if (itemsError) throw itemsError

    return NextResponse.json({ memo: memoRow, items: savedItems })
  } catch (error) {
    console.error("支払いメモ保存エラー:", error)
    return NextResponse.json({ error: "支払いメモの保存に失敗しました" }, { status: 500 })
  }
}
