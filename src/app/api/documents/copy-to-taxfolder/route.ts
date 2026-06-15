import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  copyFileNoOverwrite,
  ensureDropboxFolderExists,
  fileExists,
  listFilesRecursive,
  uploadFileOverwrite,
} from "@/lib/dropbox"
import { getCurrentUserRole } from "@/lib/auth"
import { buildTaxSubmissionCsv } from "@/lib/tax-submission-csv"
import { buildStaffSubsidyCsv } from "@/lib/staff-subsidy-csv"

/** 税理士提出フォルダのコピー対象ソースフォルダ */
const ALL_SOURCE_FOLDERS = [
  "請求書",
  "領収書",
  "社会保険料",
  "その他",
  "スタッフ領収書",
  "売上",
] as const

/** 税理士提出先フォルダ内でサブフォルダに配置するソースフォルダ */
const TAX_SUBFOLDER_MAP: Record<string, string> = {
  "売上": "売上",
}

/** dropbox_path から税理士提出先サブフォルダ名を判定する */
function getTaxSubfolderForPath(dropboxPath: string): string | null {
  for (const [sourceFolder, subfolder] of Object.entries(TAX_SUBFOLDER_MAP)) {
    if (dropboxPath.startsWith(`/経理書類/${sourceFolder}/`)) {
      return subfolder
    }
  }
  return null
}

type CopyStatus = "copied" | "skipped" | "failed"

interface CopyDetail {
  file_name: string
  type: string
  vendor_name: string
  amount: number | null
  date: string
  source: "db" | "dropbox"
  status: CopyStatus
  message?: string
}

