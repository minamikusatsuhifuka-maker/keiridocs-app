import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getDocumentPath, moveFile, deleteFile } from "@/lib/dropbox"
import { getCurrentUserRole } from "@/lib/auth"
import type { Database } from "@/types/database"

type DocumentRow = Database["public"]["Tables"]["documents"]["Row"]
type DocumentUpdate = Database["public"]["Tables"]["documents"]["Update"]

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
      .select("*")
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
  const searchQuery = searchParams.get("search")
  const dateFrom = searchParams.get("date_from")
  const dateTo = searchParams.get("date_to")
  const sortField = searchParams.get("sort") ?? "created_at"
  const sortDirection = searchParams.get("direction") ?? "desc"
  const limit = parseInt(searchParams.get("limit") ?? "20", 10)
  const offset = parseInt(searchParams.get("offset") ?? "0", 10)

  // ソート可能なカラムを制限
  const allowedSortFields = ["type", "vendor_name", "amount", "issue_date", "due_date", "status", "created_at"]
  const safeSort = allowedSortFields.includes(sortField) ? sortField : "created_at"
  const ascending = sortDirection === "asc"

  let query = supabase
    .from("documents")
    .select("*", { count: "exact" })
    .order(safeSort, { ascending })
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
    }

    const { type, vendor_name, amount, issue_date, due_date, description, input_method, dropbox_path, ocr_raw, tax_category, account_title, file_hash } = body

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
        status: "未処理",
        dropbox_path: typeof dropbox_path === "string" ? dropbox_path : null,
        ocr_raw: (ocr_raw ?? null) as import("@/types/database").Json | null,
        tax_category: typeof tax_category === "string" ? tax_category : "未判定",
        account_title: typeof account_title === "string" ? account_title : "",
        file_hash: fileHashStr || "",
        user_id: user.id,
      })
      .select()
      .single()

    if (error) {
      console.error("書類登録エラー:", error)
      return NextResponse.json({ error: "書類の登録に失敗しました" }, { status: 500 })
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

  const { searchParams } = new URL(request.url)
  const id = searchParams.get("id")
  if (!id) {
    return NextResponse.json({ error: "IDが必要です" }, { status: 400 })
  }

  try {
    const body = await request.json() as Record<string, unknown>

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

    const existing = existingData as DocumentRow

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

    const hasUpdates = Object.keys(update).length > 0
    if (!hasUpdates) {
      return NextResponse.json({ error: "更新するフィールドがありません" }, { status: 400 })
    }

    // ステータス変更時にDropboxファイルを移動
    const newStatus = update.status
    if (newStatus && newStatus !== existing.status && existing.dropbox_path) {
      try {
        const newType = update.type ?? existing.type
        const fileName = existing.dropbox_path.split("/").pop() ?? ""
        const dateStr = existing.issue_date ?? existing.created_at
        const date = new Date(dateStr)
        const newPath = getDocumentPath(newType, fileName, date, newStatus)

        if (newPath !== existing.dropbox_path) {
          const movedPath = await moveFile(existing.dropbox_path, newPath)
          update.dropbox_path = movedPath
        }
      } catch (moveError) {
        console.error("Dropboxファイル移動エラー:", moveError)
        // ファイル移動が失敗してもDB更新は続行する
      }
    }

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

// 書類削除（admin のみ）
export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  // 権限チェック: adminのみ削除可
  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin") {
    return NextResponse.json({ error: "削除権限がありません" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const id = searchParams.get("id")
  if (!id) {
    return NextResponse.json({ error: "IDが必要です" }, { status: 400 })
  }

  // 削除前にDropboxパスを取得
  const { data: docData } = await supabase
    .from("documents")
    .select("dropbox_path")
    .eq("id", id)
    .single()

  console.log("削除対象:", id, "Dropboxパス:", docData?.dropbox_path)

  const { error } = await supabase
    .from("documents")
    .delete()
    .eq("id", id)

  if (error) {
    console.error("書類削除エラー:", error)
    return NextResponse.json({ error: "書類の削除に失敗しました" }, { status: 500 })
  }

  // Dropboxファイルも削除（失敗してもDB削除は成功扱い）
  if (docData?.dropbox_path) {
    try {
      await deleteFile(docData.dropbox_path)
      console.log("Dropbox削除成功:", docData.dropbox_path)
    } catch (dropboxError) {
      console.error("Dropboxファイル削除エラー（書類ID: " + id + "）:", dropboxError)
    }
  } else {
    console.log("Dropboxパスなし、ファイル削除スキップ")
  }

  return NextResponse.json({ success: true })
}
