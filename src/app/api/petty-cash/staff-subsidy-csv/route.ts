import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { buildStaffSubsidyCsv } from "@/lib/staff-subsidy-csv"
import type { Database } from "@/types/database"

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createClient<Database>(url, serviceKey)
}

/**
 * GET /api/petty-cash/staff-subsidy-csv?year=2026&month=5
 * 会計士向け「スタッフ立替明細」CSVをダウンロード（税理士提出フォルダへコピーされるものと同一）。
 *
 * 項目（領収書1件ごと・7列）: 対象スタッフ / 支払年月日 / 支払先 / 目的・用途 /
 *       支払金額 / 支給割合（全額・半額）/ 支給額（calcSubsidyで半額計算反映）
 * ＋ スタッフごとの小計行 ＋ 全体合計行。
 */
export async function GET(req: NextRequest) {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(req.url)
    const year = Number(searchParams.get("year"))
    const month = Number(searchParams.get("month"))

    if (!year || !month) {
      return NextResponse.json({ error: "year/monthが必要です" }, { status: 400 })
    }
    if (month < 1 || month > 12) {
      return NextResponse.json({ error: "月が不正です" }, { status: 400 })
    }

    // 集計は全スタッフ分を対象にするためサービスロールで読み取る
    const serviceClient = createServiceClient()
    const built = await buildStaffSubsidyCsv({ supabase: serviceClient, year, month })

    // ファイル名は日本語のためRFC5987エンコードで指定
    const encodedName = encodeURIComponent(built.fileName)

    return new NextResponse(built.csvWithBom, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="staff_subsidy_${year}_${String(month).padStart(2, "0")}.csv"; filename*=UTF-8''${encodedName}`,
      },
    })
  } catch (e: unknown) {
    console.error("[petty-cash/staff-subsidy-csv]", e)
    const msg = e instanceof Error ? e.message : "unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
