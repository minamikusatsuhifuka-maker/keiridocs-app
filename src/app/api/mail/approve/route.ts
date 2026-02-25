import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { analyzeDocument, type OcrResult } from "@/lib/gemini"
import { moveFile, getDocumentPath } from "@/lib/dropbox"
import type { Database, Json } from "@/types/database"

type MailPendingRow = Database["public"]["Tables"]["mail_pending"]["Row"]

// メール承認・却下 API
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    // 認証チェック
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
    }

    const body = await request.json() as {
      action: "approve" | "reject"
      ids: string[]
      type?: string
      base64?: string
      mimeType?: string
    }

    const { action, ids, type } = body

    if (!action || !ids || ids.length === 0) {
      return NextResponse.json({ error: "action と ids は必須です" }, { status: 400 })
    }

    // 却下アクション
    if (action === "reject") {
      const { error: rejectError } = await supabase
        .from("mail_pending")
        .update({ status: "rejected" })
        .in("id", ids)
        .eq("user_id", user.id)

      if (rejectError) {
        return NextResponse.json({ error: "却下処理に失敗しました" }, { status: 500 })
      }

      return NextResponse.json({
        data: { action: "rejected", count: ids.length },
        message: `${ids.length}件を却下しました`,
      })
    }

    // 承認アクション
    if (action === "approve") {
      // mail_pendingレコードを取得
      const { data: pendingItems, error: fetchError } = await supabase
        .from("mail_pending")
        .select("id, file_name, sender, received_at, ai_type, ai_confidence, temp_path, status, user_id, created_at")
        .in("id", ids)
        .eq("user_id", user.id)
        .eq("status", "pending")

      if (fetchError || !pendingItems || pendingItems.length === 0) {
        return NextResponse.json({ error: "承認対象が見つかりません" }, { status: 404 })
      }

      const approvedDocs: Array<{ id: string; file_name: string }> = []

      for (const item of pendingItems as MailPendingRow[]) {
        // Gemini AIで再解析
        let ocrResult: OcrResult | null = null
        let docType = type ?? item.ai_type ?? "請求書"

        if (item.temp_path) {
          // approve-dialogでbase64が送られた場合は再解析
          if (body.base64 && body.mimeType) {
            ocrResult = await analyzeDocument(body.base64, body.mimeType)
            docType = type ?? ocrResult.type ?? item.ai_type ?? "請求書"
          }

          // Dropbox正式フォルダへ移動
          const now = new Date()
          const fileName = item.file_name
          const newPath = getDocumentPath(docType, fileName, now, "未処理")

          let movedPath = newPath
          try {
            movedPath = await moveFile(item.temp_path, newPath)
          } catch (moveError) {
            console.error("Dropboxファイル移動エラー:", moveError)
            // 移動失敗でも処理は続行（temp_pathを使用）
            movedPath = item.temp_path
          }

          // documentsテーブルに追加
          const { error: insertError } = await supabase
            .from("documents")
            .insert({
              type: docType,
              vendor_name: ocrResult?.vendor_name || item.sender,
              amount: ocrResult?.amount ?? null,
              issue_date: ocrResult?.issue_date ?? null,
              due_date: ocrResult?.due_date ?? null,
              description: ocrResult?.description ?? `メール添付: ${item.file_name}`,
              input_method: "email",
              status: "未処理",
              dropbox_path: movedPath,
              ocr_raw: ocrResult ? (JSON.parse(JSON.stringify(ocrResult)) as Json) : null,
              user_id: user.id,
            })

          if (insertError) {
            console.error("documents登録エラー:", insertError)
            continue
          }

          approvedDocs.push({ id: item.id, file_name: item.file_name })
        }
      }

      // mail_pendingのステータスを更新
      if (approvedDocs.length > 0) {
        await supabase
          .from("mail_pending")
          .update({ status: "approved" })
          .in("id", approvedDocs.map((d) => d.id))
          .eq("user_id", user.id)
      }

      return NextResponse.json({
        data: { action: "approved", count: approvedDocs.length, docs: approvedDocs },
        message: `${approvedDocs.length}件を承認しました`,
      })
    }

    return NextResponse.json({ error: "無効なアクションです" }, { status: 400 })
  } catch (error) {
    console.error("メール承認/却下エラー:", error)
    return NextResponse.json(
      { error: "処理に失敗しました" },
      { status: 500 }
    )
  }
}

/** ファイル名からMIMEタイプを推定する */
function guessMimeType(fileName: string): string {
  const ext = fileName.toLowerCase().split(".").pop()
  switch (ext) {
    case "pdf": return "application/pdf"
    case "jpg":
    case "jpeg": return "image/jpeg"
    case "png": return "image/png"
    default: return "application/octet-stream"
  }
}
