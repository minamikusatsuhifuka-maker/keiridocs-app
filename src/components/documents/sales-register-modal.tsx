"use client"

import { useState, useCallback } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Progress } from "@/components/ui/progress"
import { FileDropzone } from "@/components/documents/file-dropzone"
import {
  TrendingUp,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Calendar,
  Building2,
  JapaneseYen,
  FileText,
} from "lucide-react"
import { toast } from "sonner"
import type { OcrResult } from "@/lib/gemini"

interface UploadedFile {
  base64: string
  mimeType: string
  name: string
  size: number
  preview: string | null
}

/** 売上登録で受け付けるMIMEタイプ */
const SALES_ACCEPTED_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/webp",
  "application/pdf",
]

/** 1ファイルのプレビュー編集状態 */
interface SalesPreviewItem {
  file: UploadedFile
  ocr: OcrResult | null
  vendor_name: string
  amount: string
  issue_date: string
  description: string
  isAnalyzing: boolean
  error: string | null
  status: "preview" | "registered" | "register_error" | "skipped"
  registerError: string | null
  yearMonth: string | null
}

interface SalesRegisterModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  registrantId: string | null
  onRegistered?: () => void
}

/**
 * 売上登録モーダル
 * - JPG/PNG/PDFをドラッグ&ドロップまたは選択（複数可）
 * - 各ファイルをAI解析してプレビュー（日付・金額・取引先・内容）
 * - 確認後に「売上登録」ボタンでDropbox保存+DB登録
 */
