import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { fileExists, uploadFileOverwrite } from "@/lib/dropbox"

/** アップロードはDropbox往復があるため余裕を持たせる */
export const maxDuration = 120

/** 再アップロードで許可する拡張子・MIME（CLAUDE.md準拠: JPG/JPEG/PNG/PDF） */
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "application/pdf",
])
const MAX_SIZE = 10 * 1024 * 1024 // 10MB

/** 対象書類を権限込みで取得する（admin=全件 / staff=自分のみ） */
async function fetchDoc(
  supabase: Awaited<ReturnType<typeof createClient>>,
  id: string,
  role: string,
  userId: string
) {
  let q = supabase
    .from("documents")
    .select("id, dropbox_path")
    .eq("id", id)
  if (role !== "admin") q = q.eq("user_id", userId)
  return q.single()
}

/**
 * GET /api/documents/[id]/reupload
 * 対象書類のDropbox実ファイルが存在するかを確認する（メタデータ確認のみ・軽量）。
 * レスポンス: { exists: boolean, dropbox_path: string | null }
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }
  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "権限がありません" }, { status: 403 })
  }

  const { data: doc, error: fetchError } = await fetchDoc(supabase, id, auth.role, user.id)
  if (fetchError || !doc) {
    return NextResponse.json({ error: "書類が見つかりません" }, { status: 404 })
  }

  // dropbox_path が無ければファイル無しとして扱う
  if (!doc.dropbox_path) {
    return NextResponse.json({ exists: false, dropbox_path: null })
  }

  const exists = await fileExists(doc.dropbox_path)
  return NextResponse.json({ exists, dropbox_path: doc.dropbox_path })
}

/**
 * POST /api/documents/[id]/reupload
 * multipart/form-data でファイルを受け取り、DBの dropbox_path と同じパスに
 * overwrite アップロードする（autorename は使わない＝パスを変えずDB整合を維持）。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }
  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "アップロード権限がありません" }, { status: 403 })
  }

  const { data: doc, error: fetchError } = await fetchDoc(supabase, id, auth.role, user.id)
  if (fetchError || !doc) {
    return NextResponse.json({ error: "書類が見つかりません" }, { status: 404 })
  }
  if (!doc.dropbox_path) {
    return NextResponse.json(
      { error: "この書類にはDropboxパスが設定されていないため再アップロードできません" },
      { status: 400 }
    )
  }

  // フォームからファイルを取得
  let file: File | null = null
  try {
    const form = await request.formData()
    const f = form.get("file")
    if (f instanceof File) file = f
  } catch {
    return NextResponse.json({ error: "ファイルの受信に失敗しました" }, { status: 400 })
  }
  if (!file) {
    return NextResponse.json({ error: "ファイルが指定されていません" }, { status: 400 })
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "ファイルが空です" }, { status: 400 })
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "ファイルサイズが大きすぎます（最大10MB）" }, { status: 400 })
  }
  if (file.type && !ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      { error: "対応していない形式です（JPG / PNG / PDF のみ）" },
      { status: 400 }
    )
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    // DBと同じパスに上書きアップロード（autorenameなし＝パス不変）
    const uploadedPath = await uploadFileOverwrite(doc.dropbox_path, buffer)
    return NextResponse.json({ success: true, dropbox_path: uploadedPath })
  } catch (error) {
    console.error("再アップロード失敗:", error)
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: `再アップロードに失敗しました: ${msg}` }, { status: 500 })
  }
}
