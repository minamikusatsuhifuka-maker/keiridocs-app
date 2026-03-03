import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCurrentUserRole } from "@/lib/auth"

/** 書類ドキュメントの必要フィールド */
interface DocEntry {
  id: string
  vendor_name: string
  amount: number | null
  type: string
  issue_date: string | null
  due_date: string | null
  dropbox_path: string | null
  file_hash: string | null
  created_at: string
}

/** 重複レベル */
type DuplicateLevel = "exact" | "likely" | "similar"

/** 重複グループ */
interface DuplicateGroup {
  level: DuplicateLevel
  match_reason: string
  vendor_name: string
  amount: number | null
  type: string
  documents: DocEntry[]
}

/**
 * 重複候補を3段階で検索するAPI
 * - exact: ファイルハッシュが同じ（完全重複）
 * - likely: 取引先＋金額＋日付が一致（高確率重複）
 * - similar: 取引先＋金額が一致、日付が異なる（類似書類）
 */
export async function GET() {
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
    // 全書類を取得（adminは全件、staffは自分のみ）
    let query = supabase
      .from("documents")
      .select("id, vendor_name, amount, type, issue_date, due_date, dropbox_path, file_hash, created_at")
      .order("created_at", { ascending: false })

    if (auth.role !== "admin") {
      query = query.eq("user_id", user.id)
    }

    const { data: documents, error } = await query

    if (error) {
      console.error("重複チェック用書類取得エラー:", error)
      return NextResponse.json({ error: "書類の取得に失敗しました" }, { status: 500 })
    }

    if (!documents || documents.length === 0) {
      return NextResponse.json({ data: [] })
    }

    const groups: DuplicateGroup[] = []
    // 処理済みのドキュメントIDを追跡（上位レベルで既にグループ化されたものをスキップ）
    const processedInExact = new Set<string>()

    // --- 1. 完全一致（ファイルハッシュが同じ） ---
    const hashGroups = new Map<string, DocEntry[]>()
    for (const doc of documents) {
      if (!doc.file_hash || doc.file_hash === "") continue
      if (!hashGroups.has(doc.file_hash)) {
        hashGroups.set(doc.file_hash, [])
      }
      hashGroups.get(doc.file_hash)!.push(doc as DocEntry)
    }

    for (const [, docs] of hashGroups) {
      if (docs.length < 2) continue
      groups.push({
        level: "exact",
        match_reason: "同一ファイル",
        vendor_name: docs[0].vendor_name,
        amount: docs[0].amount,
        type: docs[0].type,
        documents: docs,
      })
      for (const d of docs) processedInExact.add(d.id)
    }

    // --- 2. 高確率重複（取引先＋金額＋種別＋日付が一致） ---
    // vendor_name + amount + type + issue_date でグループ化
    const likelyGroups = new Map<string, DocEntry[]>()
    for (const doc of documents) {
      if (processedInExact.has(doc.id)) continue
      if (!doc.issue_date) continue
      const key = `${doc.vendor_name}|${doc.amount ?? "null"}|${doc.type}|${doc.issue_date}`
      if (!likelyGroups.has(key)) {
        likelyGroups.set(key, [])
      }
      likelyGroups.get(key)!.push(doc as DocEntry)
    }

    const processedInLikely = new Set<string>()
    for (const [, docs] of likelyGroups) {
      if (docs.length < 2) continue
      groups.push({
        level: "likely",
        match_reason: "取引先・金額・日付が一致",
        vendor_name: docs[0].vendor_name,
        amount: docs[0].amount,
        type: docs[0].type,
        documents: docs,
      })
      for (const d of docs) processedInLikely.add(d.id)
    }

    // --- 3. 類似（取引先＋金額＋種別が一致、日付が異なる） ---
    const similarGroups = new Map<string, DocEntry[]>()
    for (const doc of documents) {
      if (processedInExact.has(doc.id) || processedInLikely.has(doc.id)) continue
      const key = `${doc.vendor_name}|${doc.amount ?? "null"}|${doc.type}`
      if (!similarGroups.has(key)) {
        similarGroups.set(key, [])
      }
      similarGroups.get(key)!.push(doc as DocEntry)
    }

    for (const [, docs] of similarGroups) {
      if (docs.length < 2) continue
      groups.push({
        level: "similar",
        match_reason: "取引先・金額が一致",
        vendor_name: docs[0].vendor_name,
        amount: docs[0].amount,
        type: docs[0].type,
        documents: docs,
      })
    }

    return NextResponse.json({ data: groups })
  } catch (error) {
    console.error("重複検知エラー:", error)
    return NextResponse.json({ error: "重複検知に失敗しました" }, { status: 500 })
  }
}
