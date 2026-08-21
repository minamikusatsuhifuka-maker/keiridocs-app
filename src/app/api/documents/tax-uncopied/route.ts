import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import {
  findUncopiedStaffReimburse,
  currentSubmissionMonth,
  previousSubmissionMonth,
} from "@/lib/tax-uncopied"

export const maxDuration = 60

/**
 * 税理士提出フォルダに未コピーのスタッフ立替の件数・一覧を返す（参照のみ）。
 *
 * 提出書類一覧はコピー済みファイルを起点に作られるため、コピー実行後に申請された分は
 * 次のコピーまでリストに出ない。画面で「未コピーがN件あります」と気づけるようにする。
 *
 * GET /api/documents/tax-uncopied?year=2026&month=8
 *   年月を指定するとその月だけを返す。
 * GET /api/documents/tax-uncopied
 *   省略時は「今の対象月（受付中）」と「直前の締め済み月」の2ヶ月分を返す。
 *   締め当日の夜に申請された分は直前の締め済み月に出るため、両方見ないと取りこぼしに気づけない。
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }
  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "閲覧権限がありません" }, { status: 403 })
  }

  const sp = new URL(request.url).searchParams
  const hasExplicitMonth = sp.has("year") || sp.has("month")
  const cur = currentSubmissionMonth()
  const prev = previousSubmissionMonth()
  const year = Number(sp.get("year") ?? cur.year)
  const month = Number(sp.get("month") ?? cur.month)
  if (!Number.isFinite(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "年が不正です" }, { status: 400 })
  }
  if (!Number.isFinite(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: "月が不正です" }, { status: 400 })
  }

  try {
    const wanted = hasExplicitMonth ? [{ year, month }] : [prev, cur]
    const months = []
    for (const w of wanted) {
      months.push(await findUncopiedStaffReimburse({ supabase, year: w.year, month: w.month }))
    }
    return NextResponse.json({ months, current: cur })
  } catch (e) {
    console.error("未コピー検出エラー:", e)
    return NextResponse.json({ error: "未コピーの確認に失敗しました" }, { status: 500 })
  }
}
