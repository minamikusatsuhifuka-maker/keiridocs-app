import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  copyFileNoOverwrite,
  downloadFile,
  ensureDropboxFolderExists,
  fileExists,
  listFilesRecursive,
} from "@/lib/dropbox"
import { getCurrentUserRole } from "@/lib/auth"
import { analyzeDocument } from "@/lib/gemini"

// Gemini SDK / Dropbox の重い処理を含むため Node ランタイム・最大実行時間を確保
export const runtime = "nodejs"
export const maxDuration = 300

/** 税理士提出フォルダのコピー対象ソースフォルダ */
const ALL_SOURCE_FOLDERS = [
  "請求書",
  "領収書",
  "社会保険料",
  "その他",
  "スタッフ領収書",
  "売上",
] as const

/** 追加分を示すファイル名プレフィックス */
const ADDITIONAL_PREFIX = "【追加】"

/** AI年月判定を行うMIMEタイプ（画像・PDFのみ） */
const AI_MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  webp: "image/webp",
  pdf: "application/pdf",
}

/** AI年月判定に費やす時間の上限（ms）。超過分は「要確認」に回す */
const AI_DEADLINE_MS = 240_000

type CopyTarget = "本体" | "追加分"
type CopyStatus = "copied" | "skipped" | "failed"

interface CopyDetail {
  file_name: string
  year: number
  month: number
  target: CopyTarget
  source: "db" | "dropbox"
  status: CopyStatus
  message?: string
}

interface NeedsReviewEntry {
  file_name: string
  path: string
  source: "db" | "dropbox"
  reason: string
}

interface MonthSummary {
  year: number
  month: number
  toBody: number
  toAdditional: number
  skipped: number
  needsReview: number
}

/** 月ごとの提出状況スナップショット（実行開始時点） */
interface MonthState {
  year: number
  month: number
  base: string
  /** 実行開始時点でこの月が既に提出済みか（本体 or サブフォルダにファイルがある） */
  alreadySubmitted: boolean
  /** 月フォルダ内に既に存在するファイル名（【追加】を除去した正規化名） */
  existingNames: Set<string>
  /** 作成済みサブフォルダ（重複ensure回避） */
  ensuredDirs: Set<string>
  summary: MonthSummary
}

/**
 * 追加分の一括取り込み（月指定不要）
 *
 * 後から届いた資料を、AIが対象年月を判断して全期間まとめて1回でコピーする。
 *  - DB管理の処理済み書類 → 保存済みの issue_date から年月を決定
 *  - DBに無い手動アップロード分 → ファイル名の日付、無ければAIが日付を読み取り年月を決定
 *  - 判定不能は「要確認」に振り分けてスキップ
 *  - 未提出かつその月が未提出 → 本体（/YYYY年MM月/ 直下）へコピー（初回提出扱い）
 *  - 未提出かつその月が提出済み → 追加分（/YYYY年MM月/追加分/）へ【追加】付きでコピー
 *  - 既に提出済み（本体 or 追加分）のファイルはスキップ（コピーのみ・上書きなし）
 */
