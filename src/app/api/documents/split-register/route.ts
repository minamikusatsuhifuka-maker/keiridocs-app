import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { createClient } from "@/lib/supabase/server"
import { normalizePaymentMethod, normalizeBankInfo, normalizeAmount } from "@/lib/gemini"
import { resolveAutoDocumentStatus, fetchVendorMasterMethod } from "@/lib/document-status"
import type { Json } from "@/types/database"

/** 分割登録の1件分（クライアントの確認UIで編集済みの内容） */
interface SplitPaymentInput {
  vendor_name: string
  amount: number
  issue_date: string | null
  due_date: string | null
  description: string | null
  tax_category: string | null
  account_title: string | null
}

/** リクエストボディから分割支払い配列を検証・正規化する */
function parsePayments(raw: unknown): SplitPaymentInput[] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null
  const payments: SplitPaymentInput[] = []
  for (const p of raw) {
    if (!p || typeof p !== "object") return null
    const o = p as Record<string, unknown>
    const vendor = typeof o.vendor_name === "string" ? o.vendor_name.trim() : ""
    const amount = normalizeAmount(o.amount)
    if (!vendor || amount === null) return null
    payments.push({
      vendor_name: vendor,
      amount,
      issue_date: typeof o.issue_date === "string" && o.issue_date ? o.issue_date : null,
      due_date: typeof o.due_date === "string" && o.due_date ? o.due_date : null,
      description: typeof o.description === "string" && o.description ? o.description : null,
      tax_category: typeof o.tax_category === "string" && o.tax_category ? o.tax_category : null,
      account_title: typeof o.account_title === "string" && o.account_title ? o.account_title : null,
    })
  }
  return payments
}

/**
 * 分割登録 API
 * POST /api/documents/split-register
 * 1つのファイルに複数の独立した支払いが含まれる場合、支払いごとに別レコードとして登録する。
 * - ファイルは1つ（同一の dropbox_path・file_hash を全レコードで共有）
 * - 分割レコード同士は split_group で識別し、重複検知の対象外にする
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as Record<string, unknown>

    const payments = parsePayments(body.payments)
    if (!payments) {
      return NextResponse.json(
        { error: "分割支払いは2件以上で、各行に払込先と金額が必要です" },
        { status: 400 }
      )
    }

    const type = typeof body.type === "string" && body.type ? body.type : "請求書"
    const inputMethod = typeof body.input_method === "string" && body.input_method ? body.input_method : "upload"
    const dropboxPath = typeof body.dropbox_path === "string" ? body.dropbox_path : null
    const fileHash = typeof body.file_hash === "string" ? body.file_hash : ""
    const registrantId = typeof body.registrant_id === "string" ? body.registrant_id : null
    const ocrRaw = (body.ocr_raw && typeof body.ocr_raw === "object" ? body.ocr_raw : null) as Record<string, unknown> | null

    // 支払方法・振込先はAI解析結果（書類全体）から引き継ぐ
    const paymentMethod = normalizePaymentMethod(ocrRaw?.payment_method)
    const bankInfo = normalizeBankInfo(ocrRaw?.bank_info)

    // 重複チェック: ファイルハッシュの完全一致のみ、登録前に1回だけ行う。
    // （分割レコード同士を挿入のたびに比較しないため、siblingsが重複扱いになることはない）
    const skipDuplicateCheck = body.skip_duplicate_check === true
    if (!skipDuplicateCheck && fileHash) {
      const { data: hashDups } = await supabase
        .from("documents")
        .select("id, vendor_name, amount, type, issue_date, due_date, file_hash, created_at")
        .eq("user_id", user.id)
        .eq("file_hash", fileHash)

      if (hashDups && hashDups.length > 0) {
        return NextResponse.json({
          data: null,
          duplicates: hashDups,
          duplicate_level: "exact",
          warning: "同じファイルが既に登録されています",
        }, { status: 200 })
      }
    }

    // 分割グループID（同一ファイル由来のレコードを識別する）
    const splitGroup = randomUUID()

    // 各支払いのINSERT行を組み立てる（要振込マークは支払いごとに判定）
    const rows = []
    for (let i = 0; i < payments.length; i++) {
      const p = payments[i]
      const masterMethod = await fetchVendorMasterMethod(supabase, p.vendor_name)
      const autoStatus = resolveAutoDocumentStatus({
        type,
        paymentMethod,
        masterMethod,
      })
      rows.push({
        type,
        vendor_name: p.vendor_name,
        amount: p.amount,
        issue_date: p.issue_date,
        due_date: p.due_date,
        description: p.description,
        input_method: inputMethod,
        status: autoStatus,
        dropbox_path: dropboxPath,
        // 解析生データに分割情報を付与して保存（トレーサビリティ用）
        ocr_raw: (ocrRaw
          ? { ...ocrRaw, split_group: splitGroup, split_index: i + 1, split_total: payments.length, split_payment: p }
          : { split_group: splitGroup, split_index: i + 1, split_total: payments.length, split_payment: p }) as unknown as Json,
        tax_category: p.tax_category || "未判定",
        account_title: p.account_title || "",
        payment_method: paymentMethod,
        bank_info: bankInfo as Json | null,
        file_hash: fileHash,
        split_group: splitGroup,
        registrant_id: registrantId,
        user_id: user.id,
      })
    }

    const { data, error } = await supabase
      .from("documents")
      .insert(rows)
      .select()

    if (error) {
      console.error("分割登録エラー:", error)
      return NextResponse.json({ error: "分割登録に失敗しました" }, { status: 500 })
    }

    return NextResponse.json({ data, split_group: splitGroup }, { status: 201 })
  } catch (error) {
    console.error("分割登録エラー:", error)
    return NextResponse.json({ error: "分割登録に失敗しました" }, { status: 500 })
  }
}
