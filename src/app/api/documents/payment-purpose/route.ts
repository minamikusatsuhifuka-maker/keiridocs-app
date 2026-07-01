import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/staff-refund-core"
import { getCurrentUserRole } from "@/lib/auth"
import { summarizePaymentPurpose, type PaymentPurposeInput } from "@/lib/gemini"

export const runtime = "nodejs"
export const maxDuration = 300

/** 1リクエストで生成する最大件数（レート制限・実行時間の上限対策） */
const MAX_BATCH = 60

interface DocRow {
  id: string
  vendor_name: string | null
  type: string | null
  amount: number | null
  description: string | null
  account_title: string | null
  ocr_raw: unknown
  payment_purpose: string | null
  user_id: string
}

/** ocr_raw から品目名を安全に取り出す */
function extractItems(ocrRaw: unknown): PaymentPurposeInput["items"] {
  if (!ocrRaw || typeof ocrRaw !== "object") return []
  const items = (ocrRaw as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  return items
    .map((it) => {
      if (!it || typeof it !== "object") return null
      const rec = it as Record<string, unknown>
      return {
        item_name: typeof rec.item_name === "string" ? rec.item_name : null,
        category: typeof rec.category === "string" ? rec.category : null,
      }
    })
    .filter((v): v is { item_name: string | null; category: string | null } => v !== null)
}

/**
 * 支払い内容（AI要約）を未生成の書類に対して生成・保存する（バックフィル / 遅延生成）。
 *
 * リクエスト: { ids?: string[], limit?: number }
 *   - ids 指定時: そのidのうち payment_purpose が未生成(NULL)のものを対象
 *   - ids 未指定: payment_purpose が未生成(NULL)の書類を limit 件まで対象
 * レスポンス: { results: {id, payment_purpose}[], remaining: number }
 *
 * 判定不能・失敗時は空文字('')を保存して以降の再生成を防ぐ（NULL=未生成 と区別）。
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "権限がありません" }, { status: 403 })
  }
  const isAdmin = auth.role === "admin"

  try {
    const body = (await request.json().catch(() => ({}))) as {
      ids?: unknown
      limit?: unknown
    }
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((v): v is string => typeof v === "string")
      : null
    const limitRaw = typeof body.limit === "number" ? body.limit : Number(body.limit)
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_BATCH) : MAX_BATCH

    // 対象書類を取得（payment_purpose が未生成=NULL のもの）
    let query = supabase
      .from("documents")
      .select("id, vendor_name, type, amount, description, account_title, ocr_raw, payment_purpose, user_id")
      .is("payment_purpose", null)

    if (!isAdmin) {
      query = query.eq("user_id", user.id)
    }
    if (ids && ids.length > 0) {
      query = query.in("id", ids)
    }
    query = query.limit(limit)

    const { data, error } = await query
    if (error) {
      console.error("支払い内容 対象取得エラー:", error)
      return NextResponse.json({ error: "対象書類の取得に失敗しました" }, { status: 500 })
    }

    const targets = (data ?? []) as DocRow[]
    const service = createServiceClient()
    const results: Array<{ id: string; payment_purpose: string }> = []

    for (const doc of targets) {
      const purpose = await summarizePaymentPurpose({
        vendor_name: doc.vendor_name,
        type: doc.type,
        amount: doc.amount,
        description: doc.description,
        account_title: doc.account_title,
        items: extractItems(doc.ocr_raw),
      })

      // 判定不能でも '' を保存し、以降の再生成を防ぐ
      const { error: updateError } = await service
        .from("documents")
        .update({ payment_purpose: purpose })
        .eq("id", doc.id)

      if (updateError) {
        console.error(`支払い内容 保存エラー (${doc.id}):`, updateError)
        continue
      }
      results.push({ id: doc.id, payment_purpose: purpose })
      // Gemini レート制限対策
      await new Promise((resolve) => setTimeout(resolve, 80))
    }

    // 残りの未生成件数（この範囲で処理しきれなかった分の目安）
    let remainingQuery = supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .is("payment_purpose", null)
    if (!isAdmin) {
      remainingQuery = remainingQuery.eq("user_id", user.id)
    }
    if (ids && ids.length > 0) {
      remainingQuery = remainingQuery.in("id", ids)
    }
    const { count: remaining } = await remainingQuery

    return NextResponse.json({ results, remaining: remaining ?? 0 })
  } catch (error) {
    console.error("支払い内容 生成エラー:", error)
    return NextResponse.json({ error: "支払い内容の生成に失敗しました" }, { status: 500 })
  }
}
