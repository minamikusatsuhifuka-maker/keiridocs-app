import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import type { Database } from "@/types/database"

type DocumentRow = Database["public"]["Tables"]["documents"]["Row"]

/** 重複グループの型 */
interface DuplicateGroup {
  key: string
  vendor_name: string
  amount: number | null
  type: string
  documents: Pick<DocumentRow, "id" | "vendor_name" | "amount" | "type" | "issue_date" | "due_date" | "dropbox_path" | "created_at">[]
}

/**
 * 重複候補を検索するAPI
 * vendor_name, amount, type でグループ化し、2件以上あるグループを返す
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  // 権限チェック: admin or staff のみ実行可
  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "実行権限がありません" }, { status: 403 })
  }

  try {
    // 全書類を取得（adminは全件、staffは自分のみ）
    let query = supabase
      .from("documents")
      .select("id, vendor_name, amount, type, issue_date, due_date, dropbox_path, created_at")
      .order("created_at", { ascending: false })

    if (auth.role !== "admin") {
      query = query.eq("user_id", user.id)
    }

    const { data: documents, error } = await query

    if (error) {
      console.error("重複チェック用書類取得エラー:", error)
      return NextResponse.json({ error: "書類の取得に失敗しました" }, { status: 500 })
    }

    if (!documents || documents.length === 0) {
      return NextResponse.json({ data: [] })
    }

    // vendor_name + amount + type でグループ化
    const groups = new Map<string, DuplicateGroup>()

    for (const doc of documents) {
      const key = `${doc.vendor_name}|${doc.amount ?? "null"}|${doc.type}`

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          vendor_name: doc.vendor_name,
          amount: doc.amount,
          type: doc.type,
          documents: [],
        })
      }

      groups.get(key)!.documents.push(doc)
    }

    // 2件以上あるグループのみ返す
    const duplicates = Array.from(groups.values()).filter((g) => g.documents.length >= 2)

    return NextResponse.json({ data: duplicates })
  } catch (error) {
    console.error("重複検知エラー:", error)
    return NextResponse.json({ error: "重複検知に失敗しました" }, { status: 500 })
  }
}
