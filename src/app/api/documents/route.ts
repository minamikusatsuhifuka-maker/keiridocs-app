import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { deleteFile } from "@/lib/dropbox"
import { getCurrentUserRole } from "@/lib/auth"
import { normalizePaymentMethod, normalizeBankInfo } from "@/lib/gemini"
import { resolveAutoDocumentStatus, fetchVendorMasterMethod } from "@/lib/document-status"
import type { Database, Json } from "@/types/database"

type DocumentRow = Database["public"]["Tables"]["documents"]["Row"]
type DocumentUpdate = Database["public"]["Tables"]["documents"]["Update"]

/** 一括ステータス変更で許可する値（単一更新のドロップダウンと同一） */
const BULK_ALLOWED_STATUSES = ["要振込", "未処理", "処理済み", "アーカイブ"] as const

// 書類一覧取得 / 単一取得
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  // 権限取得（adminは全件、staff/viewerは自分の書類のみ）
  const auth = await getCurrentUserRole()
  const isAdminUser = auth?.role === "admin"

  const { searchParams } = new URL(request.url)

  // 単一取得（id指定時）
  const id = searchParams.get("id")
  if (id) {
    let singleQuery = supabase
      .from("documents")
      .select("*, registrant:registrants(id, name)")
      .eq("id", id)

    // admin以外は自分の書類のみ
    if (!isAdminUser) {
      singleQuery = singleQuery.eq("user_id", user.id)
    }

    const { data, error } = await singleQuery.single()

    if (error) {
      console.error("書類取得エラー:", error)
      return NextResponse.json({ error: "書類の取得に失敗しました" }, { status: 404 })
    }
    return NextResponse.json({ data })
  }

  // 一覧取得（フィルタ・検索・ソート・ページネーション対応）
  const status = searchParams.get("status")
  const type = searchParams.get("type")
  const excludeType = searchParams.get("exclude_type")
  const searchQuery = searchParams.get("search")
  const dateFrom = searchParams.get("date_from")
  const dateTo = searchParams.get("date_to")
  const sortField = searchParams.get("sort") ?? "created_at"
  const sortDirection = searchParams.get("direction") ?? "desc"
  const limit = parseInt(searchParams.get("limit") ?? "20", 10)
  const offset = parseInt(searchParams.get("offset") ?? "0", 10)

  // ソート可能なカラムを制限
  const allowedSortFields = ["type", "vendor_name", "amount", "issue_date", "due_date", "status", "created_at", "tax_category", "account_title"]
  const safeSort = allowedSortFields.includes(sortField) ? sortField : "created_at"
  const ascending = sortDirection === "asc"

  let query = supabase
    .from("documents")
    .select("*, registrant:registrants(id, name)", { count: "exact" })
    // 空値（NULL）は昇順・降順にかかわらず末尾に寄せる（既定のDESC=NULLS FIRSTだと
    // 発行日・支払期日の降順で「-」の行が先頭に並び、ソートが効いていないように見える）
    .order(safeSort, { ascending, nullsFirst: false })
    .range(offset, offset + limit - 1)

  // admin以外は自分の書類のみ
  if (!isAdminUser) {
    query = query.eq("user_id", user.id)
  }

  if (status) {
    query = query.eq("status", status)
  }
  if (type) {
    query = query.eq("type", type)
  }
  // 経費タブ用：特定種別を除外
  if (excludeType) {
    query = query.neq("type", excludeType)
  }

  // 「要振込」フィルタ：振込が必要なもの（bank_transfer / unknown / NULL）に絞る
  // （自動引落し auto_debit・カード払い credit_card は除外）
  if (searchParams.get("require_transfer") === "1") {
    query = query.or("payment_method.in.(bank_transfer,unknown),payment_method.is.null")
  }
  // 未払いのみ（支払い済み以外）
  if (searchParams.get("unpaid") === "1") {
    query = query.neq("payment_status", "支払い済み")
  }

  // テキスト検索（取引先名・摘要）
  if (searchQuery) {
    query = query.or(`vendor_name.ilike.%${searchQuery}%,description.ilike.%${searchQuery}%`)
  }

  // 期間フィルタ（発行日基準）
  if (dateFrom) {
    query = query.gte("issue_date", dateFrom)
  }
  if (dateTo) {
    query = query.lte("issue_date", dateTo)
  }

  const { data, error, count } = await query

  if (error) {
    console.error("書類取得エラー:", error)
    return NextResponse.json({ error: "書類の取得に失敗しました" }, { status: 500 })
  }

  return NextResponse.json({ data, count })
}

