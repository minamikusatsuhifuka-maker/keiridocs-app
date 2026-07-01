import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { createServiceClient } from "@/lib/staff-refund-core"
import type { Json } from "@/types/database"

/** 税理士フォルダ一括コピーの実行種別 */
type RunType = "range_copy" | "additional_import"

/**
 * 税理士フォルダ一括コピーの実行履歴（GET: 一覧取得 / POST: 記録）
 *
 * - 単月/期間指定コピー・追加分の一括取り込み、いずれも実行完了後にクライアントから記録する。
 * - 一覧・詳細表示は /documents/tax-copy-history で行う。
 */

// 実行履歴を一覧取得（新しい順）
export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "閲覧権限がありません" }, { status: 403 })
  }

  try {
    const { data, error } = await supabase
      .from("tax_folder_copy_runs")
      .select("*")
      .order("run_at", { ascending: false })
      .limit(200)

    if (error) throw error
    return NextResponse.json({ data: data ?? [] })
  } catch (error) {
    console.error("税理士フォルダコピー履歴取得エラー:", error)
    return NextResponse.json({ error: "履歴の取得に失敗しました" }, { status: 500 })
  }
}

// 実行履歴を1件記録する
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "記録権限がありません" }, { status: 403 })
  }

  try {
    const body = await request.json() as {
      run_type: unknown
      period_start: unknown
      period_end: unknown
      target_folders: unknown
      summary: unknown
      issues?: unknown
    }

    const runType: RunType | null =
      body.run_type === "range_copy" || body.run_type === "additional_import"
        ? body.run_type
        : null
    const periodStart = typeof body.period_start === "string" ? body.period_start : ""
    const periodEnd = typeof body.period_end === "string" ? body.period_end : ""
    const targetFolders = Array.isArray(body.target_folders)
      ? body.target_folders.filter((f): f is string => typeof f === "string")
      : []

    if (!runType || !periodStart || !periodEnd || body.summary == null) {
      return NextResponse.json({ error: "記録に必要な情報が不足しています" }, { status: 400 })
    }

    // 表示名は user_roles.display_name → user_metadata.full_name → email の順で解決（house pattern）
    const { data: roleData } = await supabase
      .from("user_roles")
      .select("display_name")
      .eq("user_id", user.id)
      .maybeSingle()
    const runBy =
      (roleData?.display_name as string | undefined) ||
      (user.user_metadata?.full_name as string | undefined) ||
      user.email ||
      "不明"

    // 書込はRLSバイパスのサービスロールクライアント経由（select以外のポリシーを設けないため）
    const serviceClient = createServiceClient()
    const { data, error } = await serviceClient
      .from("tax_folder_copy_runs")
      .insert({
        run_by: runBy,
        run_type: runType,
        period_start: periodStart,
        period_end: periodEnd,
        target_folders: targetFolders,
        summary: body.summary as Json,
        issues: (body.issues ?? null) as Json | null,
      })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ data }, { status: 201 })
  } catch (error) {
    console.error("税理士フォルダコピー履歴記録エラー:", error)
    return NextResponse.json({ error: "履歴の記録に失敗しました" }, { status: 500 })
  }
}
