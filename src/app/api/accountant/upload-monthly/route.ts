import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { ensureDropboxFolderExists, uploadFileOverwrite } from "@/lib/dropbox"

export const maxDuration = 60

/**
 * 月計表アップロードAPI（クライアント側xlsx解析方式）
 *
 * フロントで xlsx → CSV変換済みの文字列を受け取り、
 * BOM付きUTF-8で Dropbox の税理士提出フォルダに保存する。
 * Excelファイル本体は送信しないため Vercel 4.5MB制限を回避できる。
 *
 * リクエスト:
 *   { year, month, yearMonthLabel, csvSheets: [{sheet, csv}], filename }
 * レスポンス:
 *   { year, month, yearMonthLabel, yearMonthSource, taxFolderPath, results }
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "権限がありません" }, { status: 403 })
  }

  try {
    const body = await request.json() as {
      year: unknown
      month: unknown
      yearMonthLabel: unknown
      csvSheets: unknown
      filename: unknown
    }

    const year = Number(body.year)
    const month = Number(body.month)
    const yearMonthLabel = typeof body.yearMonthLabel === "string"
      ? body.yearMonthLabel
      : `${year}年${String(month).padStart(2, "0")}月`

    if (!Number.isFinite(year) || !Number.isFinite(month)) {
      return NextResponse.json({ error: "year / month が不正です" }, { status: 400 })
    }

    if (!Array.isArray(body.csvSheets) || body.csvSheets.length === 0) {
      return NextResponse.json({ error: "csvSheets が空です" }, { status: 400 })
    }

    const monthStr = String(month).padStart(2, "0")
    const taxFolderPath = `/経理書類/税理士提出/${year}年${monthStr}月`

    // 税理士提出フォルダを確保
    await ensureDropboxFolderExists(taxFolderPath)

    const results: Array<{
      sheet: string
      csvFileName: string
      rows: number
      status: "saved" | "skipped" | "error"
      message?: string
    }> = []

    for (const item of body.csvSheets as Array<{ sheet: unknown; csv: unknown }>) {
      const sheetName = typeof item.sheet === "string" ? item.sheet : ""
      const csvContent = typeof item.csv === "string" ? item.csv : ""

      if (!sheetName) continue

      // シートが見つからなかった場合（csv が空文字）
      if (!csvContent) {
        results.push({
          sheet: sheetName,
          csvFileName: "",
          rows: 0,
          status: "skipped",
          message: `シート「${sheetName}」が見つかりませんでした`,
        })
        continue
      }

      const rowCount = csvContent.split("\n").filter(Boolean).length
      const csvFileName = `月計表_${sheetName}_${year}年${monthStr}月.csv`
      const csvPath = `${taxFolderPath}/${csvFileName}`

      // BOM付きUTF-8（Excelで開いても文字化けしない）
      const csvBuffer = Buffer.from("\uFEFF" + csvContent, "utf-8")

      try {
        await uploadFileOverwrite(csvPath, csvBuffer)
        results.push({ sheet: sheetName, csvFileName, rows: rowCount, status: "saved" })
        console.log(`[月計表] 保存完了: ${csvPath} (${rowCount}行)`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({ sheet: sheetName, csvFileName, rows: 0, status: "error", message: msg })
        console.error(`[月計表] 保存失敗: ${csvPath}`, err)
      }
    }

    return NextResponse.json({
      year,
      month,
      yearMonthLabel,
      yearMonthSource: "セル自動検出（クライアント）",
      taxFolderPath,
      results,
    })
  } catch (error) {
    console.error("[月計表] エラー:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "処理に失敗しました" },
      { status: 500 }
    )
  }
}