export function SalesRegisterModal({
  open,
  onOpenChange,
  registrantId,
  onRegistered,
}: SalesRegisterModalProps) {
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [items, setItems] = useState<SalesPreviewItem[]>([])
  const [isAnalyzingAll, setIsAnalyzingAll] = useState(false)
  const [analyzeProgress, setAnalyzeProgress] = useState(0)
  const [analyzeTotal, setAnalyzeTotal] = useState(0)
  const [analyzeMessage, setAnalyzeMessage] = useState("")
  const [isRegistering, setIsRegistering] = useState(false)
  const [registerProgress, setRegisterProgress] = useState(0)
  const [registerTotal, setRegisterTotal] = useState(0)
  const [completed, setCompleted] = useState(false)
  const [completedYearMonths, setCompletedYearMonths] = useState<string[]>([])

  /** 受け付け対象（JPG/PNG/PDF）以外を弾く */
  const filterAccepted = (list: UploadedFile[]) =>
    list.filter((f) => SALES_ACCEPTED_TYPES.includes(f.mimeType))

  /** 1ファイル分のAI解析を実行 */
  const analyzeOne = useCallback(async (file: UploadedFile): Promise<Partial<SalesPreviewItem>> => {
    try {
      const res = await fetch("/api/documents/sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: file.base64,
          filename: file.name,
          contentType: file.mimeType,
          mode: "analyze",
        }),
      })

      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: string }
        return {
          ocr: null,
          isAnalyzing: false,
          error: json.error || "AI解析に失敗しました",
        }
      }

      const json = await res.json() as { data: OcrResult }
      const ocr = json.data
      return {
        ocr,
        vendor_name: ocr.vendor_name || "",
        amount: ocr.amount != null ? String(ocr.amount) : "",
        issue_date: ocr.issue_date || "",
        description: ocr.description || "",
        isAnalyzing: false,
        error: null,
      }
    } catch (error) {
      return {
        ocr: null,
        isAnalyzing: false,
        error: error instanceof Error ? error.message : "AI解析に失敗しました",
      }
    }
  }, [])

  /** ファイル選択時: プレビュー初期化＋順次AI解析 */
  const handleFilesChange = useCallback(async (newFiles: UploadedFile[]) => {
    const accepted = filterAccepted(newFiles)
    const rejected = newFiles.length - accepted.length
    if (rejected > 0) {
      toast.warning(`${rejected}件のファイルは非対応形式のため除外しました（JPG/PNG/PDFのみ対応）`)
    }
    setFiles(accepted)

    // プレビュー項目を初期化
    const initial: SalesPreviewItem[] = accepted.map((f) => ({
      file: f,
      ocr: null,
      vendor_name: "",
      amount: "",
      issue_date: "",
      description: "",
      isAnalyzing: true,
      error: null,
      status: "preview" as const,
      registerError: null,
      yearMonth: null,
    }))
    setItems(initial)

    // AI解析: 2秒間隔で順次実行。10件以上の場合は5件ずつバッチ処理しバッチ間で3秒待機
    setIsAnalyzingAll(true)
    setAnalyzeTotal(accepted.length)
    setAnalyzeProgress(0)
    setAnalyzeMessage("")

    const BATCH_SIZE = 5
    const BATCH_INTERVAL_MS = 3000
    const PER_FILE_INTERVAL_MS = 2000
    const useBatch = accepted.length >= 10

    for (let i = 0; i < accepted.length; i++) {
      // バッチ境界（5件ごと）に追加で3秒待機
      if (useBatch && i > 0 && i % BATCH_SIZE === 0) {
        const batchNum = Math.floor(i / BATCH_SIZE) + 1
        const totalBatches = Math.ceil(accepted.length / BATCH_SIZE)
        setAnalyzeMessage(`バッチ${batchNum}/${totalBatches}の処理を準備中（3秒待機）...`)
        await new Promise((resolve) => setTimeout(resolve, BATCH_INTERVAL_MS))
        setAnalyzeMessage("")
      }

      // 2件目以降は2秒間隔を空ける
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, PER_FILE_INTERVAL_MS))
      }

      setAnalyzeProgress(i + 1)
      const result = await analyzeOne(accepted[i])
      setItems((prev) => {
        const next = [...prev]
        if (next[i]) {
          next[i] = { ...next[i], ...result }
        }
        return next
      })
    }
    setIsAnalyzingAll(false)
    setAnalyzeMessage("")
  }, [analyzeOne])

  /** プレビュー項目のフィールドを更新 */
  const updateField = useCallback(
    (index: number, key: "vendor_name" | "amount" | "issue_date" | "description", value: string) => {
      setItems((prev) => {
        const next = [...prev]
        if (next[index]) {
          next[index] = { ...next[index], [key]: value }
        }
        return next
      })
    },
    []
  )

  /** プレビュー項目を削除 */
  const removeItem = useCallback((index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index))
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }, [])

  /** 全件登録 */
  const handleRegisterAll = useCallback(async () => {
    if (items.length === 0) return

    const targets = items.filter((it) => it.status === "preview" && !it.error)
    if (targets.length === 0) {
      toast.error("登録できる項目がありません")
      return
    }

    setIsRegistering(true)
    setRegisterTotal(targets.length)
    setRegisterProgress(0)

    const yearMonthsRegistered = new Set<string>()

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx]
      if (item.status !== "preview" || item.error) continue

      setRegisterProgress((prev) => prev + 1)

      try {
        const res = await fetch("/api/documents/sales", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file: item.file.base64,
            filename: item.file.name,
            contentType: item.file.mimeType,
            mode: "register",
            vendor_name: item.vendor_name,
            amount: item.amount ? Number(item.amount) : null,
            issue_date: item.issue_date || null,
            description: item.description,
            // 書類登録スタッフ（document_staffテーブルのID）
            document_staff_id: registrantId,
            // 事前解析済みのOCR結果を送ってサーバー側での再解析を回避（Gemini RPM節約）
            ocr_result: item.ocr,
          }),
        })

        if (!res.ok) {
          const json = await res.json().catch(() => ({})) as { error?: string }
          setItems((prev) => {
            const next = [...prev]
            next[idx] = {
              ...next[idx],
              status: "register_error",
              registerError: json.error || "登録に失敗しました",
            }
            return next
          })
          continue
        }

        const json = await res.json() as { year_month?: string; skipped?: boolean; reason?: string }

        // スキップ扱い（10MB超など）
        if (json.skipped) {
          setItems((prev) => {
            const next = [...prev]
            next[idx] = {
              ...next[idx],
              status: "skipped",
              registerError: json.reason || "サイズ超過のためスキップしました",
            }
            return next
          })
          continue
        }

        if (json.year_month) yearMonthsRegistered.add(json.year_month)

        setItems((prev) => {
          const next = [...prev]
          next[idx] = {
            ...next[idx],
            status: "registered",
            yearMonth: json.year_month || null,
          }
          return next
        })
      } catch (error) {
        setItems((prev) => {
          const next = [...prev]
          next[idx] = {
            ...next[idx],
            status: "register_error",
            registerError: error instanceof Error ? error.message : "登録に失敗しました",
          }
          return next
        })
      }
    }

    setIsRegistering(false)
    setCompleted(true)
    setCompletedYearMonths(Array.from(yearMonthsRegistered))

    const successItems = yearMonthsRegistered.size > 0
    if (successItems) {
      const folders = Array.from(yearMonthsRegistered).join("、")
      toast.success(`✅ 売上登録完了！Dropboxの${folders}フォルダに保存しました`)
      onRegistered?.()
    }
  }, [items, registrantId, onRegistered])

  /** 状態をリセット */
  const reset = useCallback(() => {
    setFiles([])
    setItems([])
    setIsAnalyzingAll(false)
    setAnalyzeProgress(0)
    setAnalyzeTotal(0)
    setAnalyzeMessage("")
    setIsRegistering(false)
    setRegisterProgress(0)
    setRegisterTotal(0)
    setCompleted(false)
    setCompletedYearMonths([])
  }, [])

  /** ダイアログを閉じるとき */
  const handleClose = useCallback((next: boolean) => {
    if (!next) {
      // 完了後 or 何も登録していなければ閉じる
      if (isRegistering) return // 登録中は閉じさせない
      reset()
    }
    onOpenChange(next)
  }, [isRegistering, reset, onOpenChange])

  const successCount = items.filter((it) => it.status === "registered").length
  const errorCount = items.filter((it) => it.status === "register_error").length
  const skippedCount = items.filter((it) => it.status === "skipped").length
  const previewCount = items.filter((it) => it.status === "preview" && !it.error).length

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="flex max-h-[90vh] min-h-[80vh] w-[95vw] max-w-6xl flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <TrendingUp className="size-5 text-[#B8956A]" />
            売上登録
          </DialogTitle>
          <DialogDescription>
            JPG / PNG / PDF をアップロードすると AI が売上日・金額・取引先・内容を自動で読み取ります。
            複数ファイル一括登録に対応。
          </DialogDescription>
        </DialogHeader>

        {/* スクロール可能な本体エリア */}
        <div className="flex-1 overflow-y-auto px-6 py-4">

        {/* 完了画面 */}
        {completed ? (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-3 rounded-lg border border-[#E0CEB8] bg-[#FAF7F0] py-6 dark:border-[#A0703A]/30 dark:bg-[#A0703A]/10">
              <CheckCircle2 className="size-12 text-[#A0703A] dark:text-[#D4A860]" />
              <p className="text-lg font-semibold text-[#8B5E2F] dark:text-[#D4A860]">
                ✅ 売上登録完了！
              </p>
              {completedYearMonths.length > 0 && (
                <p className="text-sm text-[#8B5E2F] dark:text-[#D4A860]">
                  Dropboxの{completedYearMonths.join("、")}フォルダに保存しました
                </p>
              )}
              <div className="grid grid-cols-3 gap-3 pt-2">
                <div className="rounded-md bg-white/80 px-4 py-2 text-center text-sm dark:bg-white/5">
                  <CheckCircle2 className="mx-auto size-4 text-[#A0703A]" />
                  <p className="mt-0.5 font-bold">{successCount}件 成功</p>
                </div>
                <div className="rounded-md bg-white/80 px-4 py-2 text-center text-sm dark:bg-white/5">
                  <AlertTriangle className="mx-auto size-4 text-amber-600" />
                  <p className="mt-0.5 font-bold">{skippedCount}件 スキップ</p>
                </div>
                <div className="rounded-md bg-white/80 px-4 py-2 text-center text-sm dark:bg-white/5">
                  <XCircle className="mx-auto size-4 text-red-600" />
                  <p className="mt-0.5 font-bold">{errorCount}件 エラー</p>
                </div>
              </div>
            </div>

            {/* スキップ一覧（全件表示・スクロール可） */}
            {skippedCount > 0 && (
              <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/20">
                <p className="text-xs font-medium text-amber-800 dark:text-amber-300">スキップ:</p>
                <div className="max-h-48 space-y-1 overflow-y-auto">
                  {items
                    .filter((it) => it.status === "skipped")
                    .map((it, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                        <span className="break-all">
                          {it.file.name} — {it.registerError}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* エラー一覧（全件表示・スクロール可） */}
            {errorCount > 0 && (
              <div className="space-y-1 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/20">
                <p className="text-xs font-medium text-red-700 dark:text-red-400">エラー:</p>
                <div className="max-h-60 space-y-1 overflow-y-auto">
                  {items
                    .filter((it) => it.status === "register_error")
                    .map((it, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm">
                        <XCircle className="mt-0.5 size-3.5 shrink-0 text-red-600" />
                        <span className="break-all">
                          {it.file.name} — {it.registerError}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            <DialogFooter>
              <Button onClick={() => handleClose(false)} className="w-full">
                閉じる
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            {/* ファイルアップロード（プレビュー前のみ表示） */}
            {items.length === 0 && (
              <FileDropzone files={files} onFilesChange={handleFilesChange} maxSizeMB={20} />
            )}

            {/* AI解析中の進捗 */}
            {isAnalyzingAll && (
              <div className="space-y-2 rounded-md border border-[#E0CEB8] bg-[#FAF7F0] px-3 py-2 dark:border-[#A0703A]/30 dark:bg-[#A0703A]/10">
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin text-[#A0703A]" />
                  <span>
                    AI解析中... {analyzeProgress}/{analyzeTotal}件
                  </span>
                </div>
                {analyzeTotal > 0 && (
                  <Progress value={(analyzeProgress / analyzeTotal) * 100} className="h-2" />
                )}
                {analyzeMessage && (
                  <p className="text-xs text-muted-foreground">{analyzeMessage}</p>
                )}
              </div>
            )}

            {isRegistering && registerTotal > 0 && (
              <div className="space-y-2 rounded-md border border-[#E0CEB8] bg-[#FAF7F0] px-3 py-2 dark:border-[#A0703A]/30 dark:bg-[#A0703A]/10">
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin text-[#A0703A]" />
                  <span>{registerProgress}/{registerTotal} 件登録中...</span>
                </div>
                <Progress value={(registerProgress / registerTotal) * 100} className="h-2" />
              </div>
            )}

            {/* プレビュー一覧 */}
            {items.length > 0 && (
              <div className="space-y-3">
                <p className="text-sm font-medium">
                  AI解析結果（確認・編集して登録してください）
                </p>
                {items.map((item, idx) => (
                  <div
                    key={idx}
                    className={`rounded-lg border p-3 ${
                      item.status === "registered"
                        ? "border-[#A0703A]/30 bg-[#FAF7F0] dark:border-[#A0703A]/30 dark:bg-[#A0703A]/10"
                        : item.status === "skipped"
                          ? "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20"
                          : item.status === "register_error" || item.error
                            ? "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/20"
                            : "border-border bg-card"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {/* プレビュー画像/アイコン */}
                      <div className="shrink-0">
                        {item.file.preview ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.file.preview}
                            alt={item.file.name}
                            className="size-16 rounded border object-cover"
                          />
                        ) : (
                          <div className="flex size-16 items-center justify-center rounded border bg-muted">
                            <FileText className="size-6 text-red-600" />
                          </div>
                        )}
                      </div>

                      {/* ファイル情報 + 編集フィールド */}
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-medium">{item.file.name}</p>
                          {item.status === "registered" ? (
                            <span className="flex shrink-0 items-center gap-1 rounded-full bg-[#A0703A]/15 px-2 py-0.5 text-xs font-medium text-[#A0703A]">
                              <CheckCircle2 className="size-3" />
                              登録済み
                            </span>
                          ) : item.status === "skipped" ? (
                            <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                              <AlertTriangle className="size-3" />
                              スキップ
                            </span>
                          ) : item.status === "register_error" ? (
                            <span className="flex shrink-0 items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
                              <XCircle className="size-3" />
                              エラー
                            </span>
                          ) : item.isAnalyzing ? (
                            <span className="flex shrink-0 items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                              <Loader2 className="size-3 animate-spin" />
                              解析中
                            </span>
                          ) : item.error ? (
                            <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                              <AlertTriangle className="size-3" />
                              解析失敗
                            </span>
                          ) : null}
                        </div>

                        {item.error && (
                          <p className="text-xs text-amber-700 dark:text-amber-400">
                            {item.error}（手動入力で登録できます）
                          </p>
                        )}

                        {item.registerError && (
                          <p className="text-xs text-red-700 dark:text-red-400">
                            {item.registerError}
                          </p>
                        )}

                        {/* 編集フォーム（登録済み・スキップ以外） */}
                        {item.status !== "registered" && item.status !== "skipped" && (
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <div className="space-y-1">
                              <Label className="flex items-center gap-1 text-xs">
                                <Building2 className="size-3" />
                                取引先
                              </Label>
                              <Input
                                value={item.vendor_name}
                                onChange={(e) => updateField(idx, "vendor_name", e.target.value)}
                                placeholder="取引先名"
                                disabled={item.isAnalyzing || isRegistering}
                                className="h-8 text-sm"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="flex items-center gap-1 text-xs">
                                <JapaneseYen className="size-3" />
                                金額
                              </Label>
                              <Input
                                type="number"
                                value={item.amount}
                                onChange={(e) => updateField(idx, "amount", e.target.value)}
                                placeholder="0"
                                disabled={item.isAnalyzing || isRegistering}
                                className="h-8 text-sm"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="flex items-center gap-1 text-xs">
                                <Calendar className="size-3" />
                                売上日
                              </Label>
                              <Input
                                type="date"
                                value={item.issue_date}
                                onChange={(e) => updateField(idx, "issue_date", e.target.value)}
                                disabled={item.isAnalyzing || isRegistering}
                                className="h-8 text-sm"
                              />
                            </div>
                            <div className="space-y-1 sm:col-span-2">
                              <Label className="text-xs">内容</Label>
                              <Textarea
                                value={item.description}
                                onChange={(e) => updateField(idx, "description", e.target.value)}
                                placeholder="売上の内容（任意）"
                                disabled={item.isAnalyzing || isRegistering}
                                rows={2}
                                className="text-sm"
                              />
                            </div>
                          </div>
                        )}

                        {item.status !== "registered" && !isRegistering && !item.isAnalyzing && (
                          <div className="flex justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => removeItem(idx)}
                              className="h-7 text-xs text-muted-foreground"
                            >
                              削除
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                variant="outline"
                onClick={() => handleClose(false)}
                disabled={isRegistering}
              >
                キャンセル
              </Button>
              {items.length > 0 && (
                <Button
                  onClick={handleRegisterAll}
                  disabled={isRegistering || isAnalyzingAll || previewCount === 0}
                  style={{
                    background: "linear-gradient(135deg, #C8922A, #B8782A)",
                    color: "#fff",
                    boxShadow: "0 4px 12px rgba(180,120,40,0.35)",
                  }}
                >
                  {isRegistering ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      登録中...
                    </>
                  ) : (
                    <>
                      <TrendingUp className="mr-2 size-4" />
                      {previewCount}件を売上登録
                    </>
                  )}
                </Button>
              )}
            </DialogFooter>
          </div>
        )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
