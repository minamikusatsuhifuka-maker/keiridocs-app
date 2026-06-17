import { NextRequest, NextResponse } from "next/server"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { dedupKey } from "@/lib/payment-memo-dedup"

// 保存前の重複チェック（ソフト方式・ブロックはしない）
// POST /api/payment-memos/check-duplicates
//   body: { items: [{ vendor_name, amount }, ...] }
//   返り値: { duplicates: [{ index, vendor_name, amount }] } 既存と重複する抽出項目
export async function POST(request: NextRequest) {
  const supabase = await createAuthClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  let body: { items?: unknown }
  try {
    body = (await request.json()) as { items?: unknown }
  } catch {
    return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 })
  }

  const items = Array.isArray(body.items) ? body.items : []

  try {
    // 既存の payment_memo_items を全件取得し、重複キーの集合を作る
    // （SELECTは既存RLSで全員可。anonキーの認証クライアントで読める）
    const { data: existingRaw, error } = await supabase
      .from("payment_memo_items")
      .select("vendor_name, amount")
    if (error) throw error

    const existingKeys = new Set<string>()
    for (const row of existingRaw || []) {
      const key = dedupKey(row.vendor_name, row.amount)
      if (key) existingKeys.add(key)
    }

    // 抽出項目のうち、既存と重複するものを名指しで返す
    const duplicates: Array<{ index: number; vendor_name: string; amount: number | null }> = []
    items.forEach((raw, index) => {
      if (raw && typeof raw === "object") {
        const it = raw as { vendor_name?: unknown; amount?: unknown }
        const vendorName = typeof it.vendor_name === "string" ? it.vendor_name : null
        const amount = typeof it.amount === "number" ? it.amount : null
        const key = dedupKey(vendorName, amount)
        if (key && existingKeys.has(key)) {
          duplicates.push({ index, vendor_name: vendorName || "", amount })
        }
      }
    })

    return NextResponse.json({ duplicates })
  } catch (error) {
    console.error("支払いメモ重複チェックエラー:", error)
    return NextResponse.json({ error: "重複チェックに失敗しました" }, { status: 500 })
  }
}
