import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { fetchAllRows } from "@/lib/supabase/fetch-all"
import { COURSE_KIND_LABELS, type CourseKind, type CourseRule } from "@/lib/subsidy-rules"
import type { Database } from "@/types/database"

/**
 * 講座マスタ（courses）のCRUD。
 *
 * 講座には区分（apex / ach_other / non_ach）を紐づける。
 * スタッフは申請時に講座名を1タップ選ぶだけでよく、支給率と上限は区分から自動で決まる。
 * 30,000円の上限は「講座1件ごと」に判定するため、講座を同じものとして束ねる台帳が必要。
 *
 *   GET    /api/courses            一覧（?all=1 で無効分も含む）
 *   POST   /api/courses            追加 { name, kind, note? }
 *   PATCH  /api/courses            更新 { id, name?, kind?, is_active?, note? }
 *   DELETE /api/courses?id=...     削除（申請が紐づいている講座は拒否）
 */

const VALID_KINDS: CourseKind[] = ["apex", "ach_other", "jpsa", "exam", "non_ach"]
const VALID_RULES: CourseRule[] = ["full", "atc", "undecided"]

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Supabaseの接続情報が設定されていません")
  return createClient<Database>(url, key)
}

/** 認証（参照は認証済みなら可、更新は admin / staff のみ） */
async function requireAuth(write: boolean) {
  const authSupabase = await createAuthClient()
  const {
    data: { user },
    error,
  } = await authSupabase.auth.getUser()
  if (error || !user) return { error: NextResponse.json({ error: "認証が必要です" }, { status: 401 }) }
  if (write) {
    const auth = await getCurrentUserRole()
    if (auth?.role !== "admin" && auth?.role !== "staff") {
      return { error: NextResponse.json({ error: "変更権限がありません" }, { status: 403 }) }
    }
  }
  return { user }
}

/** migration 044 が未適用かどうかを判定する */
function isMissingTable(message: string): boolean {
  return /courses|relation|does not exist|42P01|PGRST205/i.test(message)
}

const NOT_READY = NextResponse.json(
  {
    error:
      "講座マスタのDB更新（044_phase2_courses_and_caps.sql）がまだ実行されていません。Supabase の SQL Editor で実行してください。",
  },
  { status: 409 }
)

