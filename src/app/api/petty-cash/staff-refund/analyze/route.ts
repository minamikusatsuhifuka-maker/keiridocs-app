import { NextRequest, NextResponse } from "next/server"
import { analyzeDocument } from "@/lib/gemini"

/**
 * POST /api/petty-cash/staff-refund/analyze
 * 複数領収書を Gemini で一括解析（DB未登録のプレビュー）
 *
 * multipart/form-data:
 *  - files: File[]
 *  - staff_name: string
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const files = formData.getAll("files") as File[]
    const staffName = (formData.get("staff_name") as string) ?? ""

    if (!files || files.length === 0) {
      return NextResponse.json({ error: "ファイルを1つ以上添付してください" }, { status: 400 })
    }

    const items: Array<{
      filename: string
      vendor: string
      amount: number
      date: string | null
      note?: string
      error?: string
    }> = []

    for (const file of files) {
      const arrayBuffer = await file.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      const base64 = buffer.toString("base64")

      try {
        const result = await analyzeDocument(base64, file.type || "application/octet-stream", {
          documentTypes: ["領収書"],
          extraHint:
            "これはスタッフが立て替えた領収書です。発行店名(vendor_name)、合計金額(amount)、日付(issue_date YYYY-MM-DD)を必ず抽出してください。",
        })

        items.push({
          filename: file.name,
          vendor: result.vendor_name ?? "",
          amount: Number(result.amount ?? 0),
          date: result.issue_date ?? null,
          note: result.description ?? "",
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "解析失敗"
        items.push({
          filename: file.name,
          vendor: "",
          amount: 0,
          date: null,
          error: msg,
        })
      }
    }

    const total = items.reduce((sum, it) => sum + (Number(it.amount) || 0), 0)

    return NextResponse.json({
      success: true,
      staff_name: staffName,
      items,
      total,
    })
  } catch (e: unknown) {
    console.error("[staff-refund/analyze]", e)
    const msg = e instanceof Error ? e.message : "unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
