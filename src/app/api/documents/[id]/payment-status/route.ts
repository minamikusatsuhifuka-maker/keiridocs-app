import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { getDocumentPath, moveFile } from "@/lib/dropbox"
import { resolveAutoDocumentStatus, fetchVendorMasterMethod } from "@/lib/document-status"
import type { Database } from "@/types/database"

type DocumentRow = Database["public"]["Tables"]["documents"]["Row"]

/** 支払状態として許可する値（既存 documents.payment_status と同一） */
const ALLOWED_PAYMENT_STATUS = ["未対応", "支払い済み"] as const

/**
 * 支払状態更新 API
 * PATCH /api/documents/[id]/payment-status   body: { payment_status: "未対応" | "支払い済み" }
 * - 支払管理ページの「支払い完了」「未払いに戻す」から使用
 * - 未払い⇄支払済みの切り替え（取り消しも可能）
 * - 書類ステータスも連動: 支払い完了で 要振込/未処理 → 処理済み、
 *   未払いに戻すと（要振込判定に該当する場合）処理済み → 要振込 に自動遷移する
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  // 権限チェック: admin or staff のみ編集可（既存PATCHと同じ方式）
  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "編集権限がありません" }, { status: 403 })
  }

  let body: { payment_status?: unknown }
  try {
    body = await request.json() as { payment_status?: unknown }
  } catch {
    return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 })
  }

  const newStatus = body.payment_status
  if (typeof newStatus !== "string" || !ALLOWED_PAYMENT_STATUS.includes(newStatus as (typeof ALLOWED_PAYMENT_STATUS)[number])) {
    return NextResponse.json({ error: "不正な支払状態です" }, { status: 400 })
  }

  // 既存書類を取得（ステータス連動の判定に使う）
  let fetchQuery = supabase
    .from("documents")
    .select("id, status, type, vendor_name, payment_method, issue_date, created_at, dropbox_path")
    .eq("id", id)
  if (auth.role !== "admin") {
    fetchQuery = fetchQuery.eq("user_id", user.id)
  }
  const { data: existingData } = await fetchQuery.maybeSingle()
  const existing = existingData as Pick<
    DocumentRow,
    "id" | "status" | "type" | "vendor_name" | "payment_method" | "issue_date" | "created_at" | "dropbox_path"
  > | null

  // 書類ステータスの連動を決定
  //   支払い完了: 要振込/未処理 → 処理済み
  //   未払いに戻す: 処理済み → （要振込判定に該当すれば）要振込
  let nextDocStatus: string | null = null
  if (existing) {
    if (newStatus === "支払い済み" && (existing.status === "要振込" || existing.status === "未処理")) {
      nextDocStatus = "処理済み"
    } else if (newStatus === "未対応" && existing.status === "処理済み") {
      const masterMethod = await fetchVendorMasterMethod(supabase, existing.vendor_name)
      const autoStatus = resolveAutoDocumentStatus({
        type: existing.type,
        paymentMethod: existing.payment_method,
        masterMethod,
        paymentStatus: newStatus,
      })
      if (autoStatus === "要振込") nextDocStatus = "要振込"
    }
  }

  // ステータス変更に伴うDropbox移動（既存PATCHと同じロジック・best effort）
  let movedDropboxPath: string | null = null
  if (existing && nextDocStatus && existing.dropbox_path) {
    try {
      const fileName = existing.dropbox_path.split("/").pop() ?? ""
      const dateStr = existing.issue_date ?? existing.created_at
      const newPath = getDocumentPath(existing.type, fileName, new Date(dateStr), nextDocStatus)
      if (newPath !== existing.dropbox_path) {
        movedDropboxPath = await moveFile(existing.dropbox_path, newPath)
      }
    } catch (moveError) {
      console.error("Dropboxファイル移動エラー:", moveError)
      // 移動失敗でもDB更新は続行（dropbox_pathは実際の場所のまま維持）
    }
  }

  // 更新（adminは全件、staffは自分の書類のみ）
  const updatePayload: Record<string, string> = { payment_status: newStatus }
  if (nextDocStatus) updatePayload.status = nextDocStatus
  if (movedDropboxPath) updatePayload.dropbox_path = movedDropboxPath

  let updateQuery = supabase
    .from("documents")
    .update(updatePayload)
    .eq("id", id)
  if (auth.role !== "admin") {
    updateQuery = updateQuery.eq("user_id", user.id)
  }

  const { data, error } = await updateQuery.select().single()

  if (error) {
    console.error("支払状態更新エラー:", error)
    return NextResponse.json({ error: "支払状態の更新に失敗しました" }, { status: 500 })
  }

  return NextResponse.json({ data })
}
