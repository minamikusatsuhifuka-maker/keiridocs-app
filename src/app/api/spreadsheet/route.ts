import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"

/** スプレッドシート行の型 */
interface SpreadsheetRow {
  document_id: string
  date: string | null
  type: string
  vendor: string
  item_name: string
  quantity: number | null
  unit_price: number | null
  amount: number
  category: string
  tax_category: string
  account_title: string
}

/** 集計結果の型 */
interface Summary {
  total: number
  by_category: Record<string, number>
  by_tax: Record<string, number>
  by_account: Record<string, number>
  by_vendor: Record<string, number>
}

/**
 * スプレッドシート用データ取得API
 * 書類＋明細データを結合して返す
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const auth = await getCurrentUserRole()
  const isAdminUser = auth?.role === "admin"

  const { searchParams } = new URL(request.url)
  const startDate = searchParams.get("start_date")
  const endDate = searchParams.get("end_date")
  const type = searchParams.get("type")
  const category = searchParams.get("category")
  const vendor = searchParams.get("vendor")

  try {
    // 1. 書類データを取得
    let docQuery = supabase
      .from("documents")
      .select("id, type, vendor_name, amount, issue_date, due_date, tax_category, account_title, description, created_at")
      .order("issue_date", { ascending: false, nullsFirst: false })

    if (!isAdminUser) {
      docQuery = docQuery.eq("user_id", user.id)
    }

    if (startDate) {
      docQuery = docQuery.gte("issue_date", startDate)
    }
    if (endDate) {
      docQuery = docQuery.lte("issue_date", endDate)
    }
    if (type) {
      docQuery = docQuery.eq("type", type)
    }
    if (vendor) {
      docQuery = docQuery.ilike("vendor_name", `%${vendor}%`)
    }

    const { data: documents, error: docError } = await docQuery

    if (docError) {
      console.error("書類取得エラー:", docError)
      return NextResponse.json({ error: "書類の取得に失敗しました" }, { status: 500 })
    }

    if (!documents || documents.length === 0) {
      return NextResponse.json({
        items: [],
        summary: { total: 0, by_category: {}, by_tax: {}, by_account: {}, by_vendor: {} },
      })
    }

    const docIds = documents.map((d) => d.id)

    // 2. 明細データを取得
    let itemQuery = supabase
      .from("document_items")
      .select("document_id, item_name, quantity, unit_price, amount, category, tax_rate")
      .in("document_id", docIds)

    if (!isAdminUser) {
      itemQuery = itemQuery.eq("user_id", user.id)
    }

    const { data: itemsData, error: itemError } = await itemQuery

    // document_itemsテーブルが存在しない場合はフォールバック
    const items: Array<{
      document_id: string
      item_name: string
      quantity: number | null
      unit_price: number | null
      amount: number
      category: string
      tax_rate: string
    }> = []

    if (itemError) {
      console.warn("明細データ取得エラー（テーブル未作成の可能性）:", itemError.message)
    } else if (itemsData) {
      for (const item of itemsData) {
        items.push({
          document_id: item.document_id,
          item_name: item.item_name,
          quantity: item.quantity,
          unit_price: item.unit_price,
          amount: item.amount,
          category: item.category,
          tax_rate: item.tax_rate,
        })
      }
    }

    // 3. 書類と明細を結合
    const itemsByDocId = new Map<string, typeof items>()
    for (const item of items) {
      if (!itemsByDocId.has(item.document_id)) {
        itemsByDocId.set(item.document_id, [])
      }
      itemsByDocId.get(item.document_id)!.push(item)
    }

    const rows: SpreadsheetRow[] = []

    for (const doc of documents) {
      const docItems = itemsByDocId.get(doc.id)

      if (docItems && docItems.length > 0) {
        // 明細がある場合は各行を出力
        for (const item of docItems) {
          rows.push({
            document_id: doc.id,
            date: doc.issue_date,
            type: doc.type,
            vendor: doc.vendor_name,
            item_name: item.item_name,
            quantity: item.quantity,
            unit_price: item.unit_price,
            amount: item.amount,
            category: item.category,
            tax_category: item.tax_rate || doc.tax_category || "未判定",
            account_title: doc.account_title || "",
          })
        }
      } else {
        // 明細がない場合は書類自体を1行として出力
        rows.push({
          document_id: doc.id,
          date: doc.issue_date,
          type: doc.type,
          vendor: doc.vendor_name,
          item_name: doc.description || "(明細なし)",
          quantity: null,
          unit_price: null,
          amount: doc.amount ?? 0,
          category: "その他",
          tax_category: doc.tax_category || "未判定",
          account_title: doc.account_title || "",
        })
      }
    }

    // カテゴリフィルター適用
    const filteredRows = category
      ? rows.filter((r) => r.category === category)
      : rows

    // 4. 集計
    const summary: Summary = {
      total: 0,
      by_category: {},
      by_tax: {},
      by_account: {},
      by_vendor: {},
    }

    for (const row of filteredRows) {
      summary.total += row.amount

      const cat = row.category || "その他"
      summary.by_category[cat] = (summary.by_category[cat] || 0) + row.amount

      const tax = row.tax_category || "未判定"
      summary.by_tax[tax] = (summary.by_tax[tax] || 0) + row.amount

      const acc = row.account_title || "未分類"
      summary.by_account[acc] = (summary.by_account[acc] || 0) + row.amount

      summary.by_vendor[row.vendor] = (summary.by_vendor[row.vendor] || 0) + row.amount
    }

    return NextResponse.json({ items: filteredRows, summary })
  } catch (error) {
    console.error("スプレッドシートデータ取得エラー:", error)
    return NextResponse.json({ error: "データの取得に失敗しました" }, { status: 500 })
  }
}