export async function POST() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "コピー権限がありません" }, { status: 403 })
  }

  const startTime = Date.now()

  try {
    const details: CopyDetail[] = []
    const needsReviewList: NeedsReviewEntry[] = []
    const monthStates = new Map<string, MonthState>()

    /** 月フォルダのスナップショットを遅延取得（キャッシュ） */
    async function getMonthState(year: number, month: number): Promise<MonthState> {
      const key = `${year}-${month}`
      const cached = monthStates.get(key)
      if (cached) return cached

      const monthStr = String(month).padStart(2, "0")
      const base = `/経理書類/税理士提出/${year}年${monthStr}月`

      let existing: Array<{ name: string }> = []
      try {
        existing = await listFilesRecursive(base)
      } catch (err) {
        console.error(`税理士提出フォルダのスキャン失敗 (${base}):`, err)
        existing = []
      }

      const existingNames = new Set<string>(
        existing.map((f) => normalizeName(f.name))
      )

      const state: MonthState = {
        year,
        month,
        base,
        // 実行開始時点でファイルが1件でもあれば「提出済み」とみなす
        alreadySubmitted: existing.length > 0,
        existingNames,
        ensuredDirs: new Set<string>(),
        summary: {
          year,
          month,
          toBody: 0,
          toAdditional: 0,
          skipped: 0,
          needsReview: 0,
        },
      }
      monthStates.set(key, state)
      return state
    }

    /**
     * 1ファイルを対象月へコピーする（本体/追加分の振り分け・重複回避を内包）。
     * @param sourceFolder ソースフォルダ名（売上サブフォルダ判定用）
     * @param staffName スタッフ名（スタッフ領収書のとき 領収書/{staffName}/ に配置）
     */
    async function copyToMonth(params: {
      fromPath: string
      fileName: string
      year: number
      month: number
      sourceFolder: string
      source: "db" | "dropbox"
      staffName?: string
    }): Promise<void> {
      const { fromPath, fileName, year, month, sourceFolder, source, staffName } = params
      const state = await getMonthState(year, month)

      // 既に税理士提出フォルダ（本体 or 追加分）に存在 → スキップ
      const norm = normalizeName(fileName)
      if (state.existingNames.has(norm)) {
        state.summary.skipped++
        details.push({
          file_name: fileName,
          year,
          month,
          target: state.alreadySubmitted ? "追加分" : "本体",
          source,
          status: "skipped",
          message: "既に税理士提出フォルダに存在します",
        })
        return
      }

      const isAdditional = state.alreadySubmitted
      const target: CopyTarget = isAdditional ? "追加分" : "本体"
      const baseDir = isAdditional ? `${state.base}/追加分` : state.base

      // 配置先サブフォルダ: スタッフ領収書 → 領収書/{staffName}、売上 → 売上、その他 → 直下
      let destDir = baseDir
      if (staffName) {
        destDir = `${baseDir}/領収書/${staffName}`
      } else if (sourceFolder === "売上") {
        destDir = `${baseDir}/売上`
      }

      // 追加分は 【追加】 プレフィックスを付与して一目で区別できるようにする
      const destName = isAdditional ? `${ADDITIONAL_PREFIX}${fileName}` : fileName
      const toPath = `${destDir}/${destName}`

      // 配置先フォルダを作成（キャッシュで重複ensure回避）
      if (!state.ensuredDirs.has(destDir)) {
        try {
          await ensureDropboxFolderExists(destDir)
        } catch (folderError) {
          console.error(`税理士提出フォルダ作成エラー (${destDir}):`, folderError)
        }
        state.ensuredDirs.add(destDir)
      }

      const result = await copyOne(fromPath, toPath)
      if (result.status === "copied") {
        // 同一実行内での二重コピー防止のため正規化名を記録
        state.existingNames.add(norm)
        if (isAdditional) state.summary.toAdditional++
        else state.summary.toBody++
      } else if (result.status === "skipped") {
        state.summary.skipped++
      }

      details.push({
        file_name: fileName,
        year,
        month,
        target,
        source,
        status: result.status,
        message: result.message,
      })
      await sleep(60)
    }

    /* ---------- 全DB書類の dropbox_path 集合（pass 2 の重複除外用） ---------- */
    let allPathsQuery = supabase
      .from("documents")
      .select("dropbox_path")
      .not("dropbox_path", "is", null)
    if (auth.role !== "admin") {
      allPathsQuery = allPathsQuery.eq("user_id", user.id)
    }
    const { data: allPathsData } = await allPathsQuery
    const dbPathSet = new Set(
      (allPathsData ?? [])
        .map((d) => d.dropbox_path)
        .filter((p): p is string => typeof p === "string")
    )

    // この実行内で処理済みのパス
    const processedPaths = new Set<string>()

    /* ---------- pass 1: DBの処理済み書類（全期間） ---------- */
    // スタッフ領収書は petty_cash_transactions 起点で pass 3 にて処理するため、
    // 汎用フォルダ（請求書/領収書/社会保険料/その他/売上）のみを対象にする
    const dbSourceFolders = ALL_SOURCE_FOLDERS.filter((f) => f !== "スタッフ領収書")
    const dbSourcePrefixes = dbSourceFolders.map((f) => `/経理書類/${f}/`)

    let dbQuery = supabase
      .from("documents")
      .select("id, dropbox_path, issue_date, status")
      .eq("status", "処理済み")
      .not("dropbox_path", "is", null)
    if (auth.role !== "admin") {
      dbQuery = dbQuery.eq("user_id", user.id)
    }
    const { data: dbDocs, error: fetchError } = await dbQuery
    if (fetchError) {
      console.error("書類取得エラー:", fetchError)
      return NextResponse.json({ error: "書類の取得に失敗しました" }, { status: 500 })
    }

    for (const doc of dbDocs ?? []) {
      const dropboxPath = doc.dropbox_path
      if (typeof dropboxPath !== "string" || dropboxPath.length === 0) continue
      // 税理士提出フォルダ自身は対象外
      if (dropboxPath.startsWith("/経理書類/税理士提出/")) continue
      // 対象ソースフォルダ配下のみ
      const matchedPrefix = dbSourcePrefixes.find((p) => dropboxPath.startsWith(p))
      if (!matchedPrefix) continue

      const fileName = dropboxPath.split("/").pop() ?? ""
      if (!fileName) continue

      const sourceFolder = matchedPrefix.replace("/経理書類/", "").replace(/\/$/, "")

      // issue_date から年月を決定
      const ym = parseYearMonthFromDate(doc.issue_date)
      if (!ym) {
        needsReviewList.push({
          file_name: fileName,
          path: dropboxPath,
          source: "db",
          reason: "発行日が未設定のため年月を判定できません",
        })
        processedPaths.add(dropboxPath)
        continue
      }

      await copyToMonth({
        fromPath: dropboxPath,
        fileName,
        year: ym.year,
        month: ym.month,
        sourceFolder,
        source: "db",
      })
      processedPaths.add(dropboxPath)
    }

    /* ---------- pass 2: DBに無い手動アップロード分（Dropbox再帰スキャン） ---------- */
    for (const folderName of dbSourceFolders) {
      const folderPath = `/経理書類/${folderName}`
      let files: Array<{ name: string; path_display: string; size: number; client_modified: string }> = []
      try {
        files = await listFilesRecursive(folderPath)
      } catch (err) {
        console.error(`フォルダスキャン失敗 (${folderPath}):`, err)
        continue
      }

      for (const file of files) {
        // 税理士提出フォルダ自身は対象外（一応ガード）
        if (file.path_display.startsWith("/経理書類/税理士提出/")) continue
        // pass 1 で処理済み or DB管理書類はスキップ
        if (processedPaths.has(file.path_display)) continue
        if (dbPathSet.has(file.path_display)) continue

        // 年月判定: ①ファイル名の日付 → ②AI（画像/PDFのみ） → ③要確認
        let ym = parseYearMonthFromFileName(file.name)

        if (!ym) {
          const mime = aiMimeType(file.name)
          if (mime && Date.now() - startTime < AI_DEADLINE_MS) {
            ym = await detectYearMonthByAI(file.path_display, mime)
          } else if (mime) {
            // 時間制限のためAI判定を見送り
            needsReviewList.push({
              file_name: file.name,
              path: file.path_display,
              source: "dropbox",
              reason: "時間制限のためAI年月判定を実行できませんでした（再実行してください）",
            })
            processedPaths.add(file.path_display)
            continue
          }
        }

        if (!ym) {
          needsReviewList.push({
            file_name: file.name,
            path: file.path_display,
            source: "dropbox",
            reason: "ファイル名・AIのいずれでも年月を判定できませんでした",
          })
          processedPaths.add(file.path_display)
          continue
        }

        await copyToMonth({
          fromPath: file.path_display,
          fileName: file.name,
          year: ym.year,
          month: ym.month,
          sourceFolder: folderName,
          source: "dropbox",
        })
        processedPaths.add(file.path_display)
      }
    }

    /* ---------- pass 3: スタッフ領収書（petty_cash_transactions, 全期間） ---------- */
    try {
      const { data: staffTxRaw, error: staffTxError } = await supabase
        .from("petty_cash_transactions")
        .select("id, amount, staff_member_id, receipt_urls, transaction_date, created_at")
        .eq("category", "staff_refund")
        .not("receipt_urls", "is", null)

      if (staffTxError) {
        console.error("スタッフ領収書取得エラー:", staffTxError)
      } else {
        const { data: staffRaw } = await supabase
          .from("staff_members")
          .select("id, name")
        const staffNameMap = new Map<string, string>()
        for (const s of (staffRaw ?? []) as { id: string; name: string }[]) {
          staffNameMap.set(s.id, s.name)
        }

        for (const tx of staffTxRaw ?? []) {
          const basis =
            (typeof tx.transaction_date === "string" && tx.transaction_date) ||
            (typeof tx.created_at === "string" ? tx.created_at.slice(0, 10) : "")

          const urls = Array.isArray(tx.receipt_urls)
            ? (tx.receipt_urls as unknown[]).filter(
                (u): u is string => typeof u === "string" && u.length > 0
              )
            : []
          if (urls.length === 0) continue

          const staffName =
            (tx.staff_member_id && staffNameMap.get(tx.staff_member_id)) || "不明なスタッフ"

          const ym = parseYearMonthFromDate(basis)
          if (!ym) {
            for (const fromPath of urls) {
              const fileName = fromPath.split("/").pop() ?? ""
              if (!fileName) continue
              if (processedPaths.has(fromPath)) continue
              needsReviewList.push({
                file_name: fileName,
                path: fromPath,
                source: "db",
                reason: "取引日が未設定のため年月を判定できません",
              })
              processedPaths.add(fromPath)
            }
            continue
          }

          for (const fromPath of urls) {
            const fileName = fromPath.split("/").pop() ?? ""
            if (!fileName) continue
            if (processedPaths.has(fromPath)) continue

            await copyToMonth({
              fromPath,
              fileName,
              year: ym.year,
              month: ym.month,
              sourceFolder: "スタッフ領収書",
              source: "db",
              staffName,
            })
            processedPaths.add(fromPath)
          }
        }
      }
    } catch (staffErr) {
      console.error("スタッフ領収書コピーパスエラー:", staffErr)
    }

    // 月別サマリー（年月降順）。要確認は月未確定のため月別には含めず totals で集計する
    const months = Array.from(monthStates.values())
      .map((s) => s.summary)
      .sort((a, b) => (b.year - a.year) || (b.month - a.month))

    const totals = {
      toBody: months.reduce((n, m) => n + m.toBody, 0),
      toAdditional: months.reduce((n, m) => n + m.toAdditional, 0),
      skipped: months.reduce((n, m) => n + m.skipped, 0),
      needsReview: needsReviewList.length,
    }

    return NextResponse.json({
      months,
      totals,
      needsReviewList,
      details,
    })
  } catch (error) {
    console.error("追加分一括取り込みエラー:", error)
    return NextResponse.json({ error: "取り込み処理に失敗しました" }, { status: 500 })
  }
}

