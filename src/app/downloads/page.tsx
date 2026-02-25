"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { OcrResultEditor, type DocumentFormData } from "@/components/documents/ocr-result-editor"
import type { OcrResult } from "@/lib/gemini"
import type { Database } from "@/types/database"
import {
  Download,
  Upload,
  Loader2,
  Globe,
  Calendar,
  ExternalLink,
  CheckCircle2,
  Files,
  X,
} from "lucide-react"
import { toast } from "sonner"

type DownloadSource = Database["public"]["Tables"]["download_sources"]["Row"]

interface UploadedFile {
  base64: string
  mimeType: string
  name: string
  size: number
}

interface DocumentTypeRecord {
  name: string
}

// ファイル選択ダイアログ用のacceptリスト
const ACCEPT_EXTENSIONS = ".jpg,.jpeg,.png,.heic,.webp,.pdf,.docx,.xlsx,.xls,.csv"

// 対応MIMEタイプ
const ACCEPTED_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/webp",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
]

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

/** 拡張子からMIMEタイプを補正する */
function normalizeMimeType(file: File): string {
  if (ACCEPTED_TYPES.includes(file.type)) return file.type
  const ext = file.name.split(".").pop()?.toLowerCase()
  switch (ext) {
    case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    case "xls": return "application/vnd.ms-excel"
    case "csv": return "text/csv"
    case "heic": return "image/heic"
    case "webp": return "image/webp"
    default: return file.type
  }
}

