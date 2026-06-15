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
 * 税理士向け「スタッフ別支給額一覧」CSVをダウンロード。
 *
 * 項目: スタッフ名 / 立替額合計 / 区分内訳（初参加・2回目以降・それ以外の件数）/
 *       支給額合計（半額計算反映）/ 小口支給額 / 給与支給額 / 保管のみ件数
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