// 書類登録
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as {
      type: unknown
      vendor_name: unknown
      amount: unknown
      issue_date: unknown
      due_date: unknown
      description: unknown
      input_method: unknown
      dropbox_path: unknown
      ocr_raw: unknown
      tax_category: unknown
      account_title: unknown
      file_hash: unknown
      items: unknown
    }

    const { type, vendor_name, amount, issue_date, due_date, description, input_method, dropbox_path, ocr_raw, tax_category, account_title, file_hash, items } = body

    // 支払方法・振込先はAI解析結果（ocr_raw）から取り出す。
    // bodyで明示指定があればそれを優先（再解析や手動修正の余地を残す）。
    const ocrRawObj = (ocr_raw && typeof ocr_raw === "object" ? ocr_raw : {}) as Record<string, unknown>
    const paymentMethod = normalizePaymentMethod(
      (body as Record<string, unknown>).payment_method ?? ocrRawObj.payment_method
    )
    const bankInfo = normalizeBankInfo(
      (body as Record<string, unknown>).bank_info ?? ocrRawObj.bank_info
    )

    // 必須フィールドのバリデーション
    if (typeof type !== "string" || typeof vendor_name !== "string") {
      return NextResponse.json(
        { error: "種別と取引先名は必須です" },
        { status: 400 }
      )
    }

    if (typeof input_method !== "string") {
      return NextResponse.json(
        { error: "入力経路は必須です" },
        { status: 400 }
      )
    }

    // 重複チェック（skip_duplicate_check が true なら省略）
    const skipDuplicateCheck = (body as Record<string, unknown>).skip_duplicate_check === true
    const fileHashStr = typeof file_hash === "string" ? file_hash : ""
    console.log("skip_duplicate_check:", skipDuplicateCheck, "file_hash:", fileHashStr)
    if (!skipDuplicateCheck) {
      // ファイルハッシュによる完全一致チェック
      if (fileHashStr) {
        const { data: hashDups } = await supabase
          .from("documents")
          .select("id, vendor_name, amount, type, issue_date, due_date, file_hash, created_at")
          .eq("user_id", user.id)
          .eq("file_hash", fileHashStr)

        if (hashDups && hashDups.length > 0) {
          return NextResponse.json({
            data: null,
            duplicates: hashDups,
            duplicate_level: "exact",
            warning: "同じファイルが既に登録されています",
          }, { status: 200 })
        }
      }

      // メタデータによる重複チェック
      let dupQuery = supabase
        .from("documents")
        .select("id, vendor_name, amount, type, issue_date, due_date, file_hash, created_at")
        .eq("user_id", user.id)
        .eq("vendor_name", vendor_name)
        .eq("type", type)

      if (typeof amount === "number") {
        dupQuery = dupQuery.eq("amount", amount)
      }

      const { data: dupCandidates } = await dupQuery

      if (dupCandidates && dupCandidates.length > 0) {
        // 日付の一致もチェック（issue_date または due_date が一致）
        const issueStr = typeof issue_date === "string" ? issue_date : null
        const dueStr = typeof due_date === "string" ? due_date : null

        const duplicates = dupCandidates.filter((d) => {
          if (issueStr && d.issue_date === issueStr) return true
          if (dueStr && d.due_date === dueStr) return true
          return false
        })

        if (duplicates.length > 0) {
          return NextResponse.json({
            data: null,
            duplicates,
            duplicate_level: "likely",
            warning: "似た書類が既に登録されています",
          }, { status: 200 })
        }
      }
    }

    // ステータス自動判定: 手動振込が必要な請求書のみ「要振込」マーク、それ以外は「処理済み」。
    // ファイルはアップロード時点で処理済みフォルダに保存済みのため移動しない
    // （要振込マークはDBのみで管理。DBのパスは常に実際の保存場所を指す）。
    const masterMethod = await fetchVendorMasterMethod(supabase, vendor_name)
    const autoStatus = resolveAutoDocumentStatus({
      type,
      paymentMethod: paymentMethod,
      masterMethod,
    })
    const finalDropboxPath = typeof dropbox_path === "string" ? dropbox_path : null

    const { data, error } = await supabase
      .from("documents")
      .insert({
        type,
        vendor_name,
        amount: typeof amount === "number" ? amount : null,
        issue_date: typeof issue_date === "string" ? issue_date : null,
        due_date: typeof due_date === "string" ? due_date : null,
        description: typeof description === "string" ? description : null,
        input_method,
        status: autoStatus,
        dropbox_path: finalDropboxPath,
        ocr_raw: (ocr_raw ?? null) as import("@/types/database").Json | null,
        tax_category: typeof tax_category === "string" ? tax_category : "未判定",
        account_title: typeof account_title === "string" ? account_title : "",
        payment_method: paymentMethod,
        bank_info: bankInfo as Json | null,
        file_hash: fileHashStr || "",
        user_id: user.id,
      })
      .select()
      .single()

    if (error) {
      console.error("書類登録エラー:", error)
      return NextResponse.json({ error: "書類の登録に失敗しました" }, { status: 500 })
    }

    // 明細行をdocument_itemsに保存
    const docId = (data as DocumentRow | null)?.id
    console.log("受信items:", Array.isArray(items) ? items.length + "件" : "なし", "docId:", docId)
    if (Array.isArray(items) && items.length > 0 && docId) {
      const itemRows = items
        .filter((item): item is Record<string, unknown> => item != null && typeof item === "object")
        .map((item) => ({
          document_id: docId,
          user_id: user.id,
          item_name: typeof item.item_name === "string" ? item.item_name : "",
          quantity: typeof item.quantity === "number" ? item.quantity : 1,
          unit_price: typeof item.unit_price === "number" ? item.unit_price : 0,
          amount: typeof item.amount === "number" ? item.amount : 0,
          category: typeof item.category === "string" ? item.category : "",
          tax_rate: typeof item.tax_rate === "string" ? item.tax_rate : "",
          notes: typeof item.notes === "string" ? item.notes : "",
        }))

      console.log("INSERT対象:", itemRows.length, "件")
      if (itemRows.length > 0) {
        const { error: itemError } = await supabase
          .from("document_items")
          .insert(itemRows)

        if (itemError) {
          console.error("明細行保存エラー:", itemError)
          // 書類自体は登録済みなのでエラーは無視して続行
        } else {
          console.log("明細行保存成功:", itemRows.length, "件")
        }
      }
    }

    return NextResponse.json({ data }, { status: 201 })
  } catch (error) {
    console.error("書類登録エラー:", error)
    return NextResponse.json({ error: "書類の登録に失敗しました" }, { status: 500 })
  }
}

