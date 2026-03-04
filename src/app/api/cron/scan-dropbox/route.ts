import { NextRequest, NextResponse } from "next/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { createHash } from "crypto"
import { listFiles, downloadFile, moveFile, getDocumentPath } from "@/lib/dropbox"
import { analyzeDocument, analyzeDocumentFromText, applyAutoClassifyRules, DEFAULT_GEMINI_MODEL } from "@/lib/gemini"
import type { OcrResult, AutoClassifyRule } from "@/lib/gemini"
import type { Database } from "@/types/database"
import mammoth from "mammoth"
import * as XLSX from "xlsx"
import Papa from "papaparse"

type DocumentRow = Database["public"]["Tables"]["documents"]["Row"]

/** 画像/PDFのMIMEタイプ */
const IMAGE_PDF_TYPES = [
  "image/jpeg", "image/jpg", "image/png", "image/heic", "image/webp", "application/pdf",
]

/** テキスト抽出が必要なMIMEタイプ */
const DOCUMENT_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
]

const ALL_SUPPORTED_TYPES = [...IMAGE_PDF_TYPES, ...DOCUMENT_MIME_TYPES]

/** 拡張子からMIMEタイプを推定 */
function guessMimeType(fileName: string): string | null {
  const ext = fileName.split(".").pop()?.toLowerCase()
  switch (ext) {
    case "jpg": case "jpeg": return "image/jpeg"
    case "png": return "image/png"
    case "heic": return "image/heic"
    case "webp": return "image/webp"
    case "pdf": return "application/pdf"
    case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    case "xls": return "application/vnd.ms-excel"
    case "csv": return "text/csv"
    default: return null
  }
}

