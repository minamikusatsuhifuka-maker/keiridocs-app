import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import type { Database } from "@/types/database"
import * as XLSX from "xlsx"
import Papa from "papaparse"
import { GoogleGenerativeAI } from "@google/generative-ai"
import { DEFAULT_GEMINI_MODEL } from "@/lib/gemini"

// RLSバイパス用サービスクライアント
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createClient<Database>(url, serviceKey)
}

interface MappedRow {
  date: string | null
  type: string
  amount: number
  description: string | null
  staff: string | null
}

interface ColumnMapping {
  date_column: string | null
  type_column: string | null
  amount_column: string | null
  description_column: string | null
  staff_column: string | null
  // 種別の判定: 金額列が正負で判定する場合に「auto_sign」、別列で判定する場合は「column」
  type_detection: "auto_sign" | "column" | "all_expense" | "all_income"
}

// Gemini AIでカラムマッピングを判定
async function detectColumnMapping(headers: string[], sampleRows: Record<string, unknown>[]): Promise<ColumnMapping> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    // フォールバック: キーワードマッチング
    return fallbackColumnMapping(headers)
  }

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: DEFAULT_GEMINI_MODEL })

  const prompt = `以下は小口現金の出納帳のExcel/CSVのヘッダとサンプル行です。各カラムが何を表すか判定し、JSON形式で回答してください。

ヘッダ: ${JSON.stringify(headers)}
サンプル行（最大5件）: ${JSON.stringify(sampleRows.slice(0, 5))}

以下のJSON形式のみで回答してください。余計なテキストは含めないでください。

{
  "date_column": "日付のカラム名（なければnull）",
  "type_column": "種別（入金/出金/返金）のカラム名（なければnull）",
  "amount_column": "金額のカラム名",
  "description_column": "内容・摘要のカラム名（なければnull）",
  "staff_column": "担当者・登録者のカラム名（なければnull）",
  "type_detection": "auto_sign/column/all_expense/all_income のいずれか"
}

【type_detection の判定】
- 金額列が正負（+/-）で入出金を区別している → "auto_sign"
- 種別を表す列がある（入金/出金/支出/収入など） → "column"
- 入金列・出金列が分かれている場合、入金列に値があれば入金・出金列に値があれば出金として判定する場合は "auto_sign"（代替処理）
- すべて出金 → "all_expense"
- すべて入金 → "all_income"`

  try {
    const result = await model.generateContent(prompt)
    const responseText = result.response.text()
    const cleaned = responseText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim()
    const parsed = JSON.parse(cleaned) as Record<string, unknown>

    return {
      date_column: typeof parsed.date_column === "string" ? parsed.date_column : null,
      type_column: typeof parsed.type_column === "string" ? parsed.type_column : null,
      amount_column: typeof parsed.amount_column === "string" ? parsed.amount_column : headers[0],
      description_column: typeof parsed.description_column === "string" ? parsed.description_column : null,
      staff_column: typeof parsed.staff_column === "string" ? parsed.staff_column : null,
      type_detection: (parsed.type_detection === "column" || parsed.type_detection === "auto_sign" || parsed.type_detection === "all_expense" || parsed.type_detection === "all_income")
        ? parsed.type_detection as "auto_sign" | "column" | "all_expense" | "all_income"
        : "auto_sign",
    }
  } catch (error) {
    console.error("Gemini カラム判定エラー:", error)
    return fallbackColumnMapping(headers)
  }
}

// キーワードベースのフォールバック判定
function fallbackColumnMapping(headers: string[]): ColumnMapping {
  const normalize = (s: string) => s.toLowerCase().replace(/\s/g, "")
  const find = (keywords: string[]) => {
    for (const h of headers) {
      const n = normalize(h)
      if (keywords.some((k) => n.includes(k))) return h
    }
    return null
  }

  return {
    date_column: find(["日付", "date", "年月日"]),
    type_column: find(["種別", "type", "区分"]),
    amount_column: find(["金額", "amount", "価格"]) || headers[0],
    description_column: find(["内容", "摘要", "description", "備考", "項目"]),
    staff_column: find(["担当", "staff", "登録者", "氏名"]),
    type_detection: "auto_sign",
  }
}

