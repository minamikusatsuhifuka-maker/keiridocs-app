import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { downloadFile, getTemporaryLink, DropboxFileNotFoundError } from "@/lib/dropbox"

/**
 * スタッフ領収書（LINE登録分）の画像を提供するAPI。
 *
 * GET /api/staff-receipts/image?id=<staff_receipt_id>
 *   → Dropboxに保存された画像のバイト列を返す（<img> のサムネイル・拡大表示用）
 *
 * GET /api/staff-receipts/image?id=<staff_receipt_id>&mode=link
 *   → Dropboxの一時リンク（4時間有効）を { link } で返す（実ファイルを開く導線用）
 *
 * セキュリティ:
 *   - Supabase認証必須
 *   - クライアントから任意パスを受け取らず、id から staff_receipts.dropbox_path を引く
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const id = searchParams.get("id")
  const mode = searchParams.get("mode")

  if (!id) {
    return NextResponse.json({ error: "id は必須です" }, { status: 400 })
  }

  // id から Dropboxパスを引く（任意パスの直接指定を許さない）
  const { data: receipt, error: queryError } = await supabase
    .from("staff_receipts")
    .select("dropbox_path")
    .eq("id", id)
    .single()

  if (queryError || !receipt?.dropbox_path) {
    return NextResponse.json({ error: "領収書が見つかりません" }, { status: 404 })
  }

  const dropboxPath = receipt.dropbox_path as string

  try {
    // mode=link: Dropbox一時リンクを返す（実ファイルを開く導線）
    if (mode === "link") {
      const link = await getTemporaryLink(dropboxPath)
      return NextResponse.json({ link })
    }

    // 既定: 画像バイト列をストリームで返す（サムネイル・拡大表示）
    const { buffer, mimeType } = await downloadFile(dropboxPath)
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": mimeType,
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
    console.error("スタッフ領収書画像取得エラー:", error)
    return NextResponse.json(
      { error: "画像の取得に失敗しました" },
      { status: 500 }
    )
  }
}