/**
 * 指定した年月の書類を税理士提出フォルダに一括コピー
 *
 * リクエスト: { year: number, month: number, folders?: string[] }
 * レスポンス: { copied, skipped, failed, total, details, csv }
 *
 * 処理フロー:
 *   a. DBの処理済み書類（指定年月・選択フォルダ範囲内）をコピー
 *   b. DBに無いファイルもDropboxを再帰スキャン → 年月判定 → コピー
 *   c. 既に存在する場合はスキップ（fileExists or to/conflict）
 *   d. 結果は CSV 形式の文字列としても返す
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "コピー権限がありません" }, { status: 403 })
  }

  try {
    const body = await request.json() as {
      year: unknown
      month: unknown
      folders: unknown
    }
    const yearNum = typeof body.year === "number" ? body.year : Number(body.year)
    const monthNum = typeof body.month === "number" ? body.month : Number(body.month)

    if (!Number.isFinite(yearNum) || !Number.isFinite(monthNum)) {
      return NextResponse.json({ error: "年月を指定してください" }, { status: 400 })
    }
    if (yearNum < 2000 || yearNum > 2100) {
      return NextResponse.json({ error: "年が不正です" }, { status: 400 })
    }
    if (monthNum < 1 || monthNum > 12) {
      return NextResponse.json({ error: "月が不正です" }, { status: 400 })
    }

    // 対象フォルダ（未指定 or 空の場合は全フォルダ）
    const requestedFolders = Array.isArray(body.folders)
      ? body.folders.filter((f): f is string => typeof f === "string")
      : []
    const targetFolders = requestedFolders.length > 0
      ? requestedFolders.filter((f) => (ALL_SOURCE_FOLDERS as readonly string[]).includes(f))
      : [...ALL_SOURCE_FOLDERS]

    if (targetFolders.length === 0) {
      return NextResponse.json({ error: "対象フォルダを1つ以上選択してください" }, { status: 400 })
    }

    // 対象月の範囲（issue_date 基準）
    const monthStr = String(monthNum).padStart(2, "0")
    const dateFrom = `${yearNum}-${monthStr}-01`
    const nextYear = monthNum === 12 ? yearNum + 1 : yearNum
    const nextMonth = monthNum === 12 ? 1 : monthNum + 1
    const dateToExclusive = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`

    const taxFolderBase = `/経理書類/税理士提出/${yearNum}年${monthStr}月`

    // 税理士提出フォルダを事前作成
    try {
      await ensureDropboxFolderExists(taxFolderBase)
    } catch (folderError) {
      console.error("税理士提出フォルダ作成エラー:", folderError)
    }

    // 売上が選択されている場合は売上サブフォルダも作成
    if (targetFolders.includes("売上")) {
      try {
        await ensureDropboxFolderExists(`${taxFolderBase}/売上`)
      } catch (folderError) {
        console.error("税理士提出 売上フォルダ作成エラー:", folderError)
      }
    }

    /* --- pass 1: DB 書類のコピー --- */
    let dbQuery = supabase
      .from("documents")
      .select("id, dropbox_path, vendor_name, amount, type, issue_date, status")
      .eq("status", "処理済み")
      .gte("issue_date", dateFrom)
      .lt("issue_date", dateToExclusive)
      .not("dropbox_path", "is", null)

    if (auth.role !== "admin") {
      dbQuery = dbQuery.eq("user_id", user.id)
    }

    const { data: dbDocs, error: fetchError } = await dbQuery

    if (fetchError) {
      console.error("書類取得エラー:", fetchError)
      return NextResponse.json({ error: "書類の取得に失敗しました" }, { status: 500 })
    }

    // 全DB書類のdropbox_pathセット（pass 2 で重複除外用）
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

    const details: CopyDetail[] = []
    let copied = 0
    let skipped = 0
    let failed = 0

    // pass 1: DB書類を、選択フォルダに該当するものだけコピー
    const targetFolderPrefixes = targetFolders.map((f) => `/経理書類/${f}/`)
    const dbDocsForCopy = (dbDocs ?? []).filter((d): d is {
      id: string
      dropbox_path: string
      vendor_name: string
      amount: number | null
      type: string
      issue_date: string | null
      status: string
    } => {
      if (typeof d.dropbox_path !== "string" || d.dropbox_path.length === 0) return false
      // 選択フォルダ配下のみ
      return targetFolderPrefixes.some((prefix) => d.dropbox_path!.startsWith(prefix))
    })

    for (const doc of dbDocsForCopy) {
      const fileName = doc.dropbox_path.split("/").pop() ?? ""
      if (!fileName) {
        failed++
        details.push({
          file_name: doc.dropbox_path,
          type: doc.type,
          vendor_name: doc.vendor_name ?? "",
          amount: doc.amount,
          date: doc.issue_date ?? "",
          source: "db",
          status: "failed",
          message: "ファイル名が取得できませんでした",
        })
        continue
      }

      // 売上書類は税理士提出/売上/ サブフォルダに配置
      const subfolder = getTaxSubfolderForPath(doc.dropbox_path)
      const toPath = subfolder
        ? `${taxFolderBase}/${subfolder}/${fileName}`
        : `${taxFolderBase}/${fileName}`
      const result = await copyOne(doc.dropbox_path, toPath)
      if (result.status === "copied") copied++
      else if (result.status === "skipped") skipped++
      else failed++

      details.push({
        file_name: fileName,
        type: doc.type,
        vendor_name: doc.vendor_name ?? "",
        amount: doc.amount,
        date: doc.issue_date ?? "",
        source: "db",
        status: result.status,
        message: result.message,
      })
      await sleep(60)
    }

    /* --- pass 2: DBにないファイルをDropbox再帰スキャン --- */
    // 既に処理したパス（pass 1 のもの）も除外
    const processedPaths = new Set<string>(
      dbDocsForCopy.map((d) => d.dropbox_path)
    )

    for (const folderName of targetFolders) {
      // スタッフ領収書はDB(petty_cash_transactions)起点で 領収書/{スタッフ名}/ に整理してコピーするため、
      // ここの汎用フラットコピーからは除外する（下の専用パスで処理）
      if (folderName === "スタッフ領収書") continue

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

        // pass 1 で処理済み or 他月のDB書類はスキップ
        if (processedPaths.has(file.path_display)) continue
        if (dbPathSet.has(file.path_display)) continue

        // ファイル名 or 更新日時から年月を判定
        const fileMonth = extractYearMonth(file.name, file.client_modified)
        if (!fileMonth) continue
        if (fileMonth.year !== yearNum || fileMonth.month !== monthNum) continue

        // 種別はフォルダ名から推定（売上フォルダは「売上記録」として扱う）
        const inferredType = folderName === "売上" ? "売上記録" : folderName

        // 売上書類は税理士提出/売上/ サブフォルダに配置
        const subfolder = TAX_SUBFOLDER_MAP[folderName]
        const toPath = subfolder
          ? `${taxFolderBase}/${subfolder}/${file.name}`
          : `${taxFolderBase}/${file.name}`
        const result = await copyOne(file.path_display, toPath)
        if (result.status === "copied") copied++
        else if (result.status === "skipped") skipped++
        else failed++

        details.push({
          file_name: file.name,
          type: inferredType,
          vendor_name: "",
          amount: null,
          date: file.client_modified ? file.client_modified.split("T")[0] : "",
          source: "dropbox",
          status: result.status,
          message: result.message,
        })
        processedPaths.add(file.path_display)
        await sleep(60)
      }
    }

    /* --- pass 3: スタッフ領収書（小口現金）を 領収書/{スタッフ名}/ にコピー --- */
    // petty_cash_transactions の staff_refund 領収書を、精算方法によらず対象月分すべてコピー
    if (targetFolders.includes("スタッフ領収書")) {
      try {
        const { data: staffTxRaw, error: staffTxError } = await supabase
          .from("petty_cash_transactions")
          .select("id, amount, staff_member_id, receipt_urls, transaction_date, created_at")
          .eq("category", "staff_refund")
          .not("receipt_urls", "is", null)

        if (staffTxError) {
          console.error("スタッフ領収書取得エラー:", staffTxError)
        } else {
          // スタッフ名マップ
          const { data: staffRaw } = await supabase
            .from("staff_members")
            .select("id, name")
          const staffNameMap = new Map<string, string>()
          for (const s of (staffRaw ?? []) as { id: string; name: string }[]) {
            staffNameMap.set(s.id, s.name)
          }

          // 既に作成したスタッフ用サブフォルダを記録（重複ensure回避）
          const ensuredStaffFolders = new Set<string>()

          for (const tx of staffTxRaw ?? []) {
            // 対象月判定（transaction_date 優先、無ければ created_at）
            const basis =
              (typeof tx.transaction_date === "string" && tx.transaction_date) ||
              (typeof tx.created_at === "string" ? tx.created_at.slice(0, 10) : "")
            if (!basis) continue
            if (basis < dateFrom || basis >= dateToExclusive) continue

            const urls = Array.isArray(tx.receipt_urls)
              ? (tx.receipt_urls as unknown[]).filter(
                  (u): u is string => typeof u === "string" && u.length > 0
                )
              : []
            if (urls.length === 0) continue

            const staffName =
              (tx.staff_member_id && staffNameMap.get(tx.staff_member_id)) || "不明なスタッフ"
            const staffFolder = `${taxFolderBase}/領収書/${staffName}`

            // スタッフ用サブフォルダを作成
            if (!ensuredStaffFolders.has(staffFolder)) {
              try {
                await ensureDropboxFolderExists(staffFolder)
              } catch (folderError) {
                console.error(`税理士提出 領収書フォルダ作成エラー (${staffFolder}):`, folderError)
              }
              ensuredStaffFolders.add(staffFolder)
            }

            for (const fromPath of urls) {
              const fileName = fromPath.split("/").pop() ?? ""
              if (!fileName) continue
              const toPath = `${staffFolder}/${fileName}`
              const result = await copyOne(fromPath, toPath)
              if (result.status === "copied") copied++
              else if (result.status === "skipped") skipped++
              else failed++

              details.push({
                file_name: fileName,
                type: "スタッフ領収書",
                vendor_name: staffName,
                amount: typeof tx.amount === "number" ? tx.amount : null,
                date: basis,
                source: "db",
                status: result.status,
                message: result.message,
              })
              await sleep(60)
            }
          }
        }
      } catch (staffErr) {
        console.error("スタッフ領収書コピーパスエラー:", staffErr)
      }
    }

    // CSV 文字列を生成（ファイル名,種別,取引先,金額,日付,コピー結果）— UI表示用
    const csvHeader = ["ファイル名", "種別", "取引先", "金額", "日付", "コピー結果"]
    const csvRows = details.map((d) => [
      d.file_name,
      d.type,
      d.vendor_name,
      d.amount != null ? String(d.amount) : "",
      d.date,
      d.status === "copied" ? "成功" : d.status === "skipped" ? "スキップ" : "失敗",
    ])
    const csvBody = [csvHeader, ...csvRows]
      .map((row) => row.map(escapeCsv).join(","))
      .join("\n")

    // 提出書類一覧CSV（経費）と売上提出一覧CSV（売上）を分離生成し、
    // それぞれDropboxにアップロードする（既存は上書き）
    let csvDropboxPath: string | null = null
    let salesCsvDropboxPath: string | null = null
    let staffSubsidyCsvDropboxPath: string | null = null
    let csvSaveError: string | null = null

    // 経費CSV: 月フォルダ直下に保存（売上行は除外）
    try {
      const built = await buildTaxSubmissionCsv({
        supabase,
        isAdmin: auth.role === "admin",
        userId: user.id,
        year: yearNum,
        month: monthNum,
        scope: "expense",
      })
      const targetCsvPath = `${built.saveFolderPath}/${built.fileName}`
      const buffer = Buffer.from(built.csvWithBom, "utf-8")
      csvDropboxPath = await uploadFileOverwrite(targetCsvPath, buffer)
      console.log(
        `経費の提出書類一覧CSVを保存しました: ${csvDropboxPath} (${built.rowCount}件)`
      )
    } catch (csvError) {
      csvSaveError = csvError instanceof Error ? csvError.message : String(csvError)
      console.error("提出書類一覧CSV保存エラー:", csvError)
    }

    // 売上CSV: 売上サブフォルダ内に保存（売上が対象に含まれ、かつ売上書類が存在する場合のみ）
    if (targetFolders.includes("売上")) {
      try {
        const builtSales = await buildTaxSubmissionCsv({
          supabase,
          isAdmin: auth.role === "admin",
          userId: user.id,
          year: yearNum,
          month: monthNum,
          scope: "sales",
        })
        // 売上資料が1件も無ければ売上CSVは作成しない
        if (builtSales.rowCount > 0) {
          const targetSalesCsvPath = `${builtSales.saveFolderPath}/${builtSales.fileName}`
          const buffer = Buffer.from(builtSales.csvWithBom, "utf-8")
          salesCsvDropboxPath = await uploadFileOverwrite(targetSalesCsvPath, buffer)
          console.log(
            `売上提出一覧CSVを保存しました: ${salesCsvDropboxPath} (${builtSales.rowCount}件)`
          )
        }
      } catch (csvError) {
        const msg = csvError instanceof Error ? csvError.message : String(csvError)
        // 経費CSVのエラーと区別して併記する
        csvSaveError = csvSaveError ? `${csvSaveError} / 売上CSV: ${msg}` : `売上CSV: ${msg}`
        console.error("売上提出一覧CSV保存エラー:", csvError)
      }
    }

    // スタッフ別支給額CSV: スタッフ領収書が対象に含まれるとき、領収書サブフォルダ内に保存
    // 税理士提出/{YYYY年MM月}/領収書/スタッフ別支給額_{YYYY年MM月}.csv
    if (targetFolders.includes("スタッフ領収書")) {
      try {
        const builtSubsidy = await buildStaffSubsidyCsv({
          supabase,
          year: yearNum,
          month: monthNum,
        })
        // スタッフ返金が1件もなければCSVは作成しない
        if (builtSubsidy.rowCount > 0) {
          const subsidyFolder = `${taxFolderBase}/領収書`
          try {
            await ensureDropboxFolderExists(subsidyFolder)
          } catch (folderError) {
            console.error("税理士提出 領収書フォルダ作成エラー（支給額CSV用）:", folderError)
          }
          const targetSubsidyCsvPath = `${subsidyFolder}/${builtSubsidy.fileName}`
          const buffer = Buffer.from(builtSubsidy.csvWithBom, "utf-8")
          staffSubsidyCsvDropboxPath = await uploadFileOverwrite(targetSubsidyCsvPath, buffer)
          console.log(
            `スタッフ別支給額CSVを保存しました: ${staffSubsidyCsvDropboxPath} (${builtSubsidy.rowCount}名)`
          )
        }
      } catch (csvError) {
        const msg = csvError instanceof Error ? csvError.message : String(csvError)
        csvSaveError = csvSaveError ? `${csvSaveError} / 支給額CSV: ${msg}` : `支給額CSV: ${msg}`
        console.error("スタッフ別支給額CSV保存エラー:", csvError)
      }
    }

    return NextResponse.json({
      copied,
      skipped,
      failed,
      total: details.length,
      details,
      csv: csvBody,
      csvDropboxPath,
      salesCsvDropboxPath,
      staffSubsidyCsvDropboxPath,
      csvSaveError,
    })
  } catch (error) {
    console.error("税理士フォルダコピーエラー:", error)
    return NextResponse.json({ error: "コピー処理に失敗しました" }, { status: 500 })
  }
}

/** 1ファイルをコピー（既存ならスキップ） */
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

/** ファイル名 → 年月抽出。失敗時は client_modified にフォールバック */
function extractYearMonth(
  fileName: string,
  clientModified: string
): { year: number; month: number } | null {
  // YYYYMMDD / YYYY-MM-DD / YYYY_MM_DD / YYYY.MM.DD のいずれか
  const match = fileName.match(/(20\d{2})[-_./]?(\d{2})[-_./]?(\d{2})/)
  if (match) {
    const y = Number(match[1])
    const mo = Number(match[2])
    const d = Number(match[3])
    if (
      y >= 2000 && y <= 2100 &&
      mo >= 1 && mo <= 12 &&
      d >= 1 && d <= 31
    ) {
      return { year: y, month: mo }
    }
  }

  // フォールバック: 更新日時
  if (clientModified) {
    const date = new Date(clientModified)
    if (!isNaN(date.getTime())) {
      return { year: date.getFullYear(), month: date.getMonth() + 1 }
    }
  }
  return null
}

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