/** 一意なファイル名を生成 */
function generateUniqueFileName(
  vendorName: string | undefined,
  docType: string,
  date: Date,
  originalFileName: string
): string {
  let vendor = (vendorName || "不明").replace(/[/\\:*?"<>|]/g, "_")
  if (vendor.length > 20) vendor = vendor.substring(0, 20)

  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  const dateStr = `${y}${m}${d}`
  const timestamp = Date.now().toString().slice(-6)
  const dotIndex = originalFileName.lastIndexOf(".")
  const ext = dotIndex >= 0 ? originalFileName.substring(dotIndex) : ".jpg"

  return `${vendor}_${docType}_${dateStr}_${timestamp}${ext}`
}

/** 要確認の理由を判定 */
function checkReviewReasons(ocrResult: OcrResult): string[] {
  const reasons: string[] = []
  if (ocrResult.confidence < 0.8) {
    reasons.push(`AI確信度${Math.round(ocrResult.confidence * 100)}%`)
  }
  if (!ocrResult.type) reasons.push("種別不明")
  if (ocrResult.amount === null || ocrResult.amount === 0) reasons.push("金額未検出")
  if (!ocrResult.vendor_name || ocrResult.vendor_name.trim() === "") reasons.push("取引先名未検出")
  return reasons
}

/** サービスロールキーでRLSをバイパスするSupabaseクライアント */
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createSupabaseClient<Database>(url, serviceKey)
}

// Dropboxスキャン監視 — Vercel Cron Jobs用
// スキャンフォルダ内の新しいファイルを検知してAI解析・自動登録する
// vercel.json crons: path="/api/cron/scan-dropbox" schedule="every 15 minutes"
export async function GET(request: NextRequest) {
  // Vercel Cron認証チェック
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceClient()

  try {
    // adminユーザーを取得（cronはセッションがないのでadminのIDを使う）
    const { data: adminRole } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("role", "admin")
      .limit(1)
      .single()

    if (!adminRole) {
      return NextResponse.json({ error: "adminユーザーが見つかりません" }, { status: 500 })
    }

    const userId = adminRole.user_id

    // スキャン対象フォルダ（デフォルト: /経理書類 と /経理書類/スキャン）
    const scanPaths = ["/経理書類", "/経理書類/スキャン"]

    let totalProcessed = 0
    let totalRegistered = 0
    let totalNeedsReview = 0
    let totalErrors = 0

    for (const scanPath of scanPaths) {
      let files: Awaited<ReturnType<typeof listFiles>>
      try {
        files = await listFiles(scanPath)
      } catch {
        // フォルダが存在しない場合はスキップ
        console.log(`スキャン: フォルダなし: ${scanPath}`)
        continue
      }

      for (const file of files) {
        // サポート対象の拡張子かチェック
        const mimeType = guessMimeType(file.name)
        if (!mimeType || !ALL_SUPPORTED_TYPES.includes(mimeType)) {
          continue
        }

        // 既に処理済みか確認（dropbox_pathで重複回避）
        const { data: existing } = await supabase
          .from("scan_items")
          .select("id, status")
          .eq("dropbox_path", file.path_display)
          .eq("user_id", userId)
          .limit(1)

        if (existing && existing.length > 0) {
          // 既にscan_itemsに記録済み（processed / needs_review / error）
          continue
        }

        console.log("スキャン: 新ファイル検知:", file.name)
        totalProcessed++

        // scan_itemsに記録（processing）
        const { data: scanItem, error: insertError } = await supabase
          .from("scan_items")
          .insert({
            dropbox_path: file.path_display,
            file_name: file.name,
            status: "processing",
            user_id: userId,
          })
          .select("id")
          .single()

        const scanItemId = (scanItem as { id: string } | null)?.id
        if (insertError || !scanItemId) {
          console.error("スキャン: scan_items挿入エラー:", insertError)
          totalErrors++
          continue
        }

        try {
          await processFile(supabase, scanItemId, file.path_display, file.name, mimeType, userId)
          totalRegistered++
        } catch (error) {
          console.error("スキャン: 処理エラー:", file.name, error)

          // scan_itemsをerrorに更新
          await supabase
            .from("scan_items")
            .update({
              status: "error",
              error_message: error instanceof Error ? error.message : "処理に失敗しました",
              updated_at: new Date().toISOString(),
            })
            .eq("id", scanItemId)

          totalErrors++
        }
      }
    }

    // needs_reviewの再集計
    const { count: reviewCount } = await supabase
      .from("scan_items")
      .select("id", { count: "exact", head: true })
      .eq("status", "needs_review")
      .eq("user_id", userId)

    totalNeedsReview = reviewCount ?? 0

    return NextResponse.json({
      message: "スキャン完了",
      processed: totalProcessed,
      registered: totalRegistered,
      needs_review: totalNeedsReview,
      errors: totalErrors,
    })
  } catch (error) {
    console.error("[Cron] スキャン監視エラー:", error)
    return NextResponse.json(
      { error: "スキャン監視に失敗しました" },
      { status: 500 }
    )
  }
}

/**
 * 1ファイルの全自動登録処理
 * AI解析 → 重複チェック → Dropbox移動 → DB登録
 */
async function processFile(
  supabase: ReturnType<typeof createServiceClient>,
  scanItemId: string,
  dropboxPath: string,
  fileName: string,
  mimeType: string,
  userId: string
) {
  // 1. Dropboxからダウンロード
  const { buffer } = await downloadFile(dropboxPath)

  // 2. ファイルハッシュ計算
  const fileHash = createHash("sha256").update(buffer).digest("hex")

  // scan_itemsにハッシュを保存
  await supabase
    .from("scan_items")
    .update({ file_hash: fileHash, updated_at: new Date().toISOString() })
    .eq("id", scanItemId)

  // 3. Geminiモデル設定を取得
  const { data: modelSetting } = await supabase
    .from("settings")
    .select("value")
    .eq("user_id", userId)
    .eq("key", "gemini_model")
    .maybeSingle()

  const modelId = (typeof modelSetting?.value === "string" ? modelSetting.value : null) || DEFAULT_GEMINI_MODEL

  // document_typesを取得
  const { data: docTypes } = await supabase
    .from("document_types")
    .select("name")
    .eq("user_id", userId)
    .order("sort_order", { ascending: true })

  const documentTypes = docTypes?.map((t) => t.name)

  // 4. AI解析
  let ocrResult: OcrResult & { model_used?: string }

  if (DOCUMENT_MIME_TYPES.includes(mimeType)) {
    // Word/Excel/CSV: テキスト抽出後にAI解析
    let extractedText: string
    if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      extractedText = (await mammoth.extractRawText({ buffer })).value
    } else if (
      mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      mimeType === "application/vnd.ms-excel"
    ) {
      const workbook = XLSX.read(buffer, { type: "buffer" })
      extractedText = workbook.SheetNames.map((name) => {
        const sheet = workbook.Sheets[name]
        return `--- シート: ${name} ---\n${XLSX.utils.sheet_to_csv(sheet)}`
      }).join("\n")
    } else {
      const result = Papa.parse(buffer.toString("utf-8"), { header: false })
      extractedText = (result.data as string[][]).map((row) => row.join(", ")).join("\n")
    }

    if (!extractedText.trim()) {
      throw new Error("ファイルからテキストを抽出できませんでした")
    }

    const text = extractedText.length > 30000 ? extractedText.slice(0, 30000) : extractedText
    ocrResult = await analyzeDocumentFromText(text, { modelId, documentTypes })
  } else {
    // 画像/PDF: Base64でGeminiに送信
    const base64Data = buffer.toString("base64")
    ocrResult = await analyzeDocument(base64Data, mimeType, { modelId, documentTypes })
  }

  // 自動仕分けルール適用
  const { data: classifyRules } = await supabase
    .from("auto_classify_rules")
    .select("keyword, document_type, priority, is_active")
    .eq("user_id", userId)

  if (classifyRules && classifyRules.length > 0) {
    const applied = applyAutoClassifyRules(ocrResult, classifyRules as AutoClassifyRule[])
    ocrResult = { ...applied, model_used: ocrResult.model_used }
  }

  console.log("スキャン: AI解析完了:", ocrResult.type, ocrResult.vendor_name, ocrResult.amount, ocrResult.confidence)

  // 5. 重複チェック
  const duplicateReasons: string[] = []

  // ファイルハッシュ完全一致
  const { data: hashDups } = await supabase
    .from("documents")
    .select("id")
    .eq("user_id", userId)
    .eq("file_hash", fileHash)
    .limit(1)

  if (hashDups && hashDups.length > 0) {
    duplicateReasons.push("同一ファイルが既に登録済み")
  }

  // メタデータ重複チェック
  if (duplicateReasons.length === 0 && ocrResult.vendor_name && ocrResult.type) {
    let dupQuery = supabase
      .from("documents")
      .select("id, issue_date, due_date")
      .eq("user_id", userId)
      .eq("vendor_name", ocrResult.vendor_name)
      .eq("type", ocrResult.type)

    if (typeof ocrResult.amount === "number") {
      dupQuery = dupQuery.eq("amount", ocrResult.amount)
    }

    const { data: dupCandidates } = await dupQuery

    if (dupCandidates && dupCandidates.length > 0) {
      const matched = dupCandidates.filter((d) => {
        if (ocrResult.issue_date && d.issue_date === ocrResult.issue_date) return true
        if (ocrResult.due_date && d.due_date === ocrResult.due_date) return true
        return false
      })
      if (matched.length > 0) {
        duplicateReasons.push("重複の可能性あり")
      }
    }
  }

  // 6. 確信度・品質チェック
  const reviewReasons = checkReviewReasons(ocrResult)
  const allReasons = [...reviewReasons, ...duplicateReasons]

  // 7. 要確認の場合
  if (allReasons.length > 0) {
    console.log("スキャン: 要確認:", fileName, allReasons)

    await supabase
      .from("scan_items")
      .update({
        status: "needs_review",
        review_reasons: allReasons,
        updated_at: new Date().toISOString(),
      })
      .eq("id", scanItemId)

    // 通知を送る
    await sendNotification(supabase, userId, fileName, allReasons)
    return
  }

  // 8. 問題なければDropbox移動 + DB登録
  const docType = ocrResult.type || "その他"
  const dateObj = ocrResult.issue_date ? new Date(ocrResult.issue_date) : new Date()
  const uniqueFileName = generateUniqueFileName(ocrResult.vendor_name, docType, dateObj, fileName)
  const newPath = getDocumentPath(docType, uniqueFileName, dateObj, "未処理")

  // Dropbox上のファイルを正しいフォルダに移動
  const movedPath = await moveFile(dropboxPath, newPath)
  console.log("スキャン: 自動登録完了:", fileName, "→", movedPath)

  // DB登録
  const { data: docData, error: docError } = await supabase
    .from("documents")
    .insert({
      type: docType,
      vendor_name: ocrResult.vendor_name,
      amount: ocrResult.amount,
      issue_date: ocrResult.issue_date,
      due_date: ocrResult.due_date,
      description: ocrResult.description,
      input_method: "scan",
      status: "未処理",
      dropbox_path: movedPath,
      ocr_raw: ocrResult as unknown as import("@/types/database").Json,
      tax_category: ocrResult.tax_category || "未判定",
      account_title: ocrResult.account_title || "",
      file_hash: fileHash,
      user_id: userId,
    })
    .select()
    .single()

  if (docError) {
    throw new Error(`DB登録エラー: ${docError.message}`)
  }

  const docId = (docData as DocumentRow | null)?.id

  // 明細行を保存
  if (Array.isArray(ocrResult.items) && ocrResult.items.length > 0 && docId) {
    const itemRows = ocrResult.items.map((item) => ({
      document_id: docId,
      user_id: userId,
      item_name: item.item_name || "",
      quantity: item.quantity || 1,
      unit_price: item.unit_price || 0,
      amount: item.amount || 0,
      category: item.category || "",
      tax_rate: item.tax_rate || "",
      notes: "",
    }))

    const { error: itemError } = await supabase
      .from("document_items")
      .insert(itemRows)

    if (itemError) {
      console.error("スキャン: 明細行保存エラー:", itemError)
    }
  }

  // scan_itemsをprocessedに更新
  await supabase
    .from("scan_items")
    .update({
      status: "processed",
      document_id: docId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", scanItemId)
}

/**
 * 通知を送る（要確認ファイルの場合）
 */
async function sendNotification(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string,
  fileName: string,
  reasons: string[]
) {
  try {
    // 通知先を取得
    const { data: recipients } = await supabase
      .from("notify_recipients")
      .select("email")
      .eq("user_id", userId)

    if (!recipients || recipients.length === 0) return

    const emails = recipients.map((r) => r.email)
    const reasonText = reasons.join("、")

    // Resendで通知
    const resendKey = process.env.RESEND_API_KEY
    if (!resendKey) return

    for (const email of emails) {
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: process.env.RESEND_FROM_EMAIL || "keiridocs@resend.dev",
            to: email,
            subject: `[経理書類] 要確認: ${fileName}`,
            text: `スキャンファイル「${fileName}」が自動登録できませんでした。\n\n理由: ${reasonText}\n\nアプリから確認してください。`,
          }),
        })
      } catch (emailError) {
        console.error("スキャン: 通知メール送信エラー:", emailError)
      }
    }
  } catch (error) {
    console.error("スキャン: 通知処理エラー:", error)
  }
}