export async function GET(request: NextRequest) {
  const auth = await requireAuth(false)
  if (auth.error) return auth.error

  const includeInactive = new URL(request.url).searchParams.get("all") === "1"

  try {
    const supabase = createServiceClient()
    const rows = await fetchAllRows<{
      id: string
      name: string
      kind: string
      rule: string
      is_active: boolean
      note: string | null
      created_at: string
    }>((from, to) => {
      const q = supabase.from("courses").select("id, name, kind, rule, is_active, note, created_at")
      const scoped = includeInactive ? q : q.eq("is_active", true)
      return scoped.order("id", { ascending: true }).range(from, to) as unknown as PromiseLike<{
        data: {
          id: string
          name: string
          kind: string
          rule: string
          is_active: boolean
          note: string | null
          created_at: string
        }[] | null
        error: { message: string } | null
      }>
    })

    // 講座ごとの申請件数（削除可否の判断と、担当が使用状況を見るため）
    const txRows = await fetchAllRows<{ course_id: string | null }>((from, to) =>
      supabase
        .from("petty_cash_transactions")
        .select("course_id")
        .eq("category", "staff_refund")
        .not("course_id", "is", null)
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
          data: { course_id: string | null }[] | null
          error: { message: string } | null
        }>
    )
    const useCount = new Map<string, number>()
    for (const t of txRows) {
      if (t.course_id) useCount.set(t.course_id, (useCount.get(t.course_id) ?? 0) + 1)
    }

    return NextResponse.json({
      courses: rows
        .map((c) => ({
          ...c,
          kindLabel: COURSE_KIND_LABELS[c.kind as CourseKind] ?? c.kind,
          useCount: useCount.get(c.id) ?? 0,
        }))
        // 新しい講座が上に来るようにする（直近のものを選びやすい）
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "講座マスタを取得できませんでした"
    if (isMissingTable(message)) return NOT_READY
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(true)
  if (auth.error) return auth.error

  let body: { name?: unknown; kind?: unknown; rule?: unknown; note?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 })
  }

  const name = typeof body.name === "string" ? body.name.trim() : ""
  const kind = VALID_KINDS.find((k) => k === body.kind)
  if (!name) return NextResponse.json({ error: "講座名を入力してください" }, { status: 400 })
  if (!kind) return NextResponse.json({ error: "分類を選んでください" }, { status: 400 })
  // 未指定は undecided（未定）にする。推測で支給率を決めないため
  const rule = VALID_RULES.find((r) => r === body.rule) ?? "undecided"

  try {
    const supabase = createServiceClient()

    // 同名の講座は上限の合算が分かれてしまうため重複を防ぐ
    const { data: existing } = await supabase.from("courses").select("id").eq("name", name).limit(1)
    if (existing && existing.length > 0) {
      return NextResponse.json(
        { error: `「${name}」は既に登録されています。同名の講座を作ると上限の合算が分かれてしまいます。` },
        { status: 409 }
      )
    }

    const { data, error } = await supabase
      .from("courses")
      .insert({
        name,
        kind,
        rule,
        note: typeof body.note === "string" ? body.note.trim() || null : null,
      })
      .select("*")
      .single()
    if (error) throw new Error(error.message)

    return NextResponse.json({ course: data })
  } catch (e) {
    const message = e instanceof Error ? e.message : "講座を追加できませんでした"
    if (isMissingTable(message)) return NOT_READY
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAuth(true)
  if (auth.error) return auth.error

  let body: {
    id?: unknown
    name?: unknown
    kind?: unknown
    rule?: unknown
    is_active?: unknown
    note?: unknown
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 })
  }

  const id = typeof body.id === "string" ? body.id : ""
  if (!id) return NextResponse.json({ error: "IDは必須です" }, { status: 400 })

  const patch: Record<string, unknown> = {}
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim()
  if (body.kind !== undefined) {
    const kind = VALID_KINDS.find((k) => k === body.kind)
    if (!kind) return NextResponse.json({ error: "区分の指定が不正です" }, { status: 400 })
    patch.kind = kind
  }
  if (body.rule !== undefined) {
    const rule = VALID_RULES.find((r) => r === body.rule)
    if (!rule) return NextResponse.json({ error: "支給率の方式の指定が不正です" }, { status: 400 })
    patch.rule = rule
  }
  if (typeof body.is_active === "boolean") patch.is_active = body.is_active
  if (typeof body.note === "string") patch.note = body.note.trim() || null

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "変更内容がありません" }, { status: 400 })
  }

  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase.from("courses").update(patch).eq("id", id).select("*").single()
    if (error) throw new Error(error.message)
    return NextResponse.json({ course: data })
  } catch (e) {
    const message = e instanceof Error ? e.message : "講座を更新できませんでした"
    if (isMissingTable(message)) return NOT_READY
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(true)
  if (auth.error) return auth.error

  const id = new URL(request.url).searchParams.get("id")
  if (!id) return NextResponse.json({ error: "IDは必須です" }, { status: 400 })

  try {
    const supabase = createServiceClient()

    // 申請が紐づいている講座は削除できない（course_id が外れて上限の合算が壊れる）
    const { count } = await supabase
      .from("petty_cash_transactions")
      .select("id", { count: "exact", head: true })
      .eq("course_id", id)
    if ((count ?? 0) > 0) {
      return NextResponse.json(
        {
          error:
            `この講座には申請が ${count} 件あるため削除できません。` +
            `終了した講座は「選択肢に出す」をOFFにしてください（過去の申請は残ります）。`,
        },
        { status: 409 }
      )
    }

    const { error } = await supabase.from("courses").delete().eq("id", id)
    if (error) throw new Error(error.message)
    return NextResponse.json({ ok: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : "講座を削除できませんでした"
    if (isMissingTable(message)) return NOT_READY
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
