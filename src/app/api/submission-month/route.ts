import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"
import { listFilesRecursive } from "@/lib/dropbox"
import {
  parseYearMonth,
  formatYearMonth,
  labelYearMonth,
  withManualSubmissionMonth,
  resolveDocumentSubmissionMonth,
  resolveStaffSubmissionMonth,
  sameYearMonth,
  type YearMonth,
} from "@/lib/submission-month"

export const maxDuration = 60

/**
 * 提出月（税理士提出フォルダの振り分け先）の手動指定・解除。
 *
 * POST /api/submission-month
 *   { target: "document" | "staff_receipt", ids: string[], month: "YYYY-MM" | null }
 *   month に null を渡すと手動指定を解除して自動判定に戻す。
 *
 * 保存先はスキーマ変更を避けて既存の jsonb（documents.ocr_raw / staff_receipts.ai_raw）の
 * submission_month キー。既存の値を壊さないよう read-modify-write でマージする。
 *
 * ■ 既にコピー済みのファイルについて
 *   変更前の提出月フォルダに同名ファイルが残っていると、税理士提出物に同じ資料が2ヶ月分現れる。
 *   このAPIは Dropbox のファイルを移動も削除もせず、「旧フォルダに残っているファイルの一覧」を
 *   レスポンスで返すだけにする（無断で動かさない）。画面側で警告として提示する。
 */

interface MovedWarning {
  id: string
  fileName: string
  /** 旧提出月（"YYYY年MM月"） */
  fromMonthLabel: string
  /** 旧フォルダに残っているファイルの実パス */
  path: string
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }
  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "変更権限がありません" }, { status: 403 })
  }

  let body: { target?: unknown; ids?: unknown; month?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 })
  }

  const target = body.target === "document" || body.target === "staff_receipt" ? body.target : null
  if (!target) {
    return NextResponse.json({ error: "target が不正です" }, { status: 400 })
  }
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === "string" && v.length > 0)
    : []
  if (ids.length === 0) {
    return NextResponse.json({ error: "対象を1件以上選択してください" }, { status: 400 })
  }
  if (ids.length > 500) {
    return NextResponse.json({ error: "一度に変更できるのは500件までです" }, { status: 400 })
  }

  // month: null（自動に戻す） or "YYYY-MM"
  const month: YearMonth | null = body.month === null ? null : parseYearMonth(body.month)
  if (body.month !== null && !month) {
    return NextResponse.json({ error: "提出月は YYYY-MM で指定してください" }, { status: 400 })
  }

  try {
    // 1. 対象を取得（変更前の提出月を控えるため、判定に必要な列も読む）
    const table = target === "document" ? "documents" : "staff_receipts"
    const select =
      target === "document"
        ? "id, ocr_raw, issue_date, due_date, created_at, dropbox_path"
        : "id, ai_raw, created_at, dropbox_path"
    const { data: rowsRaw, error: fetchError } = await supabase.from(table).select(select).in("id", ids)
    if (fetchError) {
      console.error("提出月の対象取得エラー:", fetchError)
      return NextResponse.json({ error: "対象の取得に失敗しました" }, { status: 500 })
    }
    const rows = (rowsRaw ?? []) as unknown as {
      id: string
      ocr_raw?: unknown
      ai_raw?: unknown
      issue_date?: string | null
      due_date?: string | null
      created_at: string
      dropbox_path: string | null
    }[]
    if (rows.length === 0) {
      return NextResponse.json({ error: "対象が見つかりませんでした" }, { status: 404 })
    }

    // 2. 変更前の提出月（＝旧フォルダの月）を控えてから、jsonbをマージ更新する
    const jsonColumn = target === "document" ? "ocr_raw" : "ai_raw"
    const oldMonths = new Map<string, YearMonth | null>()
    let updated = 0
    for (const row of rows) {
      const raw = target === "document" ? row.ocr_raw : row.ai_raw
      const before =
        target === "document"
          ? resolveDocumentSubmissionMonth(raw, row.issue_date ?? row.due_date ?? row.created_at).month
          : resolveStaffSubmissionMonth(raw, toJstDate(row.created_at)).month
      oldMonths.set(row.id, before)

      const nextRaw = withManualSubmissionMonth(raw, month)
      const { error: updateError } = await supabase
        .from(table)
        .update({ [jsonColumn]: nextRaw })
        .eq("id", row.id)
      if (updateError) {
        console.error(`提出月の更新エラー (${row.id}):`, updateError)
        continue
      }
      updated++
    }

    // 3. 旧提出月フォルダに残っているコピー済みファイルを洗い出す（削除・移動はしない）
    const warnings: MovedWarning[] = []
    const monthsToCheck = new Map<string, YearMonth>()
    for (const [id, before] of oldMonths) {
      if (!before) continue
      // 変更後と同じ月なら移動していないので確認不要
      if (sameYearMonth(before, month)) continue
      const row = rows.find((r) => r.id === id)
      if (!row?.dropbox_path) continue
      monthsToCheck.set(formatYearMonth(before), before)
    }
    for (const ym of monthsToCheck.values()) {
      const base = `/経理書類/税理士提出/${labelYearMonth(ym)}`
      let files: { name: string; path_display: string }[] = []
      try {
        files = await listFilesRecursive(base)
      } catch {
        // フォルダ未作成などは「残っていない」として扱う
        continue
      }
      const byName = new Map(files.map((f) => [f.name, f.path_display]))
      for (const [id, before] of oldMonths) {
        if (!before || !sameYearMonth(before, ym)) continue
        const row = rows.find((r) => r.id === id)
        const fileName = row?.dropbox_path?.split("/").pop() ?? ""
        const path = fileName ? byName.get(fileName) : undefined
        if (!path) continue
        warnings.push({ id, fileName, fromMonthLabel: labelYearMonth(ym), path })
      }
    }

    return NextResponse.json({
      updated,
      month: month ? formatYearMonth(month) : null,
      /** 旧提出月フォルダに残っているコピー済みファイル（手動での削除・移動が必要） */
      leftoverFiles: warnings,
    })
  } catch (e) {
    console.error("提出月の変更エラー:", e)
    return NextResponse.json({ error: "提出月の変更に失敗しました" }, { status: 500 })
  }
}

/** ISO日時 → JSTの YYYY-MM-DD */
function toJstDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
}
