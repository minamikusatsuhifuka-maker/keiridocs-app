import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"

/**
 * ログインできるメールアドレスの管理。
 *
 * GET    一覧
 * POST   追加 { email, display_name?, note? }
 * DELETE 削除 ?id=...
 *
 * 一覧はサービスロールで取得する（RLSでは自分の行しか見えないため）。
 * 自分自身は削除できないようにしている（締め出しの防止）。
 */

export const maxDuration = 60

interface AllowedEmailRow {
  id: string
  email: string
  display_name: string | null
  note: string | null
  created_at: string
  created_by: string | null
}

/**
 * allowed_emails は migration 047 で追加するテーブルで、
 * 自動生成の型定義（types/database.ts）にはまだ含まれていない。
 * 型を再生成するまでは型なしのクライアントで扱う。
 */
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Supabaseの接続情報が設定されていません")
  return createClient(url, key)
}

/** migration 047 未適用のときに分かりやすく案内する */
function migrationError(message: string): boolean {
  return /allowed_emails/.test(message) || /42P01/.test(message)
}

async function requireUser() {
  const supabase = await createAuthClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  try {
    const service = createServiceClient()
    const { data, error } = await service
      .from("allowed_emails")
      .select("id, email, display_name, note, created_at, created_by")
      .order("created_at", { ascending: true })
    if (error) {
      if (migrationError(error.message)) {
        return NextResponse.json(
          { error: "許可リストが未適用です。migration 047_allowed_logins.sql を実行してください。" },
          { status: 409 }
        )
      }
      throw new Error(error.message)
    }
    return NextResponse.json({
      data: (data ?? []) as unknown as AllowedEmailRow[],
      currentEmail: user.email?.toLowerCase() ?? "",
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "取得できませんでした" },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  try {
    const body = (await request.json()) as {
      email?: string
      display_name?: string
      note?: string
    }
    // Googleアカウントの大文字小文字の違いを吸収するため小文字で保存する
    const email = (body.email ?? "").trim().toLowerCase()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "メールアドレスの形式が正しくありません" }, { status: 400 })
    }

    const service = createServiceClient()
    const { data, error } = await service
      .from("allowed_emails")
      .insert({
        email,
        display_name: body.display_name?.trim() || null,
        note: body.note?.trim() || null,
        created_by: user.email ?? null,
      })
      .select("id, email, display_name, note, created_at, created_by")
      .single()

    if (error) {
      if (/duplicate key|unique/i.test(error.message)) {
        return NextResponse.json({ error: "このメールアドレスは登録済みです" }, { status: 409 })
      }
      if (migrationError(error.message)) {
        return NextResponse.json(
          { error: "許可リストが未適用です。migration 047_allowed_logins.sql を実行してください。" },
          { status: 409 }
        )
      }
      throw new Error(error.message)
    }
    return NextResponse.json({ data })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "追加できませんでした" },
      { status: 500 }
    )
  }
}

export async function DELETE(request: Request) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  try {
    const id = new URL(request.url).searchParams.get("id")
    if (!id) return NextResponse.json({ error: "IDが指定されていません" }, { status: 400 })

    const service = createServiceClient()
    const { data: row } = await service
      .from("allowed_emails")
      .select("email")
      .eq("id", id)
      .maybeSingle()

    // 自分自身を消すと、次のアクセスからログインできなくなる
    const target = (row as { email?: string } | null)?.email?.toLowerCase()
    if (target && target === (user.email ?? "").toLowerCase()) {
      return NextResponse.json(
        { error: "ご自身のアドレスは削除できません（ログインできなくなるため）" },
        { status: 400 }
      )
    }

    const { error } = await service.from("allowed_emails").delete().eq("id", id)
    if (error) throw new Error(error.message)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "削除できませんでした" },
      { status: 500 }
    )
  }
}
