import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { downloadFile, DropboxFileNotFoundError } from "@/lib/dropbox"

/**
 * 書類の登録資料（Dropbox実ファイル）を提供するAPI。
 *
 * GET /api/documents/[id]/file
 *   → Dropboxに保存されたファイルのバイト列を返す（一覧のプレビューモーダル用）
 *
 * セキュリティ:
 *   - Supabase認証必須（admin以外は自分の書類のみ）
 *   - クライアントから任意パスを受け取らず、id から documents.dropbox_path を引く
 */

/** 拡張子からプレビュー用の Content-Type を決める（Dropboxの応答は octet-stream になりがちなため） */
function contentTypeFromPath(path: string, fallback: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "png":
      return "image/png"
    case "pdf":
      return "application/pdf"
    default:
      return fallback
  }
}

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

  // id から Dropboxパスを引く（admin以外は自分の書類のみ）
  const auth = await getCurrentUserRole()
  let query = supabase.from("documents").select("dropbox_path").eq("id", id)
  if (auth?.role !== "admin") {
    query = query.eq("user_id", user.id)
  }
  const { data: doc, error: queryError } = await query.maybeSingle()

  if (queryError || !doc?.dropbox_path) {
    return NextResponse.json({ error: "資料が見つかりません" }, { status: 404 })
  }

  const dropboxPath = doc.dropbox_path as string

  try {
    const { buffer, mimeType } = await downloadFile(dropboxPath)
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": contentTypeFromPath(dropboxPath, mimeType),
        // モーダル内でのインライン表示（PDFのダウンロード扱いを防ぐ）
        "Content-Disposition": "inline",
        // 同一ファイルは内容が変わらないため、認証済みブラウザ側でキャッシュ
        "Cache-Control": "private, max-age=3600",
      },
    })
  } catch (error) {
    if (error instanceof DropboxFileNotFoundError) {
      return NextResponse.json(
        { error: "Dropboxにファイルが見つかりません" },
        { status: 404 }
      )
    }
    console.error("書類ファイル取得エラー:", error)
    return NextResponse.json({ error: "資料の取得に失敗しました" }, { status: 500 })
  }
}
