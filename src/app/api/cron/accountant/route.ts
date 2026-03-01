import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { copyFile, createCsvInDropbox, ensureDropboxFolderExists } from "@/lib/dropbox"
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

/**
 * Vercel Cron Jobs用の税理士提出フォルダ自動作成
 * 毎月1日に前月分を自動実行する
 * vercel.json: { "crons": [{ "path": "/api/cron/accountant", "schedule": "0 0 1 * *" }] }
 */
export async function GET(request: NextRequest) {
  // Vercel Cron認証チェック
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = await createClient()

  try {
    // 自動実行が有効な全ユーザーを取得
    const { data: enabledSettings } = await supabase
      .from("settings")
      .select("user_id, value")
      .eq("key", "accountant_auto_enabled")

    if (!enabledSettings || enabledSettings.length === 0) {
      return NextResponse.json({ message: "自動実行が有効なユーザーがいません" })
    }

    // 前月を計算
    const now = new Date()
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const yearStr = String(prevMonth.getFullYear())
    const monthStr = String(prevMonth.getMonth() + 1).padStart(2, "0")
    const year = prevMonth.getFullYear()
    const month = prevMonth.getMonth() + 1

    const dateFrom = `${yearStr}-${monthStr}-01`
    const lastDay = new Date(year, month, 0).getDate()
    const dateTo = `${yearStr}-${monthStr}-${String(lastDay).padStart(2, "0")}`

    const processedUsers: string[] = []

    for (const setting of enabledSettings) {
      // accountant_auto_enabled が true でなければスキップ
      if (setting.value !== true) continue

      const userId = setting.user_id

      // そのユーザーの対象種別を取得
      const { data: typeSetting } = await supabase
        .from("settings")
        .select("value")
        .eq("key", "accountant_doc_types")
        .eq("user_id", userId)
        .maybeSingle()

      const docTypes =
        typeSetting?.value && Array.isArray(typeSetting.value)
          ? (typeSetting.value as string[])
          : DEFAULT_DOC_TYPES

      // 対象月の書類を取得
      const { data: rawDocuments } = await supabase
        .from("documents")
        .select("*")
        .in("type", docTypes)
        .gte("issue_date", dateFrom)
        .lte("issue_date", dateTo)
        .order("type", { ascending: true })
        .order("issue_date", { ascending: true })

      const documents = rawDocuments as DocumentRow[] | null

      if (!documents || documents.length === 0) continue

      // 税理士提出フォルダのベースパス
      const basePath = `/経理書類/税理士提出/${year}年/${monthStr}月`
      await ensureDropboxFolderExists(basePath)

      // 種別ごとにグループ化
      const groupedDocs = new Map<string, DocumentRow[]>()
      for (const doc of documents) {
        const typeDocs = groupedDocs.get(doc.type) ?? []
        typeDocs.push(doc)
        groupedDocs.set(doc.type, typeDocs)
      }

      const csvRows: string[] = []

      for (const [type, docs] of groupedDocs) {
        const typeFolderPath = `${basePath}/${type}`
        await ensureDropboxFolderExists(typeFolderPath)

        for (const doc of docs) {
          if (doc.dropbox_path) {
            try {
              const fileName = doc.dropbox_path.split("/").pop() ?? `${doc.vendor_name}.pdf`
              await copyFile(doc.dropbox_path, `${typeFolderPath}/${fileName}`)

              csvRows.push(
                [
                  escapeCsvField(doc.type),
                  escapeCsvField(doc.vendor_name),
                  doc.amount?.toString() ?? "",
                  doc.issue_date ?? "",
                  escapeCsvField(fileName),
                ].join(",")
              )
            } catch (copyError) {
              console.error(`[Cron] ファイルコピーエラー (${doc.id}):`, copyError)
            }
          }
        }
      }

      // CSVサマリー生成
      if (csvRows.length > 0) {
        const csvHeader = "種別,取引先,金額,発行日,ファイル名"
        const csvContent = [csvHeader, ...csvRows].join("\n")
        const csvPath = `${basePath}/提出書類一覧_${monthStr}月.csv`

        try {
          await createCsvInDropbox(csvPath, csvContent)
        } catch (csvError) {
          console.error("[Cron] CSVファイル作成エラー:", csvError)
        }
      }

      processedUsers.push(userId)
    }

    return NextResponse.json({
      message: `${processedUsers.length}件のユーザーの税理士提出フォルダを作成しました`,
      target_month: `${yearStr}-${monthStr}`,
      processed_users: processedUsers.length,
    })
  } catch (error) {
    console.error("[Cron] 税理士提出フォルダ作成エラー:", error)
    return NextResponse.json(
      { error: "税理士提出フォルダの自動作成に失敗しました" },
      { status: 500 }
    )
  }
}

/** CSVフィールドをエスケープする */
function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}
