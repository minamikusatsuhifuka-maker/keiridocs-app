import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { uploadFile, deleteFile } from "@/lib/dropbox"
import { analyzeBusinessCard } from "@/lib/gemini"
import type { Database } from "@/types/database"

type BusinessCardRow = Database["public"]["Tables"]["business_cards"]["Row"]

/** Vercel関数のタイムアウトを60秒に延長（Gemini + Dropbox処理対策） */
export const maxDuration = 60

/** ファイル名に使えない文字を "_" に置換 */
function sanitizeFileName(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, "_").trim() || "unknown"
}

/** 6桁のランダム文字列 */
function random6(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0")
}

/** YYYYMMDD形式の日付 */
function todayYmd(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}${m}${day}`
}

/* ---------- GET: 一覧取得（会社名・氏名で検索） ---------- */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const company = request.nextUrl.searchParams.get("company_name")?.trim() || ""
  const name = request.nextUrl.searchParams.get("name")?.trim() || ""
  const q = request.nextUrl.searchParams.get("q")?.trim() || ""

  let query = supabase
    .from("business_cards")
    .select("*")
    .order("created_at", { ascending: false })

  if (q) {
    query = query.or(
      `company_name.ilike.%${q}%,name.ilike.%${q}%,department.ilike.%${q}%,title.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%,mobile.ilike.%${q}%`
    )
  } else {
    if (company) query = query.ilike("company_name", `%${company}%`)
    if (name) query = query.ilike("name", `%${name}%`)
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: (data || []) as BusinessCardRow[] })
}

/* ---------- POST: 画像/PDF受取→Gemini解析→Dropbox保存→DB保存 ---------- */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const formData = await request.formData()
    const file = formData.get("file")
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "ファイルが必要です" }, { status: 400 })
    }

    if (file.size === 0) {
      return NextResponse.json({ error: "空のファイルです" }, { status: 400 })
    }

    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: "ファイルサイズは10MB以下にしてください" }, { status: 400 })
    }

    const mimeType = file.type || "image/jpeg"
    const allowed = ["image/jpeg", "image/jpg", "image/png", "application/pdf"]
    if (!allowed.includes(mimeType)) {
      return NextResponse.json({ error: "JPG/PNG/PDFのみ対応しています" }, { status: 400 })
    }

    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    const base64 = buffer.toString("base64")

    // 1. Gemini AI解析
    const ocr = await analyzeBusinessCard(base64, mimeType)

    // 2. ファイル名・パス生成
    const ext = mimeType === "application/pdf" ? "pdf" : mimeType === "image/png" ? "png" : "jpg"
    const safeCompany = sanitizeFileName(ocr.company_name || "未分類")
    const safeName = sanitizeFileName(ocr.name || "不明")
    const fileName = `${safeName}_${todayYmd()}_${random6()}.${ext}`
    const dropboxPath = `/経理書類/名刺/${safeCompany}/${fileName}`

    // 3. Dropboxにアップロード
    const resultPath = await uploadFile(dropboxPath, buffer)

    // 4. DB保存
    const { data, error } = await supabase
      .from("business_cards")
      .insert({
        company_name: ocr.company_name || null,
        department: ocr.department || null,
        name: ocr.name || null,
        title: ocr.title || null,
        email: ocr.email || null,
        phone: ocr.phone || null,
        mobile: ocr.mobile || null,
        address: ocr.address || null,
        website: ocr.website || null,
        memo: null,
        dropbox_path: resultPath,
        file_name: fileName,
      })
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data, ocr })
  } catch (error) {
    console.error("名刺登録エラー:", error)
    const msg = error instanceof Error ? error.message : "名刺登録に失敗しました"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/* ---------- PUT: 名刺情報更新 ---------- */
export async function PUT(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const body = await request.json() as {
    id: string
    company_name?: string | null
    department?: string | null
    name?: string | null
    title?: string | null
    email?: string | null
    phone?: string | null
    mobile?: string | null
    address?: string | null
    website?: string | null
    memo?: string | null
  }

  if (!body.id) {
    return NextResponse.json({ error: "IDが必要です" }, { status: 400 })
  }

  const updateData: Record<string, unknown> = {}
  const keys = [
    "company_name", "department", "name", "title",
    "email", "phone", "mobile", "address", "website", "memo",
  ] as const
  for (const key of keys) {
    if (body[key] !== undefined) updateData[key] = body[key]
  }

  const { data, error } = await supabase
    .from("business_cards")
    .update(updateData)
    .eq("id", body.id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}

/* ---------- DELETE: DB + Dropbox連動削除 ---------- */
export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const id = request.nextUrl.searchParams.get("id")
  if (!id) {
    return NextResponse.json({ error: "IDが必要です" }, { status: 400 })
  }

  // 削除前にDropboxパスを取得
  const { data: card, error: fetchError } = await supabase
    .from("business_cards")
    .select("dropbox_path")
    .eq("id", id)
    .single()

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 })
  }

  // DB削除
  const { error: deleteError } = await supabase
    .from("business_cards")
    .delete()
    .eq("id", id)

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 })
  }

  // Dropbox削除（失敗してもDB削除は成功扱い）
  if (card?.dropbox_path) {
    try {
      await deleteFile(card.dropbox_path)
    } catch (error) {
      console.warn("Dropbox削除失敗（DBは削除済み）:", error)
    }
  }

  return NextResponse.json({ success: true })
}