// 書類更新（ステータス変更時のDropbox移動対応）
export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  // 権限チェック: admin or staff のみ編集可
  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "編集権限がありません" }, { status: 403 })
  }

  // リクエストボディを先に読む（単一更新・一括更新で共用）
  let body: Record<string, unknown>
  try {
    body = await request.json() as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 })
  }

  // --- 一括ステータス変更: { ids: string[], status } が渡された場合 ---
  if (Array.isArray(body.ids)) {
    const ids = body.ids.filter((v): v is string => typeof v === "string")
    const newStatus = typeof body.status === "string" ? body.status : ""

    if (ids.length === 0) {
      return NextResponse.json({ error: "対象の書類IDがありません" }, { status: 400 })
    }
    if (!BULK_ALLOWED_STATUSES.includes(newStatus as (typeof BULK_ALLOWED_STATUSES)[number])) {
      return NextResponse.json({ error: "不正なステータスです" }, { status: 400 })
    }

    try {
      // 対象書類を取得（adminは全件、staffは自分の書類のみ）。Dropbox移動判定とスコープ確認に使う
      let listQuery = supabase
        .from("documents")
        .select("id, status, type, issue_date, created_at, dropbox_path")
        .in("id", ids)
      if (auth.role !== "admin") {
        listQuery = listQuery.eq("user_id", user.id)
      }
      const { data: targets, error: listError } = await listQuery
      if (listError) {
        console.error("一括ステータス変更: 対象取得エラー:", listError)
        return NextResponse.json({ error: "対象書類の取得に失敗しました" }, { status: 500 })
      }

      const rows = (targets ?? []) as Pick<
        DocumentRow,
        "id" | "status" | "type" | "issue_date" | "created_at" | "dropbox_path"
      >[]
      const scopedIds = rows.map((r) => r.id)
      if (scopedIds.length === 0) {
        return NextResponse.json({ updated: 0, moved: 0 })
      }

      // ステータスをまとめて更新（権限スコープ内のidのみ）
      let updateQuery = supabase
        .from("documents")
        .update({ status: newStatus })
        .in("id", scopedIds)
      if (auth.role !== "admin") {
        updateQuery = updateQuery.eq("user_id", user.id)
      }
      const { error: updateError } = await updateQuery
      if (updateError) {
        console.error("一括ステータス変更: 更新エラー:", updateError)
        return NextResponse.json({ error: "ステータスの一括更新に失敗しました" }, { status: 500 })
      }

      // ステータス管理の廃止に伴い、ステータス変更でのDropboxファイル移動は行わない
      // （要振込マークはDBのみで管理。dropbox_path は常に実際の保存場所を指す）
      return NextResponse.json({ updated: scopedIds.length, moved: 0 })
    } catch (error) {
      console.error("一括ステータス変更エラー:", error)
      return NextResponse.json({ error: "ステータスの一括更新に失敗しました" }, { status: 500 })
    }
  }

  // --- 単一更新（従来どおり id 必須） ---
  const { searchParams } = new URL(request.url)
  const id = searchParams.get("id")
  if (!id) {
    return NextResponse.json({ error: "IDが必要です" }, { status: 400 })
  }

  try {
    // 既存の書類を取得（adminは全件、staffは自分の書類のみ）
    let fetchQuery = supabase
      .from("documents")
      .select("*")
      .eq("id", id)

    if (auth.role !== "admin") {
      fetchQuery = fetchQuery.eq("user_id", user.id)
    }

    const { data: existingData, error: fetchError } = await fetchQuery.single()

    if (fetchError || !existingData) {
      return NextResponse.json({ error: "書類が見つかりません" }, { status: 404 })
    }

    // 更新可能なフィールドを構築
    const update: DocumentUpdate = {}
    if (typeof body.type === "string") update.type = body.type
    if (typeof body.vendor_name === "string") update.vendor_name = body.vendor_name
    if ("amount" in body) update.amount = typeof body.amount === "number" ? body.amount : null
    if ("issue_date" in body) update.issue_date = typeof body.issue_date === "string" ? body.issue_date : null
    if ("due_date" in body) update.due_date = typeof body.due_date === "string" ? body.due_date : null
    if ("description" in body) update.description = typeof body.description === "string" ? body.description : null
    if (typeof body.status === "string") update.status = body.status
    if (typeof body.tax_category === "string") update.tax_category = body.tax_category
    if (typeof body.account_title === "string") update.account_title = body.account_title
    if (typeof body.payment_status === "string") update.payment_status = body.payment_status

    const hasUpdates = Object.keys(update).length > 0
    if (!hasUpdates) {
      return NextResponse.json({ error: "更新するフィールドがありません" }, { status: 400 })
    }

    // ステータス管理の廃止に伴い、ステータス変更でのDropboxファイル移動は行わない
    // （dropbox_path は常に実際の保存場所を指す）

    let updateQuery = supabase
      .from("documents")
      .update(update)
      .eq("id", id)

    if (auth.role !== "admin") {
      updateQuery = updateQuery.eq("user_id", user.id)
    }

    const { data, error } = await updateQuery.select().single()

    if (error) {
      console.error("書類更新エラー:", error)
      return NextResponse.json({ error: "書類の更新に失敗しました" }, { status: 500 })
    }

    return NextResponse.json({ data })
  } catch (error) {
    console.error("書類更新エラー:", error)
    return NextResponse.json({ error: "書類の更新に失敗しました" }, { status: 500 })
  }
}

