import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { readPayEasy, withPayEasyEntries, withPayEasyPaid, type PayEasyEntry } from "@/lib/payeasy"
import type { Json } from "@/types/database"

/**
 * Pay-easy 納付の更新 API
 * PATCH /api/documents/[id]/payeasy
 *
 *   { index: 0, paid: true }        … 1組目を納付済みにする（false で未納付に戻す）
 *   { entries: [...] }              … 読み取れなかった番号を担当が手で入力する
 *
 * ■ 納付書は2枚（税金分・手数料分）
 * 銀行の画面では1回ずつ分けて操作するため、納付済みの記録も1組ずつ持つ。
 *
 * ■ 保存先
 * documents.ocr_raw の中（payeasy）。DBの列は増やしていない。
 * 解析結果の他の項目は残したまま、payeasy だけを差し替える。
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "編集権限がありません" }, { status: 403 })
  }

  let body: { index?: unknown; paid?: unknown; entries?: unknown }
  try {
    body = (await request.json()) as { index?: unknown; paid?: unknown; entries?: unknown }
  } catch {
    return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 })
  }

  const { data: doc, error: readError } = await supabase
    .from("documents")
    .select("id, ocr_raw")
    .eq("id", id)
    .maybeSingle()
  if (readError) {
    return NextResponse.json({ error: readError.message }, { status: 500 })
  }
  if (!doc) {
    return NextResponse.json({ error: "書類が見つかりません" }, { status: 404 })
  }

  const current = (doc as { ocr_raw: unknown }).ocr_raw
  let next: unknown

  if (Array.isArray(body.entries)) {
    // 手入力。納付済みの印は引き継ぐ（入力し直しても納付の記録を失わない）
    const existing = readPayEasy(current)
    const entries: PayEasyEntry[] = []
    for (const [i, row] of body.entries.entries()) {
      if (!row || typeof row !== "object") continue
      const r = row as Record<string, unknown>
      const str = (v: unknown) => (typeof v === "string" ? v : "")
      entries.push({
        kind: str(r.kind) || existing[i]?.kind || "納付",
        institution_code: str(r.institution_code),
        customer_number: str(r.customer_number),
        confirmation_number: str(r.confirmation_number),
        amount: typeof r.amount === "number" ? r.amount : (existing[i]?.amount ?? null),
        due_date: str(r.due_date) || existing[i]?.due_date || null,
        declaration_number: str(r.declaration_number) || existing[i]?.declaration_number || null,
        note: str(r.note) || existing[i]?.note || null,
        manual: true,
        paid_at: existing[i]?.paid_at ?? null,
      })
    }
    if (entries.length === 0) {
      return NextResponse.json({ error: "入力された番号がありません" }, { status: 400 })
    }
    next = withPayEasyEntries(current, entries)
  } else if (typeof body.index === "number" && typeof body.paid === "boolean") {
    const entries = readPayEasy(current)
    if (body.index < 0 || body.index >= entries.length) {
      return NextResponse.json({ error: "対象の納付が見つかりません" }, { status: 400 })
    }
    next = withPayEasyPaid(current, body.index, body.paid)
  } else {
    return NextResponse.json({ error: "操作が指定されていません" }, { status: 400 })
  }

  const { error: updateError } = await supabase
    .from("documents")
    .update({ ocr_raw: next as Json })
    .eq("id", id)
  if (updateError) {
    console.error("Pay-easy の保存エラー:", updateError.message)
    return NextResponse.json({ error: "保存できませんでした" }, { status: 500 })
  }

  return NextResponse.json({ ok: true, ocr_raw: next })
}
