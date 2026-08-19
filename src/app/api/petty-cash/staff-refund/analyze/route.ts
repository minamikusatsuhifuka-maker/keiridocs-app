import { NextRequest, NextResponse } from "next/server"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { analyzeDocument, STAFF_RECEIPT_ANALYSIS_EXTRA_HINT } from "@/lib/gemini"
import { deriveReceiptCandidates, type ReceiptCandidate } from "@/lib/staff-receipt-split"

/** 解析結果の1行分（単体表示・分割候補の両方で同じ形） */
interface AnalyzedRow {
  vendor: string
  amount: number
  date: string | null
  note: string
}

/** ファイル1つ分の解析結果 */
interface AnalyzedFile {
  filename: string
  /** ファイル全体を1件として登録する場合の値 */
  single: AnalyzedRow
  /** 複数の領収証を検出した場合の分割候補（2件以上のときのみ。無ければ空配列） */
  splitCandidates: AnalyzedRow[]
  error?: string
}

function toRow(c: ReceiptCandidate): AnalyzedRow {
  return { vendor: c.store, amount: c.amount, date: c.date || null, note: c.note }
}

/**
 * POST /api/petty-cash/staff-refund/analyze
 * 複数領収書を Gemini で一括解析（DB未登録のプレビュー）
 *
 * 1ファイルに独立した領収証が複数含まれる場合は splitCandidates に支払いごとの候補を返す
 * （登録するかどうかは確認UI側でユーザーが選ぶ。迷う場合はAI側が分割しない＝安全側）。
 *
 * multipart/form-data:
 *  - files: File[]
 *  - staff_name: string
 */
export async function POST(req: NextRequest) {
  // 認証チェック（管理画面からのみ利用）
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const formData = await req.formData()
    const files = formData.getAll("files") as File[]
    const staffName = (formData.get("staff_name") as string) ?? ""

    if (!files || files.length === 0) {
      return NextResponse.json({ error: "ファイルを1つ以上添付してください" }, { status: 400 })
    }

    const analyzed: AnalyzedFile[] = []

    for (const file of files) {
      const arrayBuffer = await file.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      const base64 = buffer.toString("base64")

      try {
        const result = await analyzeDocument(base64, file.type || "application/octet-stream", {
          documentTypes: ["領収書"],
          extraHint: STAFF_RECEIPT_ANALYSIS_EXTRA_HINT,
        })

        analyzed.push({
          filename: file.name,
          single: {
            vendor: result.vendor_name ?? "",
            amount: Number(result.amount ?? 0),
            date: result.issue_date ?? null,
            note: result.description ?? "",
          },
          splitCandidates: deriveReceiptCandidates(result).map(toRow),
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "解析失敗"
        analyzed.push({
          filename: file.name,
          single: { vendor: "", amount: 0, date: null, note: "" },
          splitCandidates: [],
          error: msg,
        })
      }
    }

    return NextResponse.json({
      success: true,
      staff_name: staffName,
      files: analyzed,
    })
  } catch (e: unknown) {
    console.error("[staff-refund/analyze]", e)
    const msg = e instanceof Error ? e.message : "unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
