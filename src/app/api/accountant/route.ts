import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { copyFile, createCsvInDropbox, ensureDropboxFolderExists } from "@/lib/dropbox"
import { getCurrentUserRole } from "@/lib/auth"
import type { Database } from "@/types/database"

type DocumentRow = Database["public"]["Tables"]["documents"]["Row"]

// デフォルトの対象書類種別
const DEFAULT_DOC_TYPES = [
  "請求書",
  "領収書",
  "売り上げ記録",
  "自動精算機の売上表",
  "社会保険料",
  "医薬品仕入",
]

// 種別ごとの処理結果
interface TypeResult {
  type: string
  count: number
  totalAmount: number
}

/**
 * 税理士提出フォルダ作成API
 * 対象月の書類をDropbox上の税理士提出フォルダにコピーし、CSVサマリーを生成する
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  // 権限チェック: admin or staff のみ実行可
  const auth = await getCurrentUserRole()
  if (auth?.role !== "admin" && auth?.role !== "staff") {
    return NextResponse.json({ error: "実行権限がありません" }, { status: 403 })
  }

  try {
    const body = await request.json() as {
      target_month?: string
      doc_types?: string[]
    }

    // 対象月を決定（YYYY-MM形式。省略時は前月）
    let targetMonth = body.target_month
    if (!targetMonth) {
      const now = new Date()
      const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      targetMonth = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, "0")}`
    }

    // YYYY-MM形式のバリデーション
    if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
      return NextResponse.json(
        { error: "target_month は YYYY-MM 形式で指定してください" },
        { status: 400 }
      )
    }

    const [yearStr, monthStr] = targetMonth.split("-")
    const year = parseInt(yearStr, 10)
    const month = parseInt(monthStr, 10)

    // 対象種別を決定（リクエストで指定があればそれを使用、なければsettingsから取得）
    let docTypes: string[] = body.doc_types ?? []

    if (docTypes.length === 0) {
      // settingsから accountant_doc_types を取得
      const { data: settingData } = await supabase
        .from("settings")
        .select("value")
        .eq("key", "accountant_doc_types")
        .eq("user_id", user.id)
        .maybeSingle()

      if (settingData?.value && Array.isArray(settingData.value)) {
        docTypes = settingData.value as string[]
      } else {
        docTypes = DEFAULT_DOC_TYPES
      }
    }

    // 対象月の書類を取得（発行日基準）
    const dateFrom = `${yearStr}-${monthStr}-01`
    const lastDay = new Date(year, month, 0).getDate()
    const dateTo = `${yearStr}-${monthStr}-${String(lastDay).padStart(2, "0")}`

    const { data: rawDocuments, error: fetchError } = await supabase
      .from("documents")
      .select("*")
      .in("type", docTypes)
      .gte("issue_date", dateFrom)
      .lte("issue_date", dateTo)
      .order("type", { ascending: true })
      .order("issue_date", { ascending: true })

    if (fetchError) {
      console.error("書類取得エラー:", fetchError)
      return NextResponse.json({ error: "書類の取得に失敗しました" }, { status: 500 })
    }

    const documents = rawDocuments as DocumentRow[] | null

    if (!documents || documents.length === 0) {
      return NextResponse.json({
        data: {
          target_month: targetMonth,
          results: [],
          total_count: 0,
          total_amount: 0,
          message: "対象月の書類が見つかりませんでした",
        },
      })
    }

    // 税理士提出フォルダのベースパス
    const basePath = `/経理書類/税理士提出/${year}年/${monthStr}月`

    // ベースフォルダを作成
    await ensureDropboxFolderExists(basePath)

    // 種別ごとにグループ化
    const groupedDocs = new Map<string, DocumentRow[]>()
    for (const doc of documents) {
      const typeDocs = groupedDocs.get(doc.type) ?? []
      typeDocs.push(doc)
      groupedDocs.set(doc.type, typeDocs)
    }

    // 種別ごとにサブフォルダ作成 & ファイルコピー
    const results: TypeResult[] = []
    const csvRows: string[] = []
    let totalCopied = 0

    for (const [type, docs] of groupedDocs) {
      const typeFolderPath = `${basePath}/${type}`
      await ensureDropboxFolderExists(typeFolderPath)

      let typeAmount = 0
      let typeCopied = 0

      for (const doc of docs) {
        if (doc.dropbox_path) {
          try {
            // ファイル名を元パスから取得
            const fileName = doc.dropbox_path.split("/").pop() ?? `${doc.vendor_name}.pdf`
            const toPath = `${typeFolderPath}/${fileName}`

            await copyFile(doc.dropbox_path, toPath)
            typeCopied++
            totalCopied++

            // CSVデータ行を追加
            csvRows.push(
              [
                escapeCsvField(doc.type),
                escapeCsvField(doc.vendor_name),
                doc.amount?.toString() ?? "",
                escapeCsvField(doc.tax_category ?? "未判定"),
                escapeCsvField(doc.account_title ?? ""),
                doc.issue_date ?? "",
                doc.due_date ?? "",
                escapeCsvField(fileName),
              ].join(",")
            )
          } catch (copyError) {
            console.error(`ファイルコピーエラー (${doc.id}):`, copyError)
            // コピー失敗しても続行する
          }
        }

        typeAmount += doc.amount ?? 0
      }

      results.push({
        type,
        count: typeCopied,
        totalAmount: typeAmount,
      })
    }

    // CSVサマリーを生成してDropboxに保存
    if (csvRows.length > 0) {
      const csvHeader = "種別,取引先,金額,税区分,勘定科目,発行日,支払期日,ファイル名"
      const csvLines = [csvHeader, ...csvRows]

      // 月次サマリーセクションを追加
      const summaryLines = buildMonthlySummary(documents)
      csvLines.push("", ...summaryLines)

      const csvContent = csvLines.join("\n")
      const csvPath = `${basePath}/提出書類一覧_${monthStr}月.csv`

      try {
        await createCsvInDropbox(csvPath, csvContent)
      } catch (csvError) {
        console.error("CSVファイル作成エラー:", csvError)
        // CSVの作成失敗は致命的ではないので続行
      }
    }

    const totalAmount = results.reduce((sum, r) => sum + r.totalAmount, 0)

    return NextResponse.json({
      data: {
        target_month: targetMonth,
        results,
        total_count: totalCopied,
        total_amount: totalAmount,
        folder_path: basePath,
      },
    })
  } catch (error) {
    console.error("税理士提出フォルダ作成エラー:", error)
    return NextResponse.json(
      { error: "税理士提出フォルダの作成に失敗しました" },
      { status: 500 }
    )
  }
}

/** 月次サマリーを生成する */
function buildMonthlySummary(documents: DocumentRow[]): string[] {
  const lines: string[] = []
  lines.push("【月次サマリー】")

  // 合計金額
  const totalAmount = documents.reduce((sum, d) => sum + (d.amount ?? 0), 0)
  lines.push(`合計金額,${totalAmount}`)
  lines.push("")

  // 税区分別の小計
  lines.push("【税区分別小計】")
  const taxMap = new Map<string, number>()
  for (const doc of documents) {
    const cat = doc.tax_category ?? "未判定"
    taxMap.set(cat, (taxMap.get(cat) ?? 0) + (doc.amount ?? 0))
  }
  for (const [cat, amount] of taxMap) {
    lines.push(`${cat},${amount}`)
  }
  lines.push("")

  // 種別別の小計
  lines.push("【種別別小計】")
  const typeMap = new Map<string, number>()
  for (const doc of documents) {
    typeMap.set(doc.type, (typeMap.get(doc.type) ?? 0) + (doc.amount ?? 0))
  }
  for (const [type, amount] of typeMap) {
    lines.push(`${type},${amount}`)
  }
  lines.push("")

  // 勘定科目別の小計
  lines.push("【勘定科目別小計】")
  const accountMap = new Map<string, number>()
  for (const doc of documents) {
    const title = doc.account_title || "未分類"
    accountMap.set(title, (accountMap.get(title) ?? 0) + (doc.amount ?? 0))
  }
  for (const [title, amount] of accountMap) {
    lines.push(`${title},${amount}`)
  }

  return lines
}

/** CSVフィールドをエスケープする */
function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}