/** 1ファイルをコピー（既存ならスキップ・上書きしない） */
async function copyOne(
  fromPath: string,
  toPath: string
): Promise<{ status: CopyStatus; message?: string }> {
  try {
    const exists = await fileExists(toPath)
    if (exists) {
      return { status: "skipped", message: "コピー先に既に存在します" }
    }
    await copyFileNoOverwrite(fromPath, toPath)
    return { status: "copied" }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("to/conflict")) {
      return { status: "skipped", message: "コピー先に既に存在します" }
    }
    if (msg.includes("from_lookup/not_found") || msg.includes("path/not_found")) {
      return { status: "failed", message: "コピー元が見つかりません" }
    }
    console.error(`コピー失敗 (${fromPath} -> ${toPath}):`, err)
    return { status: "failed", message: msg }
  }
}

/** 【追加】プレフィックスを除去した正規化ファイル名 */
function normalizeName(name: string): string {
  return name.startsWith(ADDITIONAL_PREFIX)
    ? name.slice(ADDITIONAL_PREFIX.length)
    : name
}

/** YYYY-MM-DD 文字列から年月を取得 */
function parseYearMonthFromDate(
  value: string | null | undefined
): { year: number; month: number } | null {
  if (typeof value !== "string" || value.length < 7) return null
  const m = value.match(/^(\d{4})-(\d{2})/)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null
  return { year, month }
}

/** ファイル名の日付（YYYYMMDD / YYYY-MM-DD 等）から年月を取得。mtimeは使わない */
function parseYearMonthFromFileName(
  fileName: string
): { year: number; month: number } | null {
  const match = fileName.match(/(20\d{2})[-_./]?(\d{2})[-_./]?(\d{2})/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null
  }
  return { year, month }
}

/** 拡張子からAI判定用MIMEタイプを推定（画像・PDFのみ対応） */
function aiMimeType(fileName: string): string | null {
  const ext = fileName.split(".").pop()?.toLowerCase()
  if (!ext) return null
  return AI_MIME_BY_EXT[ext] ?? null
}

/** AI（Gemini）で書類の発行日を読み取り、年月を判定する。失敗時は null */
async function detectYearMonthByAI(
  path: string,
  mimeType: string
): Promise<{ year: number; month: number } | null> {
  try {
    const { buffer } = await downloadFile(path)
    const base64Data = buffer.toString("base64")
    const result = await analyzeDocument(base64Data, mimeType)
    return parseYearMonthFromDate(result.issue_date)
  } catch (err) {
    console.error(`AI年月判定失敗 (${path}):`, err)
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
