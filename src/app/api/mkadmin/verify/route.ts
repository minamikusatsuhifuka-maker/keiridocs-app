import { NextRequest, NextResponse } from "next/server"

// 管理画面（/mkadmin）パスワード検証
// MKADMIN_PASSWORD が未設定の場合は既存の LINE_STAFF_PASSWORD にフォールバック
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { password?: string }
    const password = body.password ?? ""
    const correctPassword =
      process.env.MKADMIN_PASSWORD ?? process.env.LINE_STAFF_PASSWORD ?? "admin1234"

    if (password === correctPassword) {
      console.log("管理画面(/mkadmin): パスワード認証成功")
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ ok: false, error: "パスワードが違います" }, { status: 401 })
  } catch {
    return NextResponse.json({ ok: false, error: "認証に失敗しました" }, { status: 500 })
  }
}
