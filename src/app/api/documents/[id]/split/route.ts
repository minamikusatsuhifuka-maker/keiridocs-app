import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { normalizeAmount } from "@/lib/gemini"
import { resolveAutoDocumentStatus, fetchVendorMasterMethod } from "@/lib/document-status"
import type { Database, Json } from "@/types/database"

type DocumentRow = Database["public"]["Tables"]["documents"]["Row"]

/** 分割の1件分（クライアントの確認UIで編集済みの内容） */
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
 * 既存レコードの分割 API
 * POST /api/documents/[id]/split
 * 合計1件で登録済みのレコードを、分割後の複数レコードに置き換える。
 * 方式: 元レコードを1件目の支払いに更新し、2件目以降を新規レコードとして追加する
 * （元レコードのID・登録日時・カレンダー連携を保持するため、削除→再作成はしない）。
 * ファイルは1つのまま、全レコードが同一の dropbox_path・file_hash を参照する。
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

  // 権限チェック: admin or staff のみ（既存PATCHと同じ方式）
  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "編集権限がありません" }, { status: 403 })
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

    // 対象書類を取得（adminは全件、staffは自分の書類のみ）
    let fetchQuery = supabase
      .from("documents")
      .select("*")
      .eq("id", id)
    if (auth.role !== "admin") {
      fetchQuery = fetchQuery.eq("user_id", user.id)
    }
    const { data: doc, error: fetchError } = await fetchQuery.single()
    if (fetchError || !doc) {
      return NextResponse.json({ error: "書類が見つかりません" }, { status: 404 })
    }

    const original = doc as DocumentRow

    // 既に分割済みのレコードを再分割すると兄弟レコードと二重計上になるため拒否する
    if (original.split_group) {
      return NextResponse.json(
        { error: "この書類は既に分割登録されています。再分割する場合は分割済みの各レコードを個別に修正してください" },
        { status: 400 }
      )
    }

    const splitGroup = randomUUID()
    const originalOcrRaw = (original.ocr_raw && typeof original.ocr_raw === "object" && !Array.isArray(original.ocr_raw)
      ? original.ocr_raw as Record<string, unknown>
      : null)

    /** 分割情報を付与したocr_rawを作る */
    const buildOcrRaw = (p: SplitPaymentInput, index: number): Json => (
      (originalOcrRaw
        ? { ...originalOcrRaw, split_group: splitGroup, split_index: index + 1, split_total: payments.length, split_payment: p }
        : { split_group: splitGroup, split_index: index + 1, split_total: payments.length, split_payment: p }) as unknown as Json
    )

    /** 支払いごとのステータス（要振込マーク）を判定する。手動のアーカイブは尊重する */
    const resolveStatus = async (p: SplitPaymentInput): Promise<string> => {
      if (original.status === "アーカイブ") return original.status
      const masterMethod = await fetchVendorMasterMethod(supabase, p.vendor_name)
      return resolveAutoDocumentStatus({
        type: original.type,
        paymentMethod: original.payment_method || "unknown",
        masterMethod,
        paymentStatus: original.payment_status,
      })
    }

    // --- 1. 元レコードを1件目の支払いに更新 ---
    const first = payments[0]
    const { error: updateError } = await supabase
      .from("documents")
      .update({
        vendor_name: first.vendor_name,
        amount: first.amount,
        issue_date: first.issue_date,
        due_date: first.due_date,
        description: first.description,
        tax_category: first.tax_category || "未判定",
        account_title: first.account_title || "",
        status: await resolveStatus(first),
        split_group: splitGroup,
        ocr_raw: buildOcrRaw(first, 0),
      })
      .eq("id", id)

    if (updateError) {
      console.error("分割: 元レコード更新エラー:", updateError)
      // split_group カラム未作成（040_split_group.sql 未実行）を明示する
      if (updateError.message?.includes("split_group")) {
        return NextResponse.json(
          { error: "DBに split_group 列がありません。Supabase SQL Editor で supabase/migrations/040_split_group.sql を実行してください" },
          { status: 500 }
        )
      }
      return NextResponse.json({ error: "元レコードの更新に失敗しました" }, { status: 500 })
    }

    // --- 2. 2件目以降を新規レコードとして追加（ファイル・入力経路などは元レコードから引き継ぐ） ---
    const restRows = []
    for (let i = 1; i < payments.length; i++) {
      const p = payments[i]
      restRows.push({
        type: original.type,
        vendor_name: p.vendor_name,
        amount: p.amount,
        issue_date: p.issue_date,
        due_date: p.due_date,
        description: p.description,
        input_method: original.input_method,
        status: await resolveStatus(p),
        dropbox_path: original.dropbox_path,
        thumbnail_url: original.thumbnail_url,
        ocr_raw: buildOcrRaw(p, i),
        tax_category: p.tax_category || "未判定",
        account_title: p.account_title || "",
        payment_method: original.payment_method,
        bank_info: original.bank_info,
        file_hash: original.file_hash,
        split_group: splitGroup,
        registrant_id: original.registrant_id,
        document_staff_id: original.document_staff_id,
        user_id: original.user_id,
      })
    }

    const { error: insertError } = await supabase
      .from("documents")
      .insert(restRows)

    if (insertError) {
      console.error("分割: 追加レコード挿入エラー:", insertError)
      return NextResponse.json(
        { error: "分割レコードの追加に失敗しました（元レコードは1件目の内容に更新済みです）" },
        { status: 500 }
      )
    }

    // 分割後の全レコードを返す
    const { data: groupRows } = await supabase
      .from("documents")
      .select("*")
      .eq("split_group", splitGroup)
      .order("created_at", { ascending: true })

    return NextResponse.json({ data: groupRows, split_group: splitGroup })
  } catch (error) {
    console.error("既存レコード分割エラー:", error)
    return NextResponse.json({ error: "分割に失敗しました" }, { status: 500 })
  }
}