// 日付文字列を解析
function parseDate(val: unknown): string | null {
  if (!val) return null

  // ExcelのシリアルNumber
  if (typeof val === "number") {
    // Excel serial date to JS Date
    const excelEpoch = new Date(Date.UTC(1899, 11, 30))
    const date = new Date(excelEpoch.getTime() + val * 86400 * 1000)
    if (!isNaN(date.getTime())) {
      return date.toISOString()
    }
  }

  const str = String(val).trim()
  if (!str) return null

  // 日本語日付対応: 2026年4月17日, 2026/4/17, 2026-04-17, 2026.4.17
  const patterns = [
    /(\d{4})[年/\-.](\d{1,2})[月/\-.](\d{1,2})/,
    /(\d{4})(\d{2})(\d{2})/,
  ]

  for (const pattern of patterns) {
    const m = str.match(pattern)
    if (m) {
      const y = parseInt(m[1])
      const mo = parseInt(m[2])
      const d = parseInt(m[3])
      const date = new Date(Date.UTC(y, mo - 1, d))
      if (!isNaN(date.getTime())) return date.toISOString()
    }
  }

  // 直接Date.parseを試す
  const parsed = Date.parse(str)
  if (!isNaN(parsed)) return new Date(parsed).toISOString()

  return null
}

// 金額文字列を数値に変換
function parseAmount(val: unknown): number {
  if (typeof val === "number") return val
  if (!val) return 0
  const str = String(val).replace(/[¥,\s円]/g, "")
  const n = parseFloat(str)
  return isNaN(n) ? 0 : n
}

// 種別を判定
function detectType(
  row: Record<string, unknown>,
  mapping: ColumnMapping,
  amount: number
): { type: string; amount: number } {
  const absAmount = Math.abs(amount)

  if (mapping.type_detection === "all_income") {
    return { type: "入金", amount: absAmount }
  }
  if (mapping.type_detection === "all_expense") {
    return { type: "出金", amount: absAmount }
  }
  if (mapping.type_detection === "column" && mapping.type_column) {
    const raw = String(row[mapping.type_column] || "").trim()
    if (raw.includes("入金") || raw.includes("収入") || raw.toLowerCase().includes("income")) {
      return { type: "入金", amount: absAmount }
    }
    if (raw.includes("返金")) {
      return { type: "返金", amount: absAmount }
    }
    return { type: "出金", amount: absAmount }
  }
  // auto_sign: 金額の正負で判定
  if (amount < 0) {
    return { type: "出金", amount: absAmount }
  }
  // 正の金額でヘッダに「入金」「収入」相当があるかは呼び出し側でも補正
  return { type: amount > 0 ? "入金" : "出金", amount: absAmount }
}

// 行をマッピング
function mapRow(row: Record<string, unknown>, mapping: ColumnMapping): MappedRow | null {
  const rawAmount = mapping.amount_column ? row[mapping.amount_column] : null
  const amount = parseAmount(rawAmount)
  if (amount === 0) return null // 金額が0の行はスキップ

  const { type, amount: absAmount } = detectType(row, mapping, amount)

  return {
    date: mapping.date_column ? parseDate(row[mapping.date_column]) : null,
    type,
    amount: absAmount,
    description: mapping.description_column ? String(row[mapping.description_column] || "").trim() || null : null,
    staff: mapping.staff_column ? String(row[mapping.staff_column] || "").trim() || null : null,
  }
}

// ファイルをパース
async function parseFile(buffer: Buffer, fileName: string): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  const lower = fileName.toLowerCase()
  if (lower.endsWith(".csv")) {
    // BOM除去
    let text = buffer.toString("utf-8")
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)

    const parsed = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: true,
    })
    const headers = parsed.meta.fields || []
    return { headers, rows: parsed.data }
  }

  // Excel
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false })
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" })
  const headers = rows.length > 0 ? Object.keys(rows[0]) : []
  return { headers, rows }
}

