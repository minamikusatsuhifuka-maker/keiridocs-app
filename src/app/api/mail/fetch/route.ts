import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { fetchUnreadMailsWithAttachments } from "@/lib/gmail"
import { uploadFile } from "@/lib/dropbox"
import { analyzeDocument } from "@/lib/gemini"

// メール取込 API
export async function POST() {
  try {
    const supabase = await createClient()

    // 認証チェック
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
    }

    // 許可送信元リストを取得
    const { data: senders, error: sendersError } = await supabase
      .from("allowed_senders")
      .select("email")
      .eq("user_id", user.id)

    if (sendersError) {
      return NextResponse.json({ error: "許可送信元の取得に失敗しました" }, { status: 500 })
    }

    const allowedEmails = (senders ?? []).map((s) => s.email)
    if (allowedEmails.length === 0) {
      return NextResponse.json({ error: "許可送信元が登録されていません" }, { status: 400 })
    }

    // Gmail APIでメール取込
    const mails = await fetchUnreadMailsWithAttachments(allowedEmails)

    const results: Array<{
      file_name: string
      sender: string
      ai_type: string | null
      ai_confidence: number | null
    }> = []

    for (const mail of mails) {
      for (const attachment of mail.attachments) {
        // Dropbox「一時保存」フォルダにアップロード
        const tempPath = `/経理書類/一時保存/${attachment.fileName}`
        const buffer = Buffer.from(attachment.base64Data, "base64")
        const uploadedPath = await uploadFile(tempPath, buffer)

        // 画像の場合はGemini AIで種別判定
        let aiType: string | null = null
        let aiConfidence: number | null = null

        const isImage = attachment.mimeType.startsWith("image/")
        if (isImage) {
          const ocrResult = await analyzeDocument(attachment.base64Data, attachment.mimeType)
          aiType = ocrResult.type
          aiConfidence = ocrResult.confidence
        } else if (attachment.mimeType === "application/pdf") {
          // PDFもGeminiで解析
          const ocrResult = await analyzeDocument(attachment.base64Data, attachment.mimeType)
          aiType = ocrResult.type
          aiConfidence = ocrResult.confidence
        }

        // mail_pendingテーブルに登録
        const { error: insertError } = await supabase
          .from("mail_pending")
          .insert({
            file_name: attachment.fileName,
            sender: mail.sender,
            received_at: mail.receivedAt,
            ai_type: aiType,
            ai_confidence: aiConfidence,
            temp_path: uploadedPath,
            status: "pending",
            user_id: user.id,
          })

        if (insertError) {
          console.error("mail_pending登録エラー:", insertError)
          continue
        }

        results.push({
          file_name: attachment.fileName,
          sender: mail.sender,
          ai_type: aiType,
          ai_confidence: aiConfidence,
        })
      }
    }

    return NextResponse.json({
      data: results,
      count: results.length,
      message: `${results.length}件のメール添付ファイルを取り込みました`,
    })
  } catch (error) {
    console.error("メール取込エラー:", error)
    return NextResponse.json(
      { error: "メールの取込に失敗しました" },
      { status: 500 }
    )
  }
}
