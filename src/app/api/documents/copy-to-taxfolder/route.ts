import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { copyFileNoOverwrite, ensureDropboxFolderExists, fileExists } from "@/lib/dropbox"
import { getCurrentUserRole } from "@/lib/auth"

/**
 * 指定した年月の「処理済み」書類を税理士提出フォルダに一括コピー
 *
 * リクエスト: { year: number, month: number }
 * レスポンス: { copied, skipped, failed, total, details }
 *
 * コピー先: /経理書類/税理士提出/{YYYY年MM月}/{元のファイル名}
 * 既に存在する場合はスキップ（上書きしない）
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "コピー権限がありません" }, { status: 403 })
  }

  try {
    const body = await request.json() as { year: unknown; month: unknown }
    const yearNum = typeof body.year === "number" ? body.year : Number(body.year)
    const monthNum = typeof body.month === "number" ? body.month : Number(body.month)

    if (!Number.isFinite(yearNum) || !Number.isFinite(monthNum)) {
      return NextResponse.json({ error: "年月を指定してください" }, { status: 400 })
    }
    if (yearNum < 2000 || yearNum > 2100) {
      return NextResponse.json({ error: "年が不正です" }, { status: 400 })
    }
    if (monthNum < 1 || monthNum > 12) {
      return NextResponse.json({ error: "月が不正です" }, { status: 400 })
    }

    // 対象月の範囲（issue_date 基準）
    const monthStr = String(monthNum).padStart(2, "0")
    const dateFrom = `${yearNum}-${monthStr}-01`
    const nextYear = monthNum === 12 ? yearNum + 1 : yearNum
    const nextMonth = monthNum === 12 ? 1 : monthNum + 1
    const dateToExclusive = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`

    // 該当月の処理済み書類を取得（adminは全件、staffは自分の書類のみ）
    let query = supabase
      .from("documents")
      .select("id, dropbox_path, vendor_name, issue_date")
      .eq("status", "処理済み")
      .gte("issue_date", dateFrom)
      .lt("issue_date", dateToExclusive)
      .not("dropbox_path", "is", null)

    if (auth.role !== "admin") {
      query = query.eq("user_id", user.id)
    }

    const { data: docs, error: fetchError } = await query

    if (fetchError) {
      console.error("書類取得エラー:", fetchError)
      return NextResponse.json({ error: "書類の取得に失敗しました" }, { status: 500 })
    }

    const targets = (docs ?? []).filter(
      (d): d is { id: string; dropbox_path: string; vendor_name: string; issue_date: string | null } =>
        typeof d.dropbox_path === "string" && d.dropbox_path.length > 0
    )

    const taxFolderBase = `/経理書類/税理士提出/${yearNum}年${monthStr}月`

    if (targets.length === 0) {
      return NextResponse.json({
        copied: 0,
        skipped: 0,
        failed: 0,
        total: 0,
        details: [],
        message: `${yearNum}年${monthStr}月の処理済み書類はありません`,
      })
    }

    // フォルダを事前作成
    try {
      await ensureDropboxFolderExists(taxFolderBase)
    } catch (folderError) {
      console.error("税理士提出フォルダ作成エラー:", folderError)
    }

    let copied = 0
    let skipped = 0
    let failed = 0
    const details: Array<{
      id: string
      vendor_name: string
      file_name: string
      status: "copied" | "skipped" | "failed"
      message?: string
    }> = []

    for (const doc of targets) {
      const fromPath = doc.dropbox_path
      const fileName = fromPath.split("/").pop() ?? ""
      if (!fileName) {
        failed++
        details.push({
          id: doc.id,
          vendor_name: doc.vendor_name ?? "",
          file_name: fromPath,
          status: "failed",
          message: "ファイル名が取得できませんでした",
        })
        continue
      }

      const toPath = `${taxFolderBase}/${fileName}`

      try {
        // 既存チェック
        const exists = await fileExists(toPath)
        if (exists) {
          skipped++
          details.push({
            id: doc.id,
            vendor_name: doc.vendor_name ?? "",
            file_name: fileName,
            status: "skipped",
            message: "コピー先に既に存在します",
          })
          continue
        }

        await copyFileNoOverwrite(fromPath, toPath)
        copied++
        details.push({
          id: doc.id,
          vendor_name: doc.vendor_name ?? "",
          file_name: fileName,
          status: "copied",
        })
      } catch (copyError) {
        const msg = copyError instanceof Error ? copyError.message : String(copyError)
        // copy_v2 で「to/conflict」（コピー先に既に存在）の場合はスキップ扱い
        if (msg.includes("to/conflict")) {
          skipped++
          details.push({
            id: doc.id,
            vendor_name: doc.vendor_name ?? "",
            file_name: fileName,
            status: "skipped",
            message: "コピー先に既に存在します",
          })
        } else {
          console.error(`コピー失敗 (${doc.id}):`, copyError)
          failed++
          details.push({
            id: doc.id,
            vendor_name: doc.vendor_name ?? "",
            file_name: fileName,
            status: "failed",
            message: msg,
          })
        }
      }

      // Dropbox API Rate Limit 対策
      await new Promise((resolve) => setTimeout(resolve, 60))
    }

    return NextResponse.json({
      copied,
      skipped,
      failed,
      total: targets.length,
      details,
    })
  } catch (error) {
    console.error("税理士フォルダコピーエラー:", error)
    return NextResponse.json({ error: "コピー処理に失敗しました" }, { status: 500 })
  }
}
