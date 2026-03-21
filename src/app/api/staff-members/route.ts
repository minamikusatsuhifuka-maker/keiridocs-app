import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// スタッフ一覧取得
export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const { data, error } = await supabase
      .from("staff_members")
      .select("id, name")
      .order("created_at", { ascending: true })

    if (error) throw error

    return NextResponse.json({ data })
  } catch (error) {
    console.error("スタッフ一覧取得エラー:", error)
    return NextResponse.json(
      { error: "スタッフ一覧の取得に失敗しました" },
      { status: 500 }
    )
  }
}
