"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { DocumentTable } from "@/components/documents/document-table"
import { Download, Loader2, Plus, Search, X, Copy, Trash2, AlertTriangle, RefreshCw, CheckCircle2, XCircle, ScanLine, FolderInput, FolderPlus, Wallet, Upload, History, FileSpreadsheet } from "lucide-react"
import { toast } from "sonner"
import type { Database } from "@/types/database"
import type { DocumentStatus } from "@/types"

type Document = Database["public"]["Tables"]["documents"]["Row"] & {
  registrant?: { id: string; name: string } | null
}
type SortField = "type" | "vendor_name" | "amount" | "issue_date" | "due_date" | "status" | "created_at"
type SortDirection = "asc" | "desc"

/** 重複グループ（3段階対応） */
interface DuplicateGroup {
  level: "exact" | "likely" | "similar"
  match_reason: string
  vendor_name: string
  amount: number | null
  type: string
  documents: {
    id: string
    vendor_name: string
    amount: number | null
    type: string
    issue_date: string | null
    due_date: string | null
    dropbox_path: string | null
    file_hash: string | null
    created_at: string
  }[]
}

/** 重複レベルに応じたスタイル */
const LEVEL_STYLES: Record<string, { border: string; badge: string; badgeText: string; label: string }> = {
  exact: { border: "border-l-4 border-red-500 bg-red-50 dark:bg-red-950", badge: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200", badgeText: "完全重複", label: "同一ファイルです" },
  likely: { border: "border-l-4 border-orange-500 bg-orange-50 dark:bg-orange-950", badge: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200", badgeText: "重複の可能性", label: "取引先・金額・日付が一致" },
  similar: { border: "border-l-4 border-gray-400 bg-gray-50 dark:bg-gray-900", badge: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300", badgeText: "類似書類", label: "取引先・金額が一致（参考情報）" },
}

const PAGE_SIZE = 20

const DEFAULT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "すべての種別" },
  { value: "請求書", label: "請求書" },
  { value: "領収書", label: "領収書" },
  { value: "契約書", label: "契約書" },
  { value: "売上記録", label: "売上記録" },
]

const statusOptions: { value: string; label: string }[] = [
  { value: "all", label: "すべてのステータス" },
  { value: "未処理", label: "未処理" },
  { value: "処理済み", label: "処理済み" },
  { value: "アーカイブ", label: "アーカイブ" },
]

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<Document[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [isLoading, setIsLoading] = useState(true)

  // 動的書類種別
  const [dynamicTypes, setDynamicTypes] = useState<{ name: string }[]>([])

  // 動的種別をフィルタオプションに変換
  const typeOptions = useMemo(() => {
    if (dynamicTypes.length === 0) return DEFAULT_TYPE_OPTIONS
    const opts = [
      { value: "all", label: "すべての種別" },
      ...dynamicTypes.map((t) => ({ value: t.name, label: t.name })),
    ]
    // 動的typesに「売上記録」が含まれていなければ末尾に追加
    if (!opts.some((o) => o.value === "売上記録")) {
      opts.push({ value: "売上記録", label: "売上記録" })
    }
    return opts
  }, [dynamicTypes])

  // 書類種別リストを取得
  useEffect(() => {
    async function fetchTypes() {
      try {
        const res = await fetch("/api/settings?table=document_types")
        if (!res.ok) return
        const json = await res.json() as { data: { name: string }[] }
        if (json.data && json.data.length > 0) {
          setDynamicTypes(json.data)
        }
      } catch {
        // フォールバック: デフォルトを使う
      }
    }
    fetchTypes()
  }, [])

  // 表示切替タブ（経費書類 / 売上）
  const [activeTab, setActiveTab] = useState<"expense" | "sales">("expense")

  // フィルタ
  const [search, setSearch] = useState("")
  const [typeFilter, setTypeFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  // 要振込（未払い）フィルタ
  const [transferUnpaidOnly, setTransferUnpaidOnly] = useState(false)

  // ソート
  const [sortField, setSortField] = useState<SortField>("created_at")
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc")

  // ページネーション
  const [page, setPage] = useState(0)

  const totalPages = Math.ceil(totalCount / PAGE_SIZE)

  // データ取得
  const fetchDocuments = useCallback(async () => {
    setIsLoading(true)
    setSelectedDocIds(new Set())
    try {
      const params = new URLSearchParams()
      params.set("limit", String(PAGE_SIZE))
      params.set("offset", String(page * PAGE_SIZE))
      params.set("sort", sortField)
      params.set("direction", sortDirection)

      if (search) params.set("search", search)

      // タブによる種別フィルタ
      if (activeTab === "sales") {
        // 売上タブは「売上記録」のみ
        params.set("type", "売上記録")
      } else {
        // 経費タブは「売上記録」を除外しつつ、ユーザー選択の種別フィルタを尊重
        if (typeFilter !== "all" && typeFilter !== "売上記録") {
          params.set("type", typeFilter)
        }
        params.set("exclude_type", "売上記録")
      }

      if (statusFilter !== "all") params.set("status", statusFilter)
      if (dateFrom) params.set("date_from", dateFrom)
      if (dateTo) params.set("date_to", dateTo)

      // 要振込（未払い）：振込が必要 かつ 未払い に絞る
      if (transferUnpaidOnly) {
        params.set("require_transfer", "1")
        params.set("unpaid", "1")
      }

      const res = await fetch(`/api/documents?${params.toString()}`)
      if (!res.ok) throw new Error("データの取得に失敗しました")
      const json = await res.json() as { data: Document[]; count: number | null }
      setDocuments(json.data ?? [])
      setTotalCount(json.count ?? 0)

      // 「支払い内容」が未生成(NULL)の行をバックグラウンドで遅延生成し、一覧に反映する
      const missingIds = (json.data ?? []).filter((d) => d.payment_purpose == null).map((d) => d.id)
      if (missingIds.length > 0) {
        void (async () => {
          const chunkSize = 40
          for (let i = 0; i < missingIds.length; i += chunkSize) {
            const chunk = missingIds.slice(i, i + chunkSize)
            try {
              const pr = await fetch("/api/documents/payment-purpose", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: chunk }),
              })
              if (!pr.ok) break
              const pj = await pr.json() as { results?: Array<{ id: string; payment_purpose: string }> }
              const map = new Map((pj.results ?? []).map((x) => [x.id, x.payment_purpose]))
              if (map.size > 0) {
                setDocuments((prev) =>
                  prev.map((d) => (map.has(d.id) ? { ...d, payment_purpose: map.get(d.id) ?? "" } : d))
                )
              }
            } catch {
              break
            }
          }
        })()
      }
    } catch {
      toast.error("書類データの取得に失敗しました")
      setDocuments([])
      setTotalCount(0)
    } finally {
      setIsLoading(false)
    }
  }, [search, typeFilter, statusFilter, dateFrom, dateTo, sortField, sortDirection, page, activeTab, transferUnpaidOnly])

  useEffect(() => {
    fetchDocuments()
  }, [fetchDocuments])

  // ソートハンドラ
  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortField(field)
      setSortDirection("asc")
    }
    setPage(0)
  }

  // ステータス変更をローカルに反映
  function handleStatusChange(id: string, newStatus: DocumentStatus) {
    setDocuments((prev) =>
      prev.map((doc) => (doc.id === id ? { ...doc, status: newStatus } : doc))
    )
  }

  // 検索実行
  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault()
    setPage(0)
    fetchDocuments()
  }

  // フィルタリセット
  function handleReset() {
    setSearch("")
    setTypeFilter("all")
    setStatusFilter("all")
    setDateFrom("")
    setDateTo("")
    setTransferUnpaidOnly(false)
    setPage(0)
  }

  // 一覧チェックボックス選択（一括削除・一括ステータス変更で共用）
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set())
  const [isBulkDeleting, setIsBulkDeleting] = useState(false)
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false)

  // 一括ステータス変更
  const [isBulkStatusUpdating, setIsBulkStatusUpdating] = useState(false)

  // 選択中の書類のステータスを一括変更（未処理/処理済み/アーカイブ）
  async function handleBulkStatusChange(newStatus: DocumentStatus) {
    if (selectedDocIds.size === 0) return
    setIsBulkStatusUpdating(true)
    try {
      const ids = Array.from(selectedDocIds)
      const res = await fetch("/api/documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, status: newStatus }),
      })
      const json = await res.json().catch(() => ({})) as { updated?: number; error?: string }
      if (!res.ok) {
        throw new Error(json.error || "ステータスの一括変更に失敗しました")
      }
      toast.success(`${json.updated ?? ids.length}件を「${newStatus}」にしました`)
      setSelectedDocIds(new Set())
      fetchDocuments()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "ステータスの一括変更に失敗しました")
    } finally {
      setIsBulkStatusUpdating(false)
    }
  }

  // 一括再解析（選択した書類をDropboxから取得し直してAI再解析）
  const [showReanalyzeConfirm, setShowReanalyzeConfirm] = useState(false)
  const [isReanalyzing, setIsReanalyzing] = useState(false)
  const [reanalyzeProgress, setReanalyzeProgress] = useState(0)
  const [reanalyzeTotal, setReanalyzeTotal] = useState(0)

  // 選択中の書類を1件ずつ再解析（ライブ進捗表示のため個別APIを逐次呼び出し）
  async function handleBulkReanalyze() {
    if (selectedDocIds.size === 0) return
    const ids = Array.from(selectedDocIds)
    setShowReanalyzeConfirm(false)
    setIsReanalyzing(true)
    setReanalyzeTotal(ids.length)
    setReanalyzeProgress(0)

    let successCount = 0
    let failCount = 0
    let fileNotFoundCount = 0
    for (let i = 0; i < ids.length; i++) {
      setReanalyzeProgress(i + 1)
      try {
        const res = await fetch(`/api/documents/${ids[i]}/reanalyze`, { method: "POST" })
        if (res.ok) {
          successCount++
        } else {
          // ファイル欠損（404 + reason）は通常の失敗と区別する。1件欠損でも処理は止めない
          const j = await res.json().catch(() => ({})) as { reason?: string }
          if (res.status === 404 && j.reason === "file_not_found") fileNotFoundCount++
          else failCount++
        }
      } catch {
        failCount++
      }
      // Geminiレート制限回避のため最後以外はウェイトを挟む
      if (i < ids.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 700))
      }
    }

    setIsReanalyzing(false)
    // 「N件成功 / M件ファイル欠損 / K件失敗」の内訳を表示
    const breakdown = `${successCount}件成功${fileNotFoundCount > 0 ? ` / ${fileNotFoundCount}件ファイル欠損` : ""}${failCount > 0 ? ` / ${failCount}件失敗` : ""}`
    if (successCount > 0) {
      toast.success(`${ids.length}件中 ${breakdown}`)
    } else if (fileNotFoundCount > 0) {
      toast.warning(`再解析できませんでした（${breakdown}）。欠損ファイルは詳細画面から再アップロードできます`)
    } else {
      toast.error(`再解析に失敗しました（${failCount}件）`)
    }
    setSelectedDocIds(new Set())
    fetchDocuments()
  }

  // 重複チェック
  const [isDuplicateChecking, setIsDuplicateChecking] = useState(false)
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([])
  const [showDuplicateModal, setShowDuplicateModal] = useState(false)
  const [selectedForDeletion, setSelectedForDeletion] = useState<Set<string>>(new Set())
  const [isDeleting, setIsDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Dropboxスキャン
  const [isScanning, setIsScanning] = useState(false)
  const [showScanResult, setShowScanResult] = useState(false)
  const [scanResult, setScanResult] = useState<{
    scanned: number
    registered: number
    needs_review: number
    errors: number
    details: {
      filename: string
      status: "registered" | "needs_review" | "error"
      vendor?: string
      type?: string
      amount?: number | null
      reasons?: string[]
      error?: string
    }[]
  } | null>(null)

  // CSVエクスポート
  const [isExporting, setIsExporting] = useState(false)

  // 税理士フォルダへのコピー
  const nowForTaxCopy = new Date()
  const TAX_SOURCE_FOLDERS = ["請求書", "領収書", "社会保険料", "その他", "スタッフ領収書", "売上", "返金", "自動精算機データ"] as const
  const [showTaxCopyModal, setShowTaxCopyModal] = useState(false)
  // 期間指定（開始年月〜終了年月）。単月は開始＝終了
  const [taxCopyStartYear, setTaxCopyStartYear] = useState<number>(nowForTaxCopy.getFullYear())
  const [taxCopyStartMonth, setTaxCopyStartMonth] = useState<number>(nowForTaxCopy.getMonth() + 1)
  const [taxCopyEndYear, setTaxCopyEndYear] = useState<number>(nowForTaxCopy.getFullYear())
  const [taxCopyEndMonth, setTaxCopyEndMonth] = useState<number>(nowForTaxCopy.getMonth() + 1)
  const [taxCopyFolders, setTaxCopyFolders] = useState<Set<string>>(
    new Set(TAX_SOURCE_FOLDERS)
  )
  const [isCopyingToTax, setIsCopyingToTax] = useState(false)
  // 進捗（月単位で逐次処理）
  const [taxCopyProgress, setTaxCopyProgress] = useState<{ current: number; total: number; label: string } | null>(null)
  // 月別の結果
  const [taxCopyResults, setTaxCopyResults] = useState<Array<{
    year: number
    month: number
    copied: number
    skipped: number
    failed: number
    total: number
    folderBreakdown: Record<string, { copied: number; skipped: number; failed: number }>
    // 失敗したファイルの内訳（実行履歴の「要確認一覧」用）
    failedFiles: Array<{ file_name: string; folder: string; reason?: string }>
    error?: string
  }> | null>(null)

  // 追加分の一括取り込み（月指定不要）
  const [showAdditionalModal, setShowAdditionalModal] = useState(false)
  const [isImportingAdditional, setIsImportingAdditional] = useState(false)
  const [additionalResult, setAdditionalResult] = useState<{
    months: Array<{
      year: number
      month: number
      toBody: number
      toAdditional: number
      skipped: number
      needsReview: number
    }>
    totals: {
      toBody: number
      toAdditional: number
      skipped: number
      needsReview: number
    }
    needsReviewList: Array<{
      file_name: string
      path: string
      source: "db" | "dropbox"
      reason: string
    }>
  } | null>(null)

  // フォルダチェックボックス切り替え
  function toggleTaxCopyFolder(folder: string) {
    setTaxCopyFolders((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }

  // モーダルを開くたびに結果をリセット
  function openTaxCopyModal() {
    setTaxCopyResults(null)
    setTaxCopyProgress(null)
    setTaxCopyFolders(new Set(TAX_SOURCE_FOLDERS))
    setShowTaxCopyModal(true)
  }

  // 重複チェック実行
  async function handleDuplicateCheck() {
    setIsDuplicateChecking(true)
    try {
      const res = await fetch("/api/documents/duplicates")
      const json = await res.json() as { data?: DuplicateGroup[]; error?: string }

      if (!res.ok) {
        throw new Error(json.error || "重複チェックに失敗しました")
      }

      const groups = json.data ?? []

      if (groups.length === 0) {
        toast.success("重複書類はありませんでした")
        return
      }

      setDuplicateGroups(groups)
      setSelectedForDeletion(new Set())
      setShowDuplicateModal(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重複チェックに失敗しました")
    } finally {
      setIsDuplicateChecking(false)
    }
  }

  // 完全一致グループで「新しい方を残す」（古い方を自動選択）
  function selectOlderForDeletion(group: DuplicateGroup) {
    // created_at でソートし、最新の1件以外を選択
    const sorted = [...group.documents].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
    setSelectedForDeletion((prev) => {
      const next = new Set(prev)
      // 最新（sorted[0]）以外を選択
      for (let i = 1; i < sorted.length; i++) {
        next.add(sorted[i].id)
      }
      return next
    })
  }

  // 削除チェックボックスの切り替え
  function toggleDeletionSelection(docId: string) {
    setSelectedForDeletion((prev) => {
      const next = new Set(prev)
      if (next.has(docId)) {
        next.delete(docId)
      } else {
        next.add(docId)
      }
      return next
    })
  }

  // 選択した書類を一括削除
  async function handleBulkDelete() {
    if (selectedForDeletion.size === 0) return
    setIsDeleting(true)
    try {
      const ids = Array.from(selectedForDeletion)
      console.log("削除リクエスト:", ids)
      let successCount = 0
      const errors: string[] = []

      for (const id of ids) {
        const res = await fetch(`/api/documents?id=${id}`, { method: "DELETE" })
        if (res.ok) {
          successCount++
        } else {
          const json = await res.json().catch(() => ({ error: "不明なエラー" })) as { error?: string }
          const errMsg = `書類 ${id}: ${json.error || res.statusText}`
          console.error("削除失敗:", errMsg)
          errors.push(errMsg)
        }
      }

      if (successCount > 0) {
        toast.success(`${successCount}件の書類を削除しました（Dropboxからも削除済み）`)
      }
      if (errors.length > 0) {
        toast.error(`${errors.length}件の削除に失敗: ${errors[0]}`)
      }
      setShowDeleteConfirm(false)
      setShowDuplicateModal(false)
      setSelectedForDeletion(new Set())
      setDuplicateGroups([])
      // 一覧を再取得
      fetchDocuments()
    } catch {
      toast.error("削除処理に失敗しました")
    } finally {
      setIsDeleting(false)
    }
  }

  // 一括削除（一覧チェックボックスから）
  async function handleBulkDeleteFromList() {
    if (selectedDocIds.size === 0) return
    setIsBulkDeleting(true)
    try {
      const ids = Array.from(selectedDocIds)
      let successCount = 0
      const errors: string[] = []

      for (const id of ids) {
        const res = await fetch(`/api/documents?id=${id}`, { method: "DELETE" })
        if (res.ok) {
          successCount++
        } else {
          const json = await res.json().catch(() => ({ error: "不明なエラー" })) as { error?: string }
          errors.push(json.error || res.statusText)
        }
      }

      if (successCount > 0) {
        toast.success(`${successCount}件の書類を削除しました（Dropboxからも削除済み）`)
      }
      if (errors.length > 0) {
        toast.error(`${errors.length}件の削除に失敗: ${errors[0]}`)
      }
      setShowBulkDeleteConfirm(false)
      setSelectedDocIds(new Set())
      fetchDocuments()
    } catch {
      toast.error("削除処理に失敗しました")
    } finally {
      setIsBulkDeleting(false)
    }
  }

  // Dropboxスキャン実行
  async function handleScan() {
    setIsScanning(true)
    setScanResult(null)
    try {
      const res = await fetch("/api/cron/scan-dropbox", { method: "POST" })
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(json.error || "スキャンに失敗しました")
      }
      const result = await res.json() as typeof scanResult
      setScanResult(result)

      if (!result || result.scanned === 0) {
        toast("新しいファイルはありませんでした")
      } else {
        if (result.registered > 0) {
          toast.success(`${result.registered}件の書類を自動登録しました`)
        }
        if (result.needs_review > 0) {
          toast.warning(`${result.needs_review}件の要確認書類があります`)
        }
        if (result.errors > 0) {
          toast.error(`${result.errors}件のエラーが発生しました`)
        }
        setShowScanResult(true)
        fetchDocuments()
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "スキャンに失敗しました")
    } finally {
      setIsScanning(false)
    }
  }

  // 税理士フォルダへ一括コピー実行（期間指定：開始年月〜終了年月を月単位で逐次処理）
  async function handleCopyToTaxFolder() {
    if (taxCopyFolders.size === 0) {
      toast.warning("対象フォルダを1つ以上選択してください")
      return
    }

    // 期間の整合性チェック（開始 ≤ 終了）
    const startIdx = taxCopyStartYear * 12 + (taxCopyStartMonth - 1)
    const endIdx = taxCopyEndYear * 12 + (taxCopyEndMonth - 1)
    if (startIdx > endIdx) {
      toast.warning("開始年月は終了年月以前にしてください")
      return
    }

    // 対象月リストを作成
    const monthsToProcess: Array<{ year: number; month: number }> = []
    for (let idx = startIdx; idx <= endIdx; idx++) {
      monthsToProcess.push({ year: Math.floor(idx / 12), month: (idx % 12) + 1 })
    }

    setIsCopyingToTax(true)
    setTaxCopyResults(null)
    const folders = Array.from(taxCopyFolders)
    const results: NonNullable<typeof taxCopyResults> = []
    let totalCopied = 0
    let totalFailed = 0

    try {
      for (let i = 0; i < monthsToProcess.length; i++) {
        const { year, month } = monthsToProcess[i]
        setTaxCopyProgress({
          current: i + 1,
          total: monthsToProcess.length,
          label: `${year}年${String(month).padStart(2, "0")}月`,
        })

        try {
          // 各月ごとに既存の月次コピーAPIを呼ぶ（1リクエスト＝1か月でタイムアウト回避）
          const res = await fetch("/api/documents/copy-to-taxfolder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ year, month, folders }),
          })
          const json = await res.json() as {
            copied?: number
            skipped?: number
            failed?: number
            total?: number
            details?: Array<{
              file_name: string
              folder: string
              status: "copied" | "skipped" | "failed"
              message?: string
            }>
            error?: string
          }
          if (!res.ok) {
            results.push({
              year, month, copied: 0, skipped: 0, failed: 0, total: 0,
              folderBreakdown: {}, failedFiles: [],
              error: json.error || "コピー処理に失敗しました",
            })
            totalFailed++
            continue
          }

          // フォルダ別の内訳を集計
          const folderBreakdown: Record<string, { copied: number; skipped: number; failed: number }> = {}
          const failedFiles: Array<{ file_name: string; folder: string; reason?: string }> = []
          for (const d of json.details ?? []) {
            const key = d.folder || "（未分類）"
            if (!folderBreakdown[key]) folderBreakdown[key] = { copied: 0, skipped: 0, failed: 0 }
            if (d.status === "copied") folderBreakdown[key].copied++
            else if (d.status === "skipped") folderBreakdown[key].skipped++
            else {
              folderBreakdown[key].failed++
              failedFiles.push({ file_name: d.file_name, folder: key, reason: d.message })
            }
          }

          results.push({
            year, month,
            copied: json.copied ?? 0,
            skipped: json.skipped ?? 0,
            failed: json.failed ?? 0,
            total: json.total ?? 0,
            folderBreakdown,
            failedFiles,
          })
          totalCopied += json.copied ?? 0
          // 途中経過を随時反映（部分表示）
          setTaxCopyResults([...results])
        } catch (monthErr) {
          results.push({
            year, month, copied: 0, skipped: 0, failed: 0, total: 0,
            folderBreakdown: {}, failedFiles: [],
            error: monthErr instanceof Error ? monthErr.message : "コピー処理に失敗しました",
          })
          totalFailed++
          setTaxCopyResults([...results])
        }
      }

      setTaxCopyResults([...results])
      if (totalFailed > 0) {
        toast.warning(`コピー完了：${totalCopied}件（${totalFailed}か月でエラー）`)
      } else {
        toast.success(`✅ ${monthsToProcess.length}か月分のコピーが完了しました（合計 ${totalCopied}件）`)
      }

      // 実行履歴として記録（失敗しても一括コピー自体の結果表示は妨げない）
      try {
        const issues = results.flatMap((r) =>
          r.failedFiles.map((f) => ({ ...f, year: r.year, month: r.month }))
        )
        await fetch("/api/documents/tax-copy-runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            run_type: "range_copy",
            period_start: `${taxCopyStartYear}-${String(taxCopyStartMonth).padStart(2, "0")}`,
            period_end: `${taxCopyEndYear}-${String(taxCopyEndMonth).padStart(2, "0")}`,
            target_folders: folders,
            summary: results,
            issues,
          }),
        })
      } catch (historyErr) {
        console.error("実行履歴の記録に失敗しました:", historyErr)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "コピー処理に失敗しました")
    } finally {
      setIsCopyingToTax(false)
      setTaxCopyProgress(null)
    }
  }

  // 提出書類一覧CSVをダウンロード（月指定）
  function handleDownloadTaxCsv(year: number, month: number) {
    window.location.href = `/api/documents/export-tax-csv?year=${year}&month=${month}`
  }

  // 提出書類一覧Excel（コピー先リンク付き）をダウンロード（月指定）
  function handleDownloadTaxXlsx(year: number, month: number) {
    window.location.href = `/api/documents/export-tax-xlsx?year=${year}&month=${month}`
  }

  // 追加分の一括取り込みモーダルを開く
  function openAdditionalModal() {
    setAdditionalResult(null)
    setShowAdditionalModal(true)
  }

  // 追加分の一括取り込み実行（年月指定なし・全期間）
  async function handleImportAdditional() {
    setIsImportingAdditional(true)
    try {
      const res = await fetch("/api/documents/import-additional-tax", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })

      const json = await res.json() as {
        months?: Array<{
          year: number
          month: number
          toBody: number
          toAdditional: number
          skipped: number
          needsReview: number
        }>
        totals?: {
          toBody: number
          toAdditional: number
          skipped: number
          needsReview: number
        }
        needsReviewList?: Array<{
          file_name: string
          path: string
          source: "db" | "dropbox"
          reason: string
        }>
        details?: Array<{
          file_name: string
          year: number
          month: number
          status: "copied" | "skipped" | "failed"
          message?: string
        }>
        error?: string
      }

      if (!res.ok) {
        throw new Error(json.error || "取り込み処理に失敗しました")
      }

      const months = json.months ?? []
      const totals = json.totals ?? { toBody: 0, toAdditional: 0, skipped: 0, needsReview: 0 }
      const needsReviewList = json.needsReviewList ?? []
      setAdditionalResult({
        months,
        totals,
        needsReviewList,
      })

      const copiedTotal = totals.toBody + totals.toAdditional
      if (copiedTotal === 0 && totals.needsReview === 0) {
        toast("新たに取り込む追加資料はありませんでした")
      } else if (totals.needsReview > 0) {
        toast.warning(
          `✅ 本体 ${totals.toBody}件 / 追加分 ${totals.toAdditional}件 / スキップ ${totals.skipped}件 / 要確認 ${totals.needsReview}件`
        )
      } else {
        toast.success(
          `✅ 本体 ${totals.toBody}件 / 追加分 ${totals.toAdditional}件 / スキップ ${totals.skipped}件`
        )
      }

      // 実行履歴として記録（months は年月降順のため末尾が最古・先頭が最新）
      try {
        const sortedMonths = [...months].sort(
          (a, b) => (a.year * 12 + a.month) - (b.year * 12 + b.month)
        )
        const now = new Date()
        const fallbackPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
        const periodStart = sortedMonths.length > 0
          ? `${sortedMonths[0].year}-${String(sortedMonths[0].month).padStart(2, "0")}`
          : fallbackPeriod
        const periodEnd = sortedMonths.length > 0
          ? `${sortedMonths[sortedMonths.length - 1].year}-${String(sortedMonths[sortedMonths.length - 1].month).padStart(2, "0")}`
          : fallbackPeriod

        const failedFiles = (json.details ?? [])
          .filter((d) => d.status === "failed")
          .map((d) => ({
            file_name: d.file_name,
            reason: d.message,
            year: d.year,
            month: d.month,
          }))
        const issues = [
          ...needsReviewList.map((r) => ({
            file_name: r.file_name,
            reason: r.reason,
            source: r.source,
          })),
          ...failedFiles,
        ]

        await fetch("/api/documents/tax-copy-runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            run_type: "additional_import",
            period_start: periodStart,
            period_end: periodEnd,
            target_folders: [...TAX_SOURCE_FOLDERS],
            summary: { months, totals },
            issues,
          }),
        })
      } catch (historyErr) {
        console.error("実行履歴の記録に失敗しました:", historyErr)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "取り込み処理に失敗しました")
    } finally {
      setIsImportingAdditional(false)
    }
  }

  async function handleExportCsv() {
    setIsExporting(true)
    try {
      // 現在のフィルタ条件で全件取得（ページネーションなし）
      const params = new URLSearchParams()
      params.set("limit", "10000")
      params.set("offset", "0")
      params.set("sort", sortField)
      params.set("direction", sortDirection)

      if (search) params.set("search", search)

      // タブによる種別フィルタ（CSV出力も現在のタブに従う）
      if (activeTab === "sales") {
        params.set("type", "売上記録")
      } else {
        if (typeFilter !== "all" && typeFilter !== "売上記録") {
          params.set("type", typeFilter)
        }
        params.set("exclude_type", "売上記録")
      }

      if (statusFilter !== "all") params.set("status", statusFilter)
      if (dateFrom) params.set("date_from", dateFrom)
      if (dateTo) params.set("date_to", dateTo)

      const res = await fetch(`/api/documents?${params.toString()}`)
      if (!res.ok) throw new Error("データの取得に失敗しました")
      const json = await res.json() as { data: Document[] }
      const allDocs = json.data ?? []

      // 「支払い内容」が未生成(NULL)の行は、CSV出力前にまとめて遅延生成する
      const purposeMap = new Map<string, string>()
      const missingIds = allDocs.filter((d) => d.payment_purpose == null).map((d) => d.id)
      if (missingIds.length > 0) {
        toast(`支払い内容を生成中…（${missingIds.length}件）`)
        const chunkSize = 60
        // 過大件数での長時間実行を避けるため最大600件まで生成（超過分は空欄）
        const capped = missingIds.slice(0, 600)
        for (let i = 0; i < capped.length; i += chunkSize) {
          const chunk = capped.slice(i, i + chunkSize)
          try {
            const pr = await fetch("/api/documents/payment-purpose", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ids: chunk }),
            })
            if (!pr.ok) break
            const pj = await pr.json() as { results?: Array<{ id: string; payment_purpose: string }> }
            for (const r of pj.results ?? []) purposeMap.set(r.id, r.payment_purpose)
          } catch {
            break
          }
        }
        // 生成結果を画面の一覧にも反映
        if (purposeMap.size > 0) {
          setDocuments((prev) =>
            prev.map((d) => (purposeMap.has(d.id) ? { ...d, payment_purpose: purposeMap.get(d.id) ?? "" } : d))
          )
        }
      }

      // CSVヘッダー（摘要の隣に支払い内容、末尾にDropboxパス）
      const headers = ["種別", "取引先名", "金額", "発行日", "支払期日", "ステータス", "摘要", "支払い内容", "入力経路", "登録日時", "Dropboxパス"]

      // CSV行を生成
      const rows = allDocs.map((doc) => [
        doc.type,
        doc.vendor_name,
        doc.amount != null ? String(doc.amount) : "",
        doc.issue_date ?? "",
        doc.due_date ?? "",
        doc.status,
        doc.description ?? "",
        // 支払い内容（AI要約・全文）。生成できた分を優先し、無ければ既存値、判定不能は空欄
        purposeMap.get(doc.id) ?? doc.payment_purpose ?? "",
        doc.input_method,
        doc.created_at ? new Date(doc.created_at).toLocaleString("ja-JP") : "",
        // 保存先の完全パス（現在の保存場所を反映）。未設定の行は空欄
        doc.dropbox_path ?? "",
      ])

      // CSVセルをエスケープ（ダブルクォートやカンマを含む場合）
      function escapeCsvCell(value: string): string {
        if (value.includes(",") || value.includes('"') || value.includes("\n")) {
          return `"${value.replace(/"/g, '""')}"`
        }
        return value
      }

      const csvContent = [
        headers.map(escapeCsvCell).join(","),
        ...rows.map((row) => row.map(escapeCsvCell).join(",")),
      ].join("\n")

      // UTF-8 BOM付きでBlobを生成（Excel文字化け対策）
      const bom = new Uint8Array([0xEF, 0xBB, 0xBF])
      const blob = new Blob([bom, csvContent], { type: "text/csv;charset=utf-8" })

      // ファイル名: タブに応じた接頭辞 + YYYY-MM-DD.csv
      const today = new Date()
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
      const fileName = activeTab === "sales"
        ? `売上記録_${dateStr}.csv`
        : `経費書類_${dateStr}.csv`

      // ダウンロード
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      toast.success(`${allDocs.length}件のデータをエクスポートしました`)
    } catch {
      toast.error("CSVエクスポートに失敗しました")
    } finally {
      setIsExporting(false)
    }
  }

  const hasFilters = search || typeFilter !== "all" || statusFilter !== "all" || dateFrom || dateTo || transferUnpaidOnly

  // タブ切り替えハンドラ（ページネーション・選択もリセット）
  function handleTabChange(tab: "expense" | "sales") {
    if (tab === activeTab) return
    setActiveTab(tab)
    setPage(0)
    setSelectedDocIds(new Set())
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">書類一覧</h1>
        <div className="flex gap-2">
          <div className="tooltip-wrapper">
            <Button
              onClick={handleScan}
              disabled={isScanning}
              className="btn-float-primary rounded-lg px-4 py-2 text-sm text-white"
              size="sm"
              style={{
                background: "linear-gradient(135deg, #C8922A, #B8782A)",
                boxShadow: "0 4px 12px rgba(180,120,40,0.35)",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "linear-gradient(135deg, #B8822A, #A8682A)" }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "linear-gradient(135deg, #C8922A, #B8782A)" }}
            >
              {isScanning ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ScanLine className="size-4" />
              )}
              {isScanning ? "スキャン中..." : "スキャン"}
            </Button>
            <span className="tooltip-text">Dropbox内の未登録ファイルを自動でAI解析・登録・仕分けします</span>
          </div>
          <Button asChild className="btn-float-primary">
            <Link href="/documents/new">
              <Plus className="size-4" />
              新規登録
            </Link>
          </Button>
        </div>
      </div>

      {/* 表示切替タブ（経費書類 / 売上） */}
      <div className="flex gap-2">
        {([
          { key: "expense", label: "📄 経費書類" },
          { key: "sales", label: "📈 売上" },
        ] as const).map((tab) => {
          const isActive = activeTab === tab.key
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => handleTabChange(tab.key)}
              className="rounded-lg px-4 py-2 text-sm font-semibold transition-colors"
              style={{
                background: isActive
                  ? "linear-gradient(135deg, #C8922A, #B8782A)"
                  : "transparent",
                color: isActive ? "#fff" : "#A0703A",
                border: isActive
                  ? "1px solid transparent"
                  : "1px solid rgba(160,112,58,0.3)",
                boxShadow: isActive
                  ? "0 4px 12px rgba(180,120,40,0.35)"
                  : "none",
              }}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* 検索・フィルタ */}
      <div className="space-y-3">
        <form onSubmit={handleSearchSubmit} className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="取引先名・摘要で検索..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="secondary">
            検索
          </Button>
        </form>

        <div className="flex flex-wrap gap-2 items-end">
          <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v); setPage(0) }}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {typeOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0) }}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {statusOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-1">
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => { setDateFrom(e.target.value); setPage(0) }}
              className="w-[150px]"
            />
            <span className="text-muted-foreground text-sm">〜</span>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setPage(0) }}
              className="w-[150px]"
            />
          </div>

          {/* 要振込（未払い）フィルタ — 経費タブのみ */}
          {activeTab === "expense" && (
            <Button
              variant={transferUnpaidOnly ? "default" : "outline"}
              size="sm"
              onClick={() => { setTransferUnpaidOnly((v) => !v); setPage(0) }}
              className="btn-float"
              style={transferUnpaidOnly ? {
                background: "linear-gradient(135deg, #C8922A, #B8782A)",
                color: "#fff",
                boxShadow: "0 4px 12px rgba(180,120,40,0.35)",
              } : undefined}
            >
              <Wallet className="size-3.5" />
              要振込（未払い）
            </Button>
          )}

          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={handleReset}>
              <X className="size-3.5" />
              リセット
            </Button>
          )}

          <Button variant="outline" size="sm" onClick={handleDuplicateCheck} disabled={isDuplicateChecking} className="btn-float">
            {isDuplicateChecking ? <Loader2 className="size-3.5 animate-spin" /> : <Copy className="size-3.5" />}
            重複チェック
          </Button>

          <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={isExporting} className="btn-float">
            {isExporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            CSVエクスポート
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={openTaxCopyModal}
            disabled={isCopyingToTax}
            className="btn-float"
          >
            {isCopyingToTax ? <Loader2 className="size-3.5 animate-spin" /> : <FolderInput className="size-3.5" />}
            税理士フォルダへ一括コピー
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={openAdditionalModal}
            disabled={isImportingAdditional}
            className="btn-float"
          >
            {isImportingAdditional ? <Loader2 className="size-3.5 animate-spin" /> : <FolderPlus className="size-3.5" />}
            追加分をまとめて取り込む
          </Button>

          <Button variant="outline" size="sm" asChild className="btn-float">
            <Link href="/documents/ingest">
              <Upload className="size-3.5" />
              返金・精算機データ取込
            </Link>
          </Button>

          <Button variant="outline" size="sm" asChild className="btn-float">
            <Link href="/documents/tax-copy-history">
              <History className="size-3.5" />
              税理士提出の実行履歴
            </Link>
          </Button>
        </div>
      </div>

      {/* 一括操作アクションバー（選択時のみ表示）
          仕様: N件選択中 | 選択を解除 | [ステータス変更 ▾] | 🔄選択項目を再解析 | 選択した書類を削除(赤) */}
      {selectedDocIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-4 py-2.5">
          <span className="text-sm font-medium">{selectedDocIds.size}件選択中</span>

          <span className="text-muted-foreground/40 select-none">|</span>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedDocIds(new Set())}
            disabled={isBulkStatusUpdating || isBulkDeleting || isReanalyzing}
          >
            選択を解除
          </Button>

          <span className="text-muted-foreground/40 select-none">|</span>

          {/* ステータス一括変更（ドロップダウン）— 仕様: [ステータス変更 ▾(未処理/処理済み/アーカイブ)] */}
          <Select
            value=""
            onValueChange={(v) => handleBulkStatusChange(v as DocumentStatus)}
            disabled={isBulkStatusUpdating || isBulkDeleting || isReanalyzing}
          >
            <SelectTrigger className="h-8 w-[180px] btn-float bg-background" aria-label="ステータス一括変更">
              {isBulkStatusUpdating ? (
                <span className="flex items-center gap-1.5 text-sm">
                  <Loader2 className="size-3.5 animate-spin" />
                  ステータス変更中…
                </span>
              ) : (
                <SelectValue placeholder="📋 ステータス変更" />
              )}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="未処理">未処理にする</SelectItem>
              <SelectItem value="処理済み">処理済みにする</SelectItem>
              <SelectItem value="アーカイブ">アーカイブにする</SelectItem>
            </SelectContent>
          </Select>

          <span className="text-muted-foreground/40 select-none">|</span>

          {/* 一括再解析 */}
          <div className="tooltip-wrapper">
            <Button
              variant="outline"
              size="sm"
              className="btn-float"
              disabled={isBulkStatusUpdating || isBulkDeleting || isReanalyzing}
              onClick={() => setShowReanalyzeConfirm(true)}
            >
              {isReanalyzing ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  再解析中 {reanalyzeProgress}/{reanalyzeTotal}件
                </>
              ) : (
                <>
                  <RefreshCw className="mr-1.5 size-3.5" />
                  選択項目を再解析
                </>
              )}
            </Button>
            <span className="tooltip-text">選択した書類をDropboxから取得し直してAIで金額・取引先を抽出し直します</span>
          </div>

          <span className="text-muted-foreground/40 select-none">|</span>

          <div className="tooltip-wrapper">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowBulkDeleteConfirm(true)}
              disabled={isBulkStatusUpdating || isBulkDeleting || isReanalyzing}
              className="btn-float-danger"
            >
              <Trash2 className="mr-1.5 size-3.5" />
              選択した書類を削除
            </Button>
            <span className="tooltip-text">チェックした書類をDBとDropboxから一括削除します</span>
          </div>
        </div>
      )}

      {/* テーブル */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <DocumentTable
          documents={documents}
          sortField={sortField}
          sortDirection={sortDirection}
          onSort={handleSort}
          onStatusChange={handleStatusChange}
          selectedIds={selectedDocIds}
          onSelectionChange={setSelectedDocIds}
          tab={activeTab}
        />
      )}

      {/* ページネーション */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            全 {totalCount} 件中 {page * PAGE_SIZE + 1}〜{Math.min((page + 1) * PAGE_SIZE, totalCount)} 件
          </p>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              前へ
            </Button>
            {Array.from({ length: totalPages }, (_, i) => (
              <Button
                key={i}
                variant={page === i ? "default" : "outline"}
                size="sm"
                onClick={() => setPage(i)}
                className="min-w-[36px]"
              >
                {i + 1}
              </Button>
            )).slice(
              Math.max(0, page - 2),
              Math.min(totalPages, page + 3)
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              次へ
            </Button>
          </div>
        </div>
      )}

      {/* 重複チェック結果モーダル */}
      <Dialog open={showDuplicateModal} onOpenChange={setShowDuplicateModal}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-600" />
              重複候補 ({duplicateGroups.length}グループ)
            </DialogTitle>
            <DialogDescription>
              重複レベルごとに色分けされています。削除する書類にチェックを入れてください。
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4 pr-1">
            {duplicateGroups.map((group, gi) => {
              const style = LEVEL_STYLES[group.level] ?? LEVEL_STYLES.similar
              return (
                <div key={`${group.level}-${gi}`} className={`rounded-md p-4 ${style.border}`}>
                  <div className="mb-2 flex items-center gap-2 flex-wrap">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${style.badge}`}>
                      {style.badgeText}
                    </span>
                    <span className="font-medium">
                      {group.vendor_name} ・ {group.type}
                      {group.amount != null && ` ・ ¥${group.amount.toLocaleString()}`}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      ({group.documents.length}件)
                    </span>
                  </div>
                  <div className="mb-2 text-xs text-muted-foreground">
                    {group.match_reason}
                  </div>
                  {/* 完全一致グループには「新しい方を残す」ボタン */}
                  {group.level === "exact" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mb-2"
                      onClick={() => selectOlderForDeletion(group)}
                    >
                      新しい方を残す（古い方を自動選択）
                    </Button>
                  )}
                  <div className="space-y-2">
                    {group.documents.map((doc) => (
                      <label
                        key={doc.id}
                        className={`flex items-start gap-3 rounded-md border p-3 hover:bg-muted/50 cursor-pointer ${
                          selectedForDeletion.has(doc.id) ? "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800" : ""
                        }`}
                      >
                        <Checkbox
                          checked={selectedForDeletion.has(doc.id)}
                          onCheckedChange={() => toggleDeletionSelection(doc.id)}
                          className="mt-0.5"
                        />
                        <div className="flex-1 text-sm">
                          <div>
                            {doc.issue_date && <span>発行日: {doc.issue_date}</span>}
                            {doc.due_date && <span className="ml-3">支払期日: {doc.due_date}</span>}
                          </div>
                          {doc.dropbox_path && (
                            <div className="mt-0.5 text-xs text-muted-foreground truncate">
                              {doc.dropbox_path}
                            </div>
                          )}
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            登録日時: {new Date(doc.created_at).toLocaleString("ja-JP")}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowDuplicateModal(false)}>
              閉じる
            </Button>
            <Button
              variant="destructive"
              disabled={selectedForDeletion.size === 0}
              onClick={() => setShowDeleteConfirm(true)}
            >
              <Trash2 className="mr-2 size-4" />
              選択した書類を削除 ({selectedForDeletion.size}件)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 一括再解析の確認ダイアログ */}
      <Dialog open={showReanalyzeConfirm} onOpenChange={setShowReanalyzeConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="size-5 text-[#A0703A]" />
              選択項目を再解析
            </DialogTitle>
            <DialogDescription>
              {selectedDocIds.size}件を再解析します。DropboxのファイルをAI（現行モデル）で読み直し、金額・取引先・発行日などを抽出し直して上書きします。よろしいですか？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowReanalyzeConfirm(false)}>
              キャンセル
            </Button>
            <Button
              onClick={handleBulkReanalyze}
              style={{
                background: "linear-gradient(135deg, #C8922A, #B8782A)",
                color: "#fff",
                boxShadow: "0 4px 12px rgba(180,120,40,0.35)",
              }}
            >
              <RefreshCw className="mr-2 size-4" />
              再解析する
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 一括削除確認ダイアログ（一覧チェックボックスから） */}
      <Dialog open={showBulkDeleteConfirm} onOpenChange={setShowBulkDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="size-5" />
              削除の確認
            </DialogTitle>
            <DialogDescription>
              {selectedDocIds.size}件の書類を削除しますか？Dropboxからもファイルが削除されます。この操作は取り消せません。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowBulkDeleteConfirm(false)} disabled={isBulkDeleting}>
              キャンセル
            </Button>
            <Button variant="destructive" onClick={handleBulkDeleteFromList} disabled={isBulkDeleting}>
              {isBulkDeleting ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  削除中...
                </>
              ) : (
                "削除する"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 削除確認ダイアログ（重複チェックから） */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="size-5" />
              削除の確認
            </DialogTitle>
            <DialogDescription>
              {selectedForDeletion.size}件の書類を削除します。Dropboxからもファイルが削除されます。この操作は取り消せません。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)} disabled={isDeleting}>
              キャンセル
            </Button>
            <Button variant="destructive" onClick={handleBulkDelete} disabled={isDeleting}>
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  削除中...
                </>
              ) : (
                "本当に削除する"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 税理士フォルダへの一括コピー 期間・対象フォルダ選択 + 進捗/結果表示モーダル */}
      <Dialog open={showTaxCopyModal} onOpenChange={(o) => { if (!isCopyingToTax) setShowTaxCopyModal(o) }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderInput className="size-5" />
              税理士フォルダへ一括コピー
            </DialogTitle>
            <DialogDescription>
              指定した期間（開始年月〜終了年月）の処理済み書類および手動アップロード分を、
              月ごとにDropboxの税理士提出フォルダ（/経理書類/税理士提出/YYYY年MM月/）へ振り分けてコピーします。
              月単位で順に処理するため、期間が広くてもタイムアウトしません。既に存在するファイルはスキップされます。
            </DialogDescription>
          </DialogHeader>

          {!taxCopyResults && !isCopyingToTax ? (
            // 入力フェーズ
            <div className="space-y-4 overflow-y-auto pr-1">
              <div className="space-y-2">
                <div className="text-sm font-medium">期間（開始年月 〜 終了年月）</div>
                <div className="flex flex-wrap items-end gap-2">
                  <Select value={String(taxCopyStartYear)} onValueChange={(v) => setTaxCopyStartYear(Number(v))}>
                    <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 6 }, (_, i) => nowForTaxCopy.getFullYear() - 4 + i).map((y) => (
                        <SelectItem key={y} value={String(y)}>{y}年</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={String(taxCopyStartMonth)} onValueChange={(v) => setTaxCopyStartMonth(Number(v))}>
                    <SelectTrigger className="w-[90px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                        <SelectItem key={m} value={String(m)}>{m}月</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="pb-2 text-muted-foreground">〜</span>
                  <Select value={String(taxCopyEndYear)} onValueChange={(v) => setTaxCopyEndYear(Number(v))}>
                    <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 6 }, (_, i) => nowForTaxCopy.getFullYear() - 4 + i).map((y) => (
                        <SelectItem key={y} value={String(y)}>{y}年</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={String(taxCopyEndMonth)} onValueChange={(v) => setTaxCopyEndMonth(Number(v))}>
                    <SelectTrigger className="w-[90px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                        <SelectItem key={m} value={String(m)}>{m}月</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="text-xs text-muted-foreground">単月の場合は開始と終了を同じにしてください。</div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">対象フォルダ</div>
                <div className="flex flex-wrap gap-3 rounded-md border p-3">
                  {TAX_SOURCE_FOLDERS.map((folder) => (
                    <label
                      key={folder}
                      className="flex items-center gap-2 cursor-pointer text-sm"
                    >
                      <Checkbox
                        checked={taxCopyFolders.has(folder)}
                        onCheckedChange={() => toggleTaxCopyFolder(folder)}
                      />
                      <span>{folder}</span>
                    </label>
                  ))}
                </div>
                <div className="text-xs text-muted-foreground">
                  チェックしたフォルダを再帰的にスキャンします（DBに無い手動アップロード分も対象）。
                </div>
              </div>
            </div>
          ) : (
            // 進捗・結果表示フェーズ
            <div className="space-y-3 overflow-y-auto pr-1">
              {isCopyingToTax && taxCopyProgress && (
                <div className="rounded-md border bg-muted/40 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Loader2 className="size-4 animate-spin" />
                    処理中: {taxCopyProgress.label}（{taxCopyProgress.current}/{taxCopyProgress.total} か月）
                  </div>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${Math.round((taxCopyProgress.current / taxCopyProgress.total) * 100)}%` }}
                    />
                  </div>
                </div>
              )}

              {(taxCopyResults ?? []).map((r) => {
                const folderEntries = Object.entries(r.folderBreakdown)
                  .filter(([, c]) => c.copied > 0 || c.failed > 0)
                  .sort((a, b) => b[1].copied - a[1].copied)
                return (
                  <div key={`${r.year}-${r.month}`} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm font-semibold">
                        {r.year}年{String(r.month).padStart(2, "0")}月
                      </div>
                      {r.error ? (
                        <span className="inline-flex items-center gap-1 text-xs text-red-600">
                          <XCircle className="size-3.5" /> {r.error}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          コピー {r.copied} / スキップ {r.skipped} / 失敗 {r.failed}
                        </span>
                      )}
                    </div>
                    {!r.error && folderEntries.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {folderEntries.map(([folder, c]) => (
                          <span
                            key={folder}
                            className="rounded-full bg-muted px-2 py-0.5 text-[11px]"
                            title={`${folder}: コピー${c.copied} / スキップ${c.skipped} / 失敗${c.failed}`}
                          >
                            {folder} {c.copied}
                            {c.failed > 0 ? <span className="text-red-600">（失敗{c.failed}）</span> : null}
                          </span>
                        ))}
                      </div>
                    )}
                    {!r.error && (r.copied > 0 || r.skipped > 0) && (
                      <div className="mt-2 flex flex-wrap gap-3">
                        <button
                          type="button"
                          onClick={() => handleDownloadTaxCsv(r.year, r.month)}
                          className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2"
                        >
                          <Download className="size-3" />
                          提出書類一覧CSV
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDownloadTaxXlsx(r.year, r.month)}
                          className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2"
                        >
                          <FileSpreadsheet className="size-3" />
                          Excel（リンク付き）
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            {!taxCopyResults && !isCopyingToTax ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => setShowTaxCopyModal(false)}
                >
                  キャンセル
                </Button>
                <Button onClick={handleCopyToTaxFolder} disabled={taxCopyFolders.size === 0}>
                  <FolderInput className="mr-2 size-4" />
                  コピーを実行
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={isCopyingToTax}
                  onClick={() => {
                    setTaxCopyResults(null)
                    setTaxCopyProgress(null)
                  }}
                >
                  別の期間でやり直す
                </Button>
                <Button disabled={isCopyingToTax} onClick={() => setShowTaxCopyModal(false)}>
                  {isCopyingToTax ? "処理中..." : "閉じる"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 追加分の一括取り込み（月指定不要）モーダル */}
      <Dialog open={showAdditionalModal} onOpenChange={setShowAdditionalModal}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderPlus className="size-5" />
              追加分をまとめて取り込む
            </DialogTitle>
            <DialogDescription>
              後から届いた資料を、AIが対象年月を判定して全期間まとめて税理士提出フォルダにコピーします。
              既に提出済みの月に加わった資料は「追加分/」フォルダへ「【追加】」を付けて保存します。
              年月の指定は不要です（コピーのみ・既存ファイルは上書きしません）。
            </DialogDescription>
          </DialogHeader>

          {!additionalResult ? (
            // 入力フェーズ（説明のみ）
            <div className="space-y-3 overflow-y-auto pr-1 text-sm text-muted-foreground">
              <ul className="list-disc space-y-1.5 pl-5">
                <li>請求書／領収書／社会保険料／その他／スタッフ領収書／売上 を再帰的にスキャンします。</li>
                <li>DB管理の書類は保存済みの日付、手動アップロード分はファイル名またはAIで年月を判定します。</li>
                <li>年月を判定できない資料は「要確認」として一覧表示します（コピーされません）。</li>
                <li>資料が多い場合は数分かかることがあります。</li>
              </ul>
            </div>
          ) : (
            // 結果表示フェーズ
            <div className="space-y-3 overflow-y-auto pr-1">
              <div className="rounded-md border bg-muted/40 p-4">
                <div className="text-base font-semibold">
                  ✅ 本体 {additionalResult.totals.toBody}件 / 追加分 {additionalResult.totals.toAdditional}件
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  スキップ {additionalResult.totals.skipped}件 / 要確認 {additionalResult.totals.needsReview}件
                </div>
              </div>

              {additionalResult.months.length > 0 && (
                <div className="rounded-md border max-h-[35vh] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-background border-b">
                      <tr className="text-left">
                        <th className="px-3 py-2 font-medium">年月</th>
                        <th className="px-3 py-2 font-medium text-right">本体へ</th>
                        <th className="px-3 py-2 font-medium text-right">追加分へ</th>
                        <th className="px-3 py-2 font-medium text-right">スキップ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {additionalResult.months.map((m, i) => (
                        <tr key={i} className="border-t">
                          <td className="px-3 py-1.5">
                            {m.year}年{String(m.month).padStart(2, "0")}月
                          </td>
                          <td className="px-3 py-1.5 text-right">{m.toBody}</td>
                          <td className="px-3 py-1.5 text-right">
                            {m.toAdditional > 0 ? (
                              <span className="text-amber-700 dark:text-amber-400 font-medium">
                                {m.toAdditional}
                              </span>
                            ) : (
                              0
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">{m.skipped}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {additionalResult.needsReviewList.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="size-4" />
                    要確認（年月を判定できませんでした）: {additionalResult.needsReviewList.length}件
                  </div>
                  <div className="rounded-md border max-h-[30vh] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-background border-b">
                        <tr className="text-left">
                          <th className="px-3 py-2 font-medium">ファイル名</th>
                          <th className="px-3 py-2 font-medium">理由</th>
                        </tr>
                      </thead>
                      <tbody>
                        {additionalResult.needsReviewList.map((r, i) => (
                          <tr key={i} className="border-t">
                            <td className="px-3 py-1.5 max-w-[220px] truncate" title={r.path}>
                              {r.file_name}
                            </td>
                            <td className="px-3 py-1.5 text-muted-foreground">{r.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            {!additionalResult ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => setShowAdditionalModal(false)}
                  disabled={isImportingAdditional}
                >
                  キャンセル
                </Button>
                <Button onClick={handleImportAdditional} disabled={isImportingAdditional}>
                  {isImportingAdditional ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      取り込み中...
                    </>
                  ) : (
                    <>
                      <FolderPlus className="mr-2 size-4" />
                      取り込みを実行
                    </>
                  )}
                </Button>
              </>
            ) : (
              <Button onClick={() => setShowAdditionalModal(false)}>閉じる</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* スキャン結果モーダル */}
      <Dialog open={showScanResult} onOpenChange={setShowScanResult}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="size-5" />
              スキャン結果
            </DialogTitle>
            <DialogDescription>
              {scanResult?.scanned ?? 0}件のファイルを処理しました
            </DialogDescription>
          </DialogHeader>
          {scanResult && scanResult.details.length > 0 && (
            <div className="max-h-60 space-y-2 overflow-y-auto">
              {scanResult.details.map((d, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
                    d.status === "registered"
                      ? "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/30"
                      : d.status === "needs_review"
                        ? "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"
                        : "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30"
                  }`}
                >
                  {d.status === "registered" ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[#A0703A]" />
                  ) : d.status === "needs_review" ? (
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-red-600" />
                  )}
                  <div className="min-w-0 flex-1">
                    {d.status === "registered" && d.vendor ? (
                      <span>
                        {d.vendor} / {d.type} / ¥{(d.amount ?? 0).toLocaleString()}
                      </span>
                    ) : d.status === "needs_review" ? (
                      <span>
                        {d.filename} — {d.reasons?.join("、")}
                      </span>
                    ) : (
                      <span>
                        {d.filename} — {d.error}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setShowScanResult(false)}>閉じる</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