// 書類削除（admin は全件、staff は自分の書類のみ）
export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  // 権限チェック: admin or staff のみ削除可
  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "削除権限がありません" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const id = searchParams.get("id")
  if (!id) {
    return NextResponse.json({ error: "IDが必要です" }, { status: 400 })
  }

  console.log("DELETE受信:", id, "ユーザー:", user.id, "ロール:", auth.role)

  // 削除前にDropboxパスを取得
  let fetchQuery = supabase
    .from("documents")
    .select("dropbox_path, user_id")
    .eq("id", id)

  // staffは自分の書類のみ
  if (auth.role !== "admin") {
    fetchQuery = fetchQuery.eq("user_id", user.id)
  }

  const { data: docData, error: fetchError } = await fetchQuery.single()

  if (fetchError || !docData) {
    console.error("削除対象の書類が見つかりません:", id, fetchError?.message)
    return NextResponse.json({ error: "書類が見つかりません" }, { status: 404 })
  }

  console.log("削除対象:", id, "Dropboxパス:", docData.dropbox_path)

  // DB削除（adminはRLSポリシーで全件、staffは自分のみ）
  let deleteQuery = supabase
    .from("documents")
    .delete()
    .eq("id", id)

  if (auth.role !== "admin") {
    deleteQuery = deleteQuery.eq("user_id", user.id)
  }

  const { error } = await deleteQuery

  if (error) {
    console.error("書類削除エラー:", error)
    return NextResponse.json({ error: "書類の削除に失敗しました" }, { status: 500 })
  }

  console.log("DB削除完了:", id)

  // Dropboxファイルも削除（失敗してもDB削除は成功扱い）
  if (docData.dropbox_path) {
    // 分割登録などで同じファイルを参照している他のレコードが残っている場合は
    // ファイルを消さない（残りのレコードの原本が失われるため）
    const { data: sharingDocs } = await supabase
      .from("documents")
      .select("id")
      .eq("dropbox_path", docData.dropbox_path)
      .limit(1)

    if (sharingDocs && sharingDocs.length > 0) {
      console.log("同じファイルを参照する書類が残っているため、Dropbox削除をスキップ:", docData.dropbox_path)
    } else {
      try {
        console.log("Dropbox削除:", docData.dropbox_path)
        await deleteFile(docData.dropbox_path)
        console.log("Dropbox削除成功:", docData.dropbox_path)
      } catch (dropboxError) {
        console.error("Dropboxファイル削除エラー（書類ID: " + id + "）:", dropboxError)
      }
    }
  } else {
    console.log("Dropboxパスなし、ファイル削除スキップ")
  }

  return NextResponse.json({ success: true })
}
