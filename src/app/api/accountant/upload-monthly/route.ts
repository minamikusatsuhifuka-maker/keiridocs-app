import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { ensureDropboxFolderExists, uploadFileOverwrite } from "@/lib/dropbox"
import * as XLSX from "xlsx"

export const maxDuration = 120

/** 抽出対象シート名（順番通りに処理） */
const TARGET_SHEETS = ["Sheet1", "保険"] as const

/** Base64 → Buffer */
function base64ToBuffer(base64: string): Buffer {
  const data = base64.includes(",") ? base64.split(",")[1] : base64
  return Buffer.from(data, "base64")
}

/**
 * シートの 1〜maxRow 行目を BOM付き CSV 文字列に変換
 * 空行も行番号保持のため含める
 */
function sheetToCsv(sheet: XLSX.WorkSheet, maxRow = 30): string {
  const ref = sheet["!ref"]
  if (!ref) return ""
  const range = XLSX.utils.decode_range(ref)
  const endRow = Math.min(range.e.r, maxRow - 1) // 0-indexed

  const rows: string[][] = []
  for (let r = 0; r <= endRow; r++) {
    const row: string[] = []
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })]
      const raw = cell ? String(cell.v ?? "") : ""
      const escaped =
        raw.includes(",") || raw.includes('"') || raw.includes("\n")
          ? `"${raw.replace(/"/g, '""')}"`
          : raw
      row.push(escaped)
    }
    rows.push(row)
  }
  return rows.map((r) => r.join(",")).join("\n")
}

/**
 * Sheet1 の先頭10行×6列のセルから「年月」を検出
 * - YYYY年M月 / YYYY/MM / YYYY-MM 形式のテキストを検索
 * - Excel日付シリアル値（数値型セル）も判定
 * - 見つからなければ今月
 */
function detectYearMonthFromSheet(workbook: XLSX.WorkBook): {
  year: number
  month: number
  source: string
} {
  const firstSheetName = workbook.SheetNames[0]
  const ws = workbook.Sheets[firstSheetName]

  if (ws) {
    for (let r = 0; r <= 9; r++) {
      for (let c = 0; c <= 5; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })]
        if (!cell) continue

        // テキストセル: YYYY年M月 / YYYY/MM / YYYY-MM を検索
        const text = String(cell.w ?? cell.v ?? "")
        const textMatch = text.match(/(20\d{2})[年\/\-](\d{1,2})[月]?/)
        if (textMatch) {
          const y = Number(textMatch[1])
          const m = Number(textMatch[2])
          if (y >= 2020 && y <= 2100 && m >= 1 && m <= 12) {
            return { year: y, month: m, source: `セル(行${r + 1},列${c + 1})` }
          }
        }

        // 数値型: Excelの日付シリアル値
        if (cell.t === "n" && typeof cell.v === "number" && cell.v > 40000) {
          try {
            const parsed = XLSX.SSF.parse_date_code(cell.v)
            if (parsed && parsed.y >= 2020 && parsed.y <= 2100) {
              return {
                year: parsed.y,
                month: parsed.m,
                source: `日付セル(行${r + 1},列${c + 1})`,
              }
            }
          } catch {
            // 解析失敗は無視
          }
        }
      }
    }
  }

  // フォールバック: 今月
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth() + 1, source: "今月（自動）" }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "権限がありません" }, { status: 403 })
  }

  try {
    const body = (await request.json()) as {
      file: unknown
      filename: unknown
    }

    if (typeof body.file !== "string" || typeof body.filename !== "string") {
      return NextResponse.json(
        { error: "file と filename は必須です" },
        { status: 400 }
      )
    }

    const filename = body.filename
    const ext = filename.split(".").pop()?.toLowerCase()
    if (!["xlsx", "xls"].includes(ext ?? "")) {
      return NextResponse.json(
        { error: "Excel(.xlsx / .xls)のみ対応しています" },
        { status: 400 }
      )
    }

    // Excel解析
    const buffer = base64ToBuffer(body.file)
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false })

    // 年月検出（セルのみ）
    const { year, month, source: yearMonthSource } = detectYearMonthFromSheet(workbook)
    const monthStr = String(month).padStart(2, "0")
    const yearMonthLabel = `${year}年${monthStr}月`
    const taxFolderPath = `/経理書類/税理士提出/${yearMonthLabel}`

    console.log(`[月計表] 年月: ${yearMonthLabel}（検出元: ${yearMonthSource}）`)

    // 税理士提出フォルダを確保
    await ensureDropboxFolderExists(taxFolderPath)

    // 各シートをCSV化 → Dropbox保存
    const results: Array<{
      sheet: string
      csvFileName: string
      csvPath: string
      rows: number
      status: "saved" | "skipped" | "error"
      message?: string
    }> = []

    for (const sheetName of TARGET_SHEETS) {
      const ws = workbook.Sheets[sheetName]

      if (!ws) {
        results.push({
          sheet: sheetName,
          csvFileName: "",
          csvPath: "",
          rows: 0,
          status: "skipped",
          message: `シート「${sheetName}」が見つかりません`,
        })
        continue
      }

      const csvContent = sheetToCsv(ws, 30)
      const rowCount = csvContent.split("\n").filter(Boolean).length

      // BOM付きUTF-8（Excelで開いても文字化けしない）
      const csvBuffer = Buffer.from("\uFEFF" + csvContent, "utf-8")
      const csvFileName = `月計表_${sheetName}_${yearMonthLabel}.csv`
      const csvPath = `${taxFolderPath}/${csvFileName}`

      try {
        await uploadFileOverwrite(csvPath, csvBuffer)
        results.push({ sheet: sheetName, csvFileName, csvPath, rows: rowCount, status: "saved" })
        console.log(`[月計表] 保存完了: ${csvPath} (${rowCount}行)`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({
          sheet: sheetName,
          csvFileName,
          csvPath,
          rows: 0,
          status: "error",
          message: msg,
        })
        console.error(`[月計表] 保存失敗: ${csvPath}`, err)
      }
    }

    return NextResponse.json({
      year,
      month,
      yearMonthLabel,
      yearMonthSource,
      taxFolderPath,
      results,
    })
  } catch (error) {
    console.error("[月計表] 想定外エラー:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "処理に失敗しました" },
      { status: 500 }
    )
  }
}