// 自動取得ページ
export default function DownloadsPage() {
  const router = useRouter()
  const [sources, setSources] = useState<DownloadSource[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [documentTypes, setDocumentTypes] = useState<DocumentTypeRecord[]>([])

  // 単体アップロード用
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null)
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null)
  const [modelUsed, setModelUsed] = useState("")
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<UploadedFile | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 一括アップロード用
  const [isBulkMode, setIsBulkMode] = useState(false)
  const [bulkFiles, setBulkFiles] = useState<{ file: UploadedFile; sourceId: string }[]>([])
  const [isBulkProcessing, setIsBulkProcessing] = useState(false)
  const [bulkProgress, setBulkProgress] = useState(0)
  const bulkInputRef = useRef<HTMLInputElement>(null)

  // ソース一覧と書類種別を取得
  useEffect(() => {
    async function fetchData() {
      try {
        const [sourcesRes, typesRes] = await Promise.all([
          fetch("/api/settings?table=download_sources"),
          fetch("/api/settings?table=document_types"),
        ])

        if (sourcesRes.ok) {
          const json = await sourcesRes.json() as { data?: DownloadSource[] }
          setSources((json.data ?? []).filter((s) => s.is_active))
        }

        if (typesRes.ok) {
          const json = await typesRes.json() as { data: DocumentTypeRecord[] }
          if (json.data && json.data.length > 0) {
            setDocumentTypes(json.data)
          }
        }
      } catch {
        toast.error("データの取得に失敗しました")
      } finally {
        setIsLoading(false)
      }
    }
    fetchData()
  }, [])

  // ファイルをBase64に変換
  const processFile = useCallback((file: File): Promise<UploadedFile> => {
    return new Promise((resolve, reject) => {
      const mimeType = normalizeMimeType(file)
      if (!ACCEPTED_TYPES.includes(mimeType)) {
        reject(new Error(`非対応の形式です: ${file.name}`))
        return
      }
      if (file.size > MAX_FILE_SIZE) {
        reject(new Error(`ファイルサイズが10MBを超えています: ${file.name}`))
        return
      }

      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result as string
        const base64 = result.split(",")[1]
        resolve({ base64, mimeType, name: file.name, size: file.size })
      }
      reader.onerror = () => reject(new Error(`読み込みに失敗しました: ${file.name}`))
      reader.readAsDataURL(file)
    })
  }, [])

  // 単体ファイル選択（ソースごと）
  const handleFileSelect = useCallback(
    async (sourceId: string, fileList: FileList) => {
      if (fileList.length === 0) return

      try {
        const processed = await processFile(fileList[0])
        setUploadedFile(processed)
        setActiveSourceId(sourceId)
        setOcrResult(null)
        setIsAnalyzing(true)

        // AI解析を実行
        const response = await fetch("/api/gemini", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base64: processed.base64,
            mimeType: processed.mimeType,
            fileName: processed.name,
          }),
        })

        if (!response.ok) {
          const errorData = await response.json() as { error: string }
          throw new Error(errorData.error || "AI解析に失敗しました")
        }

        const json = await response.json() as { data: OcrResult; model_used?: string }
        // ソース名を取引先名にセット
        const source = sources.find((s) => s.id === sourceId)
        const result = { ...json.data, vendor_name: source?.name ?? json.data.vendor_name }
        setOcrResult(result)
        if (json.model_used) setModelUsed(json.model_used)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "ファイルの処理に失敗しました")
        setOcrResult(null)
      } finally {
        setIsAnalyzing(false)
      }
    },
    [processFile, sources]
  )

  // 書類保存（単体）
  const handleSubmit = useCallback(
    async (formData: DocumentFormData) => {
      if (!uploadedFile || !activeSourceId) return

      setIsSubmitting(true)
      try {
        // ファイル名生成
        let fileName = uploadedFile.name
        if (!fileName.includes(".")) {
          const extMap: Record<string, string> = {
            "application/pdf": ".pdf",
            "image/jpeg": ".jpg",
            "image/png": ".png",
          }
          fileName += extMap[uploadedFile.mimeType] || ".pdf"
        }

        // Dropboxにアップロード
        const uploadResponse = await fetch("/api/dropbox/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base64: uploadedFile.base64,
            fileName,
            type: formData.type,
            date: formData.issue_date || null,
            status: "未処理",
          }),
        })

        if (!uploadResponse.ok) {
          const errorData = await uploadResponse.json() as { error: string }
          throw new Error(errorData.error || "Dropboxへのアップロードに失敗しました")
        }

        const { data: uploadData } = await uploadResponse.json() as {
          data: { path: string }
        }

        // DB に書類レコードを保存
        const docResponse = await fetch("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: formData.type,
            vendor_name: formData.vendor_name,
            amount: formData.amount ? Number(formData.amount) : null,
            issue_date: formData.issue_date || null,
            due_date: formData.due_date || null,
            description: formData.description || null,
            input_method: "upload",
            dropbox_path: uploadData.path,
            ocr_raw: ocrResult,
          }),
        })

        if (!docResponse.ok) {
          const errorData = await docResponse.json() as { error: string }
          throw new Error(errorData.error || "書類の登録に失敗しました")
        }

        // last_downloaded_at を更新
        await fetch(`/api/settings?table=download_sources&id=${activeSourceId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ last_downloaded_at: new Date().toISOString() }),
        })

        // ソースのローカル状態も更新
        setSources((prev) =>
          prev.map((s) =>
            s.id === activeSourceId
              ? { ...s, last_downloaded_at: new Date().toISOString() }
              : s
          )
        )

        toast.success("書類を登録しました")
        setActiveSourceId(null)
        setUploadedFile(null)
        setOcrResult(null)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "登録に失敗しました")
      } finally {
        setIsSubmitting(false)
      }
    },
    [uploadedFile, activeSourceId, ocrResult]
  )

  // 一括アップロード: ファイル選択
  const handleBulkFileSelect = useCallback(
    async (fileList: FileList) => {
      if (fileList.length === 0 || sources.length === 0) return

      const newFiles: { file: UploadedFile; sourceId: string }[] = []
      for (let i = 0; i < fileList.length; i++) {
        try {
          const processed = await processFile(fileList[i])
          // デフォルトで最初のソースを割り当て
          newFiles.push({ file: processed, sourceId: sources[0].id })
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "ファイルの処理に失敗しました")
        }
      }

      if (newFiles.length > 0) {
        setBulkFiles((prev) => [...prev, ...newFiles])
      }
    },
    [processFile, sources]
  )

  // 一括アップロード: ソース変更
  const handleBulkSourceChange = useCallback((index: number, sourceId: string) => {
    setBulkFiles((prev) =>
      prev.map((item, i) => (i === index ? { ...item, sourceId } : item))
    )
  }, [])

  // 一括アップロード: ファイル削除
  const handleBulkFileRemove = useCallback((index: number) => {
    setBulkFiles((prev) => prev.filter((_, i) => i !== index))
  }, [])

  // 一括アップロード: 実行
  const handleBulkProcess = useCallback(async () => {
    if (bulkFiles.length === 0) return

    setIsBulkProcessing(true)
    setBulkProgress(0)

    let successCount = 0
    for (let i = 0; i < bulkFiles.length; i++) {
      const { file, sourceId } = bulkFiles[i]
      const source = sources.find((s) => s.id === sourceId)

      try {
        // AI解析
        const analyzeRes = await fetch("/api/gemini", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base64: file.base64,
            mimeType: file.mimeType,
            fileName: file.name,
          }),
        })

        let ocrData: OcrResult | null = null
        if (analyzeRes.ok) {
          const json = await analyzeRes.json() as { data: OcrResult }
          ocrData = { ...json.data, vendor_name: source?.name ?? json.data.vendor_name }
        }

        // ファイル名
        let fileName = file.name
        if (!fileName.includes(".")) {
          fileName += ".pdf"
        }

        // Dropboxにアップロード
        const uploadRes = await fetch("/api/dropbox/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base64: file.base64,
            fileName,
            type: ocrData?.type ?? "請求書",
            date: ocrData?.issue_date ?? null,
            status: "未処理",
          }),
        })

        if (!uploadRes.ok) throw new Error("アップロードに失敗しました")

        const { data: uploadData } = await uploadRes.json() as {
          data: { path: string }
        }

        // DB保存
        await fetch("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: ocrData?.type ?? "請求書",
            vendor_name: source?.name ?? ocrData?.vendor_name ?? "",
            amount: ocrData?.amount ?? null,
            issue_date: ocrData?.issue_date ?? null,
            due_date: ocrData?.due_date ?? null,
            description: ocrData?.description ?? null,
            input_method: "upload",
            dropbox_path: uploadData.path,
            ocr_raw: ocrData,
          }),
        })

        // last_downloaded_at を更新
        await fetch(`/api/settings?table=download_sources&id=${sourceId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ last_downloaded_at: new Date().toISOString() }),
        })

        successCount++
      } catch {
        toast.error(`${file.name} の処理に失敗しました`)
      }

      setBulkProgress(i + 1)
    }

    // ソースの状態を更新
    const updatedSourceIds = new Set(bulkFiles.map((f) => f.sourceId))
    setSources((prev) =>
      prev.map((s) =>
        updatedSourceIds.has(s.id)
          ? { ...s, last_downloaded_at: new Date().toISOString() }
          : s
      )
    )

    setIsBulkProcessing(false)
    setBulkFiles([])
    toast.success(`${successCount}/${bulkFiles.length}件 の書類を登録しました`)
  }, [bulkFiles, sources])

  // 最終取得日のフォーマット
  function formatDate(dateStr: string | null) {
    if (!dateStr) return "未取得"
    return new Date(dateStr).toLocaleDateString("ja-JP")
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">自動取得</h1>
          <p className="text-sm text-muted-foreground">
            登録済みソースからファイルをアップロードして請求書を取り込みます
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={isBulkMode ? "default" : "outline"}
            onClick={() => {
              setIsBulkMode(!isBulkMode)
              setBulkFiles([])
              setActiveSourceId(null)
            }}
          >
            <Files className="size-4" />
            {isBulkMode ? "一括モード中" : "一括アップロード"}
          </Button>
        </div>
      </div>

      {sources.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Download className="mx-auto size-12 text-muted-foreground/50" />
            <p className="mt-4 text-sm text-muted-foreground">
              自動取得ソースが登録されていません
            </p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => router.push("/settings")}
            >
              設定画面で登録する
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* 一括アップロードモード */}
          {isBulkMode && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">一括アップロード</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => bulkInputRef.current?.click()}
                    disabled={isBulkProcessing}
                  >
                    <Upload className="size-4" />
                    ファイルを追加
                  </Button>
                  <input
                    ref={bulkInputRef}
                    type="file"
                    accept={ACCEPT_EXTENSIONS}
                    multiple
                    onChange={(e) => {
                      if (e.target.files) handleBulkFileSelect(e.target.files)
                      e.target.value = ""
                    }}
                    className="hidden"
                  />
                  {bulkFiles.length > 0 && (
                    <Button
                      onClick={handleBulkProcess}
                      disabled={isBulkProcessing}
                    >
                      {isBulkProcessing ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          処理中 ({bulkProgress}/{bulkFiles.length})
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="size-4" />
                          {bulkFiles.length}件を一括登録
                        </>
                      )}
                    </Button>
                  )}
                </div>

                {bulkFiles.length > 0 && (
                  <div className="space-y-2">
                    {bulkFiles.map((item, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-3 rounded-md border p-3"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="truncate text-sm font-medium">{item.file.name}</p>
                        </div>
                        <select
                          value={item.sourceId}
                          onChange={(e) => handleBulkSourceChange(idx, e.target.value)}
                          className="h-8 rounded-md border bg-background px-2 text-sm"
                          disabled={isBulkProcessing}
                        >
                          {sources.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleBulkFileRemove(idx)}
                          disabled={isBulkProcessing}
                          className="size-8"
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ソースカード一覧 */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sources.map((source) => (
              <Card key={source.id} className="relative">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <CardTitle className="text-base">{source.name}</CardTitle>
                    <Badge
                      variant={source.schedule === "monthly" ? "default" : "secondary"}
                      className="text-xs"
                    >
                      {source.schedule === "monthly" ? "月次" : "手動"}
                    </Badge>
                  </div>
                  {source.description && (
                    <p className="text-xs text-muted-foreground">{source.description}</p>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    {source.url && (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 hover:text-foreground"
                      >
                        <Globe className="size-3" />
                        サイトを開く
                        <ExternalLink className="size-3" />
                      </a>
                    )}
                    <span className="flex items-center gap-1">
                      <Calendar className="size-3" />
                      {formatDate(source.last_downloaded_at)}
                    </span>
                  </div>

                  {!isBulkMode && (
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => {
                        setActiveSourceId(source.id)
                        fileInputRef.current?.click()
                      }}
                      disabled={isAnalyzing || isSubmitting}
                    >
                      <Upload className="size-4" />
                      ファイルをアップロードして取込
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          {/* 隠しファイルインプット（単体用） */}
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_EXTENSIONS}
            onChange={(e) => {
              if (e.target.files && activeSourceId) {
                handleFileSelect(activeSourceId, e.target.files)
              }
              e.target.value = ""
            }}
            className="hidden"
          />

          {/* OCR結果エディタ（単体アップロード時） */}
          {activeSourceId && (isAnalyzing || ocrResult !== null) && (
            <div className="mx-auto max-w-2xl">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium">
                  {sources.find((s) => s.id === activeSourceId)?.name} の書類
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setActiveSourceId(null)
                    setOcrResult(null)
                    setUploadedFile(null)
                  }}
                >
                  <X className="size-4" />
                  キャンセル
                </Button>
              </div>
              <OcrResultEditor
                ocrResult={ocrResult}
                defaultType="請求書"
                isAnalyzing={isAnalyzing}
                isSubmitting={isSubmitting}
                onSubmit={handleSubmit}
                modelUsed={modelUsed}
                documentTypes={documentTypes.length > 0 ? documentTypes : undefined}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