// 分析(プレビュー)モード
export async function PUT(request: NextRequest) {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const formData = await request.formData()
    const file = formData.get("file")
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "ファイルが指定されていません" }, { status: 400 })
    }

    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    const { headers, rows } = await parseFile(buffer, file.name)

    if (headers.length === 0 || rows.length === 0) {
      return NextResponse.json({ error: "ファイルが空または読み取れません" }, { status: 400 })
    }

    // AIでカラム判定
    const mapping = await detectColumnMapping(headers, rows)

    // 行をマッピング
    const mapped: MappedRow[] = []
    for (const row of rows) {
      const m = mapRow(row, mapping)
      if (m) mapped.push(m)
    }

    return NextResponse.json({
      headers,
      mapping,
      total_rows: rows.length,
      mapped_rows: mapped,
      preview: mapped.slice(0, 50),
    })
  } catch (error) {
    console.error("インポートプレビューエラー:", error)
    return NextResponse.json({ error: error instanceof Error ? error.message : "プレビューに失敗しました" }, { status: 500 })
  }
}

// 実行モード
export async function POST(request: NextRequest) {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as { rows: MappedRow[] }
    const { rows } = body
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: "登録対象の行がありません" }, { status: 400 })
    }

    const serviceClient = createServiceClient()

    // 登録者名取得
    const { data: roleData } = await authSupabase
      .from("user_roles")
      .select("display_name")
      .eq("user_id", user.id)
      .maybeSingle()
    const registeredBy = (roleData?.display_name as string) || (user.user_metadata?.full_name as string) || user.email || "不明"

    // 既存取引を取得して重複チェック用マップを構築（過去1年分）
    const oneYearAgo = new Date()
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
    const { data: existing } = await serviceClient
      .from("petty_cash_transactions")
      .select("created_at, amount, description")
      .gte("created_at", oneYearAgo.toISOString())

    const dedupeKey = (dateIso: string, amount: number, description: string | null): string => {
      // 日付(YYYY-MM-DD)・金額・内容で重複判定
      const d = dateIso.substring(0, 10)
      return `${d}|${amount}|${(description || "").trim()}`
    }

    const existingKeys = new Set<string>()
    for (const e of existing || []) {
      const k = dedupeKey(e.created_at as string, e.amount as number, e.description as string | null)
      existingKeys.add(k)
    }

    let insertedCount = 0
    let skippedCount = 0
    const skippedReasons: string[] = []
    let balanceDelta = 0

    // 1件ずつ登録（重複はスキップ）
    for (const row of rows) {
      if (!row.type || !["入金", "出金", "返金"].includes(row.type)) {
        skippedCount++
        skippedReasons.push(`不正な種別: ${row.type}`)
        continue
      }
      if (!row.amount || row.amount <= 0) {
        skippedCount++
        continue
      }

      const createdAt = row.date || new Date().toISOString()
      const key = dedupeKey(createdAt, row.amount, row.description)

      if (existingKeys.has(key)) {
        skippedCount++
        continue
      }

      const { error: insertError } = await serviceClient
        .from("petty_cash_transactions")
        .insert({
          type: row.type,
          amount: row.amount,
          description: row.description,
          registered_by: row.staff || registeredBy,
          created_at: createdAt,
        })

      if (insertError) {
        console.error("行登録エラー:", insertError, row)
        skippedCount++
        skippedReasons.push(insertError.message)
        continue
      }

      existingKeys.add(key)
      insertedCount++

      // 残高差分を計算
      if (row.type === "入金" || row.type === "返金") {
        balanceDelta += row.amount
      } else {
        balanceDelta -= row.amount
      }
    }

    // 残高更新
    const { data: settingsRaw, error: settingsError } = await serviceClient
      .from("petty_cash_settings")
      .select("*")
      .limit(1)
      .single()

    if (settingsError) throw settingsError
    const settings = settingsRaw as unknown as { id: string; balance: number }
    const newBalance = (settings.balance || 0) + balanceDelta

    const { error: updateError } = await serviceClient
      .from("petty_cash_settings")
      .update({ balance: newBalance, updated_at: new Date().toISOString() })
      .eq("id", settings.id)

    if (updateError) throw updateError

    return NextResponse.json({
      inserted: insertedCount,
      skipped: skippedCount,
      skipped_reasons: skippedReasons.slice(0, 10),
      balance: newBalance,
    })
  } catch (error) {
    console.error("インポート実行エラー:", error)
    return NextResponse.json({ error: error instanceof Error ? error.message : "インポートに失敗しました" }, { status: 500 })
  }
}
