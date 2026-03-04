"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { CameraCapture } from "@/components/documents/camera-capture"
import { FileDropzone } from "@/components/documents/file-dropzone"
import { OcrResultEditor, type DocumentFormData } from "@/components/documents/ocr-result-editor"
import type { OcrResult } from "@/lib/gemini"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { Progress } from "@/components/ui/progress"
import {
  Camera, Upload, ArrowRight, Loader2, CheckCircle2, ListIcon, Plus,
  AlertTriangle, Zap, Eye, XCircle,
} from "lucide-react"
import { toast } from "sonner"

/** 重複候補の型 */
interface DuplicateCandidate {
  id: string
  vendor_name: string
  amount: number | null
  type: string
  issue_date: string | null
  due_date: string | null
  file_hash: string | null
  created_at: string
}

/** 重複レベル */
type DuplicateLevel = "exact" | "likely" | null

interface CapturedImage {
  base64: string
  mimeType: string
  thumbnail: string
}

interface UploadedFile {
  base64: string
  mimeType: string
  name: string
  size: number
  preview: string | null
}

interface DocumentTypeRecord {
  name: string
}

/** 全自動モード: 1ファイルの処理結果 */
interface AutoResult {
  filename: string
  status: "registered" | "needs_review" | "error"
  document?: Record<string, unknown>
  review_reasons?: string[]
  ocr_result?: OcrResult
  error?: string
}

// 書類登録ページ
export default function NewDocumentPage() {
  const router = useRouter()
  const [documentType, setDocumentType] = useState("請求書")
  const [activeTab, setActiveTab] = useState("upload")

  // カメラ撮影の画像
  const [capturedImages, setCapturedImages] = useState<CapturedImage[]>([])
  // ファイルアップロード
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([])

  // AI解析結果
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null)
  const [modelUsed, setModelUsed] = useState<string>("")
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showEditor, setShowEditor] = useState(false)

  // 登録成功状態
  const [isRegistered, setIsRegistered] = useState(false)

  // 重複チェック
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([])
  const [duplicateLevel, setDuplicateLevel] = useState<DuplicateLevel>(null)
  const [showDuplicateDialog, setShowDuplicateDialog] = useState(false)
  const [pendingFormData, setPendingFormData] = useState<DocumentFormData | null>(null)
  const [pendingDropboxPath, setPendingDropboxPath] = useState<string | null>(null)
  const [pendingFileHash, setPendingFileHash] = useState<string | null>(null)

  // useRefで重複スキップフラグを管理（stale closure問題を回避）
  const skipDuplicateRef = useRef(false)
  const pendingDropboxPathRef = useRef<string | null>(null)
  const pendingFileHashRef = useRef<string | null>(null)

  // 動的書類種別
  const [documentTypes, setDocumentTypes] = useState<DocumentTypeRecord[]>([])

  // 自動解析モード
  const [autoAnalyzeMode, setAutoAnalyzeMode] = useState(false)

  // 登録モード（auto=全自動 / check=チェック）
  const [registrationMode, setRegistrationMode] = useState<"auto" | "check">("check")

  // 全自動モードの処理状態
  const [autoProcessing, setAutoProcessing] = useState(false)
  const [autoProgress, setAutoProgress] = useState(0)
  const [autoTotal, setAutoTotal] = useState(0)
  const [autoCurrentFile, setAutoCurrentFile] = useState("")
  const [autoResults, setAutoResults] = useState<AutoResult[]>([])
  const [autoCompleted, setAutoCompleted] = useState(false)

  // 要確認書類のレビュー状態
  const [reviewIndex, setReviewIndex] = useState(0)
  const [isReviewing, setIsReviewing] = useState(false)

  // 書類種別リスト・設定を取得
  useEffect(() => {
    async function fetchSettings() {
      try {
        const [typesRes, modeRes, regModeRes] = await Promise.all([
          fetch("/api/settings?table=document_types"),
          fetch("/api/settings?table=settings&key=auto_analyze_mode"),
          fetch("/api/settings?table=settings&key=registration_mode"),
        ])

        if (typesRes.ok) {
          const json = await typesRes.json() as { data: DocumentTypeRecord[] }
          if (json.data && json.data.length > 0) {
            setDocumentTypes(json.data)
            setDocumentType(json.data[0].name)
          }
        }

        if (modeRes.ok) {
          const json = await modeRes.json() as { data: { value: unknown } | null }
          if (json.data && json.data.value === "auto") {
            setAutoAnalyzeMode(true)
          }
        }

        if (regModeRes.ok) {
          const json = await regModeRes.json() as { data: { value: unknown } | null }
          if (json.data && (json.data.value === "auto" || json.data.value === "check")) {
            setRegistrationMode(json.data.value as "auto" | "check")
          }
        }
      } catch {
        // フォールバック: デフォルト値を使う
      }
    }
    fetchSettings()
  }, [])

  // ファイルデータがあるかどうか
  const hasFiles =
    (activeTab === "camera" && capturedImages.length > 0) ||
    (activeTab === "upload" && uploadedFiles.length > 0)

  // AI解析を実行する
  const runAnalysis = useCallback(async () => {
    setIsAnalyzing(true)
    setShowEditor(true)
    setOcrResult(null)

    try {
      let base64: string
      let mimeType: string

      if (activeTab === "camera" && capturedImages.length > 0) {
        base64 = capturedImages[0].base64
        mimeType = capturedImages[0].mimeType
      } else if (activeTab === "upload" && uploadedFiles.length > 0) {
        base64 = uploadedFiles[0].base64
        mimeType = uploadedFiles[0].mimeType
      } else {
        throw new Error("ファイルが選択されていません")
      }

      let fileName: string | undefined
      if (activeTab === "upload" && uploadedFiles.length > 0) {
        fileName = uploadedFiles[0].name
      }

      const response = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base64, mimeType, fileName }),
      })

      if (!response.ok) {
        const errorData = await response.json() as { error: string }
        throw new Error(errorData.error || "AI解析に失敗しました")
      }

      const json = await response.json() as { data: OcrResult; model_used?: string }
      setOcrResult(json.data)
      if (json.model_used) setModelUsed(json.model_used)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "AI解析に失敗しました")
      setOcrResult(null)
    } finally {
      setIsAnalyzing(false)
    }
  }, [activeTab, capturedImages, uploadedFiles])

  // 自動解析モード: ファイルが追加されたら自動でAI解析を実行
  useEffect(() => {
    if (registrationMode === "auto") return // 全自動モードでは自動解析しない
    if (!autoAnalyzeMode) return
    if (isAnalyzing || showEditor) return

    const hasData =
      (activeTab === "camera" && capturedImages.length > 0) ||
      (activeTab === "upload" && uploadedFiles.length > 0)

    if (hasData) {
      runAnalysis()
    }
  }, [autoAnalyzeMode, capturedImages, uploadedFiles, activeTab, isAnalyzing, showEditor, runAnalysis, registrationMode])

  // 全自動モード: ファイルが追加されたら自動で全自動登録を開始
  useEffect(() => {
    if (registrationMode !== "auto") return
    if (autoProcessing || autoCompleted) return
    if (uploadedFiles.length === 0) return

    runAutoRegister(uploadedFiles)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadedFiles, registrationMode])

  // 全自動登録の実行
  const runAutoRegister = useCallback(async (files: UploadedFile[]) => {
    if (files.length === 0) return

    setAutoProcessing(true)
    setAutoProgress(0)
    setAutoTotal(files.length)
    setAutoResults([])
    setAutoCompleted(false)

    const results: AutoResult[] = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      setAutoProgress(i + 1)
      setAutoCurrentFile(file.name)

      try {
        const response = await fetch("/api/documents/auto-register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file: file.base64,
            filename: file.name,
            contentType: file.mimeType,
          }),
        })

        const result = await response.json() as {
          status: "registered" | "needs_review" | "error"
          document?: Record<string, unknown>
          review_reasons?: string[]
          ocr_result?: OcrResult
          error?: string
          filename?: string
        }

        results.push({
          filename: file.name,
          status: result.status,
          document: result.document,
          review_reasons: result.review_reasons,
          ocr_result: result.ocr_result,
          error: result.error,
        })
      } catch (error) {
        results.push({
          filename: file.name,
          status: "error",
          error: error instanceof Error ? error.message : "処理に失敗しました",
        })
      }
    }

    setAutoResults(results)
    setAutoProcessing(false)
    setAutoCompleted(true)
  }, [])

  // 登録モードを切り替えてsettingsに保存
  const toggleRegistrationMode = useCallback(async (checked: boolean) => {
    const newMode = checked ? "auto" : "check"
    setRegistrationMode(newMode)

    // リセット
    setAutoProcessing(false)
    setAutoCompleted(false)
    setAutoResults([])
    setShowEditor(false)

    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          table: "settings",
          key: "registration_mode",
          value: newMode,
        }),
      })
    } catch {
      // 保存失敗は無視
    }
  }, [])

  // 書類を登録する（チェックモード）
  const handleSubmit = useCallback(
    async (formData: DocumentFormData) => {
      setIsSubmitting(true)

      try {
        // 1. ファイルデータを準備
        let fileBase64: string
        let fileName: string
        let fileMimeType: string

        if (activeTab === "camera" && capturedImages.length > 0) {
          if (capturedImages.length > 1) {
            const { combineImagesToPdf } = await import("@/lib/pdf")
            const pdfBytes = await combineImagesToPdf(
              capturedImages.map((img) => ({
                base64: img.base64,
                mimeType: img.mimeType,
              }))
            )
            fileBase64 = Buffer.from(pdfBytes).toString("base64")
            fileName = `${formData.vendor_name}_${formData.issue_date || new Date().toISOString().slice(0, 10)}.pdf`
            fileMimeType = "application/pdf"
          } else {
            fileBase64 = capturedImages[0].base64
            fileName = `${formData.vendor_name}_${formData.issue_date || new Date().toISOString().slice(0, 10)}.jpg`
            fileMimeType = capturedImages[0].mimeType
          }
        } else if (activeTab === "upload" && uploadedFiles.length > 0) {
          if (uploadedFiles.length > 1) {
            const allImages = uploadedFiles.filter((f) =>
              f.mimeType.startsWith("image/")
            )
            const allPdfs = uploadedFiles.filter(
              (f) => f.mimeType === "application/pdf"
            )

            if (allImages.length > 0 && allPdfs.length === 0) {
              const { combineImagesToPdf } = await import("@/lib/pdf")
              const pdfBytes = await combineImagesToPdf(
                allImages.map((f) => ({
                  base64: f.base64,
                  mimeType: f.mimeType,
                }))
              )
              fileBase64 = Buffer.from(pdfBytes).toString("base64")
              fileName = `${formData.vendor_name}_${formData.issue_date || new Date().toISOString().slice(0, 10)}.pdf`
              fileMimeType = "application/pdf"
            } else {
              fileBase64 = uploadedFiles[0].base64
              fileName = uploadedFiles[0].name
              fileMimeType = uploadedFiles[0].mimeType
            }
          } else {
            fileBase64 = uploadedFiles[0].base64
            fileName = uploadedFiles[0].name
            fileMimeType = uploadedFiles[0].mimeType
          }
        } else {
          throw new Error("ファイルが選択されていません")
        }

        // 拡張子が無い場合はMIMEタイプから追加
        if (!fileName.includes(".")) {
          const extMap: Record<string, string> = {
            "application/pdf": ".pdf",
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/heic": ".heic",
            "image/webp": ".webp",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
            "application/vnd.ms-excel": ".xls",
            "text/csv": ".csv",
          }
          fileName += extMap[fileMimeType] || ".jpg"
        }

        // 2. Dropboxにアップロード（重複ダイアログからの再送信時はスキップ）
        const isForceSubmit = skipDuplicateRef.current
        let dropboxPath: string
        let fileHash: string

        if (isForceSubmit && pendingDropboxPathRef.current) {
          dropboxPath = pendingDropboxPathRef.current
          fileHash = pendingFileHashRef.current || ""
        } else {
          const uploadResponse = await fetch("/api/dropbox/upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              base64: fileBase64,
              fileName,
              type: formData.type,
              date: formData.issue_date || null,
              status: "未処理",
              vendorName: formData.vendor_name,
            }),
          })

          if (!uploadResponse.ok) {
            const errorData = await uploadResponse.json() as { error: string }
            throw new Error(errorData.error || "Dropboxへのアップロードに失敗しました")
          }

          const { data: uploadData } = await uploadResponse.json() as {
            data: { path: string; file_hash: string }
          }
          dropboxPath = uploadData.path
          fileHash = uploadData.file_hash
        }

        // 3. DB に書類レコードを保存（重複チェック付き）
        const requestBody = {
          type: formData.type,
          vendor_name: formData.vendor_name,
          amount: formData.amount ? Number(formData.amount) : null,
          issue_date: formData.issue_date || null,
          due_date: formData.due_date || null,
          description: formData.description || null,
          input_method: activeTab === "camera" ? "camera" : "upload",
          dropbox_path: dropboxPath,
          ocr_raw: ocrResult,
          tax_category: formData.tax_category || "未判定",
          account_title: formData.account_title || "",
          file_hash: fileHash,
          skip_duplicate_check: isForceSubmit,
          items: ocrResult?.items ?? [],
        }

        // refをリセット
        skipDuplicateRef.current = false

        const docResponse = await fetch("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        })

        if (!docResponse.ok) {
          const errorData = await docResponse.json() as { error: string }
          throw new Error(errorData.error || "書類の登録に失敗しました")
        }

        const docResult = await docResponse.json() as {
          data: unknown
          duplicates?: DuplicateCandidate[]
          duplicate_level?: DuplicateLevel
          warning?: string
        }

        // 重複候補がある場合はダイアログを表示
        if (docResult.duplicates && docResult.duplicates.length > 0) {
          setDuplicates(docResult.duplicates)
          setDuplicateLevel(docResult.duplicate_level || null)
          setPendingFormData(formData)
          setPendingDropboxPath(dropboxPath)
          setPendingFileHash(fileHash)
          pendingDropboxPathRef.current = dropboxPath
          pendingFileHashRef.current = fileHash
          setShowDuplicateDialog(true)
          return
        }

        // 成功後にrefをクリア
        pendingDropboxPathRef.current = null
        pendingFileHashRef.current = null
        toast.success("書類を登録しました")
        setIsRegistered(true)
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "登録に失敗しました"
        )
      } finally {
        setIsSubmitting(false)
      }
    },
    [activeTab, capturedImages, uploadedFiles, ocrResult]
  )

  // フォーム全体をリセットして次の書類を登録可能にする
  const resetForNextDocument = useCallback(() => {
    setCapturedImages([])
    setUploadedFiles([])
    setOcrResult(null)
    setModelUsed("")
    setIsAnalyzing(false)
    setIsSubmitting(false)
    setShowEditor(false)
    setIsRegistered(false)
    setAutoProcessing(false)
    setAutoCompleted(false)
    setAutoResults([])
    setAutoProgress(0)
    setAutoTotal(0)
    setAutoCurrentFile("")
    setIsReviewing(false)
    setReviewIndex(0)
    if (documentTypes.length > 0) {
      setDocumentType(documentTypes[0].name)
    } else {
      setDocumentType("請求書")
    }
  }, [documentTypes])

  // 重複を無視して強制登録する
  const handleForceSubmit = useCallback(async () => {
    if (!pendingFormData) return
    skipDuplicateRef.current = true
    setShowDuplicateDialog(false)
    await handleSubmit(pendingFormData)
  }, [pendingFormData, handleSubmit])

  // 要確認書類のレビューを開始
  const startReview = useCallback(() => {
    const needsReview = autoResults.filter((r) => r.status === "needs_review")
    if (needsReview.length === 0) return
    setReviewIndex(0)
    setIsReviewing(true)
    // 最初の要確認書類のOCR結果をセット
    const first = needsReview[0]
    if (first.ocr_result) {
      setOcrResult(first.ocr_result)
      setShowEditor(true)
    }
  }, [autoResults])

  // 要確認書類のレビュー: 登録完了時
  const handleReviewSubmit = useCallback(async (formData: DocumentFormData) => {
    // 通常のチェックモードの登録フローを再利用
    // ただしファイルデータは全自動登録APIから受け取ったOCR結果を使う
    setIsSubmitting(true)
    const needsReview = autoResults.filter((r) => r.status === "needs_review")
    const currentItem = needsReview[reviewIndex]

    if (!currentItem) {
      setIsSubmitting(false)
      return
    }

    try {
      // 元のファイルデータを使って登録
      const matchedFile = uploadedFiles.find((f) => f.name === currentItem.filename)
      if (!matchedFile) {
        throw new Error("元のファイルが見つかりません")
      }

      // Dropboxアップロード
      const uploadResponse = await fetch("/api/dropbox/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base64: matchedFile.base64,
          fileName: matchedFile.name,
          type: formData.type,
          date: formData.issue_date || null,
          status: "未処理",
          vendorName: formData.vendor_name,
        }),
      })

      if (!uploadResponse.ok) {
        const errorData = await uploadResponse.json() as { error: string }
        throw new Error(errorData.error || "Dropboxへのアップロードに失敗しました")
      }

      const { data: uploadData } = await uploadResponse.json() as {
        data: { path: string; file_hash: string }
      }

      // DB登録（重複チェックスキップ — ユーザーが確認済み）
      const requestBody = {
        type: formData.type,
        vendor_name: formData.vendor_name,
        amount: formData.amount ? Number(formData.amount) : null,
        issue_date: formData.issue_date || null,
        due_date: formData.due_date || null,
        description: formData.description || null,
        input_method: "upload",
        dropbox_path: uploadData.path,
        ocr_raw: currentItem.ocr_result,
        tax_category: formData.tax_category || "未判定",
        account_title: formData.account_title || "",
        file_hash: uploadData.file_hash,
        skip_duplicate_check: true,
        items: currentItem.ocr_result?.items ?? [],
      }

      const docResponse = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      })

      if (!docResponse.ok) {
        const errorData = await docResponse.json() as { error: string }
        throw new Error(errorData.error || "書類の登録に失敗しました")
      }

      toast.success(`${currentItem.filename} を登録しました`)

      // 結果を更新
      setAutoResults((prev) =>
        prev.map((r) =>
          r.filename === currentItem.filename
            ? { ...r, status: "registered" as const }
            : r
        )
      )

      // 次の要確認書類へ
      moveToNextReview()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "登録に失敗しました")
    } finally {
      setIsSubmitting(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoResults, reviewIndex, uploadedFiles])

  // 次の要確認書類へ移動、または完了
  const moveToNextReview = useCallback(() => {
    const needsReview = autoResults.filter((r) => r.status === "needs_review")
    const nextIndex = reviewIndex + 1
    if (nextIndex < needsReview.length) {
      setReviewIndex(nextIndex)
      const next = needsReview[nextIndex]
      if (next.ocr_result) {
        setOcrResult(next.ocr_result)
      }
    } else {
      // 全部レビュー完了
      setIsReviewing(false)
      setShowEditor(false)
      setOcrResult(null)
      toast.success("すべての要確認書類を処理しました")
    }
  }, [autoResults, reviewIndex])

  // スキップ（レビューせずに次へ）
  const skipReview = useCallback(() => {
    moveToNextReview()
  }, [moveToNextReview])

  // サマリー集計
  const successCount = autoResults.filter((r) => r.status === "registered").length
  const reviewCount = autoResults.filter((r) => r.status === "needs_review").length
  const errorCount = autoResults.filter((r) => r.status === "error").length

  // 全自動モードの進捗表示中かどうか
  const showAutoProgress = registrationMode === "auto" && (autoProcessing || autoCompleted)

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* モード切替 */}
      {!isRegistered && !showAutoProgress && !isReviewing && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {registrationMode === "auto" ? (
                  <div className="flex items-center gap-2 rounded-full bg-green-100 px-3 py-1.5 text-sm font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                    <Zap className="size-4" />
                    全自動
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-full bg-blue-100 px-3 py-1.5 text-sm font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                    <Eye className="size-4" />
                    確認
                  </div>
                )}
                <span className="text-sm text-muted-foreground">
                  {registrationMode === "auto"
                    ? "ドロップするだけで自動登録"
                    : "AI解析後に内容を確認して登録"}
                </span>
              </div>
              <Switch
                checked={registrationMode === "auto"}
                onCheckedChange={toggleRegistrationMode}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* 種別選択（チェックモード・登録成功後は非表示） */}
      {registrationMode === "check" && !isRegistered && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">書類種別</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="doc-type">種別を選択</Label>
              <Select value={documentType} onValueChange={setDocumentType}>
                <SelectTrigger id="doc-type" className="w-full">
                  <SelectValue placeholder="種別を選択" />
                </SelectTrigger>
                <SelectContent>
                  {documentTypes.length > 0 ? (
                    documentTypes.map((dt) => (
                      <SelectItem key={dt.name} value={dt.name}>{dt.name}</SelectItem>
                    ))
                  ) : (
                    <>
                      <SelectItem value="請求書">請求書</SelectItem>
                      <SelectItem value="領収書">領収書</SelectItem>
                      <SelectItem value="契約書">契約書</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ファイル選択（登録成功後・全自動処理中は非表示） */}
      {!isRegistered && !showAutoProgress && !isReviewing && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">書類を取り込む</CardTitle>
          </CardHeader>
          <CardContent>
            {activeTab === "upload" ? (
              <>
                {registrationMode === "auto" ? (
                  <AutoDropzone
                    files={uploadedFiles}
                    onFilesChange={setUploadedFiles}
                  />
                ) : (
                  <FileDropzone
                    files={uploadedFiles}
                    onFilesChange={setUploadedFiles}
                  />
                )}
                {registrationMode === "check" && (
                  <button
                    type="button"
                    onClick={() => setActiveTab("camera")}
                    className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Camera className="size-3.5" />
                    カメラで撮影する場合はこちら
                  </button>
                )}
              </>
            ) : (
              <>
                <CameraCapture
                  images={capturedImages}
                  onCapture={setCapturedImages}
                />
                <button
                  type="button"
                  onClick={() => setActiveTab("upload")}
                  className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Upload className="size-3.5" />
                  ファイル選択に戻る
                </button>
              </>
            )}

            {/* AI解析ボタン（チェックモードのみ） */}
            {registrationMode === "check" && hasFiles && !showEditor && (
              <div className="mt-4">
                <Button onClick={runAnalysis} className="w-full" disabled={isAnalyzing}>
                  {isAnalyzing ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      解析中...
                    </>
                  ) : (
                    <>
                      <ArrowRight className="mr-2 size-4" />
                      AI解析して次へ
                    </>
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 全自動モード: プログレス表示 */}
      {registrationMode === "auto" && autoProcessing && (
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Loader2 className="size-5 animate-spin text-green-600" />
                <span className="text-sm font-medium">
                  {autoProgress}/{autoTotal} ファイル処理中...
                </span>
              </div>
              <Progress value={(autoProgress / autoTotal) * 100} className="h-2" />
              {autoCurrentFile && (
                <p className="text-xs text-muted-foreground truncate">
                  {autoCurrentFile}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 全自動モード: 結果サマリー */}
      {registrationMode === "auto" && autoCompleted && !isReviewing && (
        <Card className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950">
          <CardContent className="pt-6">
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="size-6 text-green-600 dark:text-green-400" />
                <span className="text-lg font-semibold text-green-700 dark:text-green-300">
                  処理完了
                </span>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg bg-white/80 p-3 text-center dark:bg-white/5">
                  <CheckCircle2 className="mx-auto size-5 text-green-600" />
                  <p className="mt-1 text-lg font-bold">{successCount}件</p>
                  <p className="text-xs text-muted-foreground">成功</p>
                </div>
                <div className="rounded-lg bg-white/80 p-3 text-center dark:bg-white/5">
                  <AlertTriangle className="mx-auto size-5 text-amber-600" />
                  <p className="mt-1 text-lg font-bold">{reviewCount}件</p>
                  <p className="text-xs text-muted-foreground">要確認</p>
                </div>
                <div className="rounded-lg bg-white/80 p-3 text-center dark:bg-white/5">
                  <XCircle className="mx-auto size-5 text-red-600" />
                  <p className="mt-1 text-lg font-bold">{errorCount}件</p>
                  <p className="text-xs text-muted-foreground">エラー</p>
                </div>
              </div>

              {/* 成功した書類リスト */}
              {autoResults.filter((r) => r.status === "registered").length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-green-700 dark:text-green-400">登録済み:</p>
                  {autoResults
                    .filter((r) => r.status === "registered")
                    .map((r, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <CheckCircle2 className="size-3.5 shrink-0 text-green-600" />
                        <span className="truncate">
                          {r.document
                            ? `${(r.document as Record<string, unknown>).vendor_name} / ${(r.document as Record<string, unknown>).type} / ¥${Number((r.document as Record<string, unknown>).amount || 0).toLocaleString()}`
                            : r.filename}
                        </span>
                      </div>
                    ))}
                </div>
              )}

              {/* 要確認の書類リスト */}
              {autoResults.filter((r) => r.status === "needs_review").length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-amber-700 dark:text-amber-400">要確認:</p>
                  {autoResults
                    .filter((r) => r.status === "needs_review")
                    .map((r, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <AlertTriangle className="size-3.5 shrink-0 text-amber-600" />
                        <span className="truncate">
                          {r.filename} — {r.review_reasons?.join("、")}
                        </span>
                      </div>
                    ))}
                </div>
              )}

              {/* エラーの書類リスト */}
              {autoResults.filter((r) => r.status === "error").length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-red-700 dark:text-red-400">エラー:</p>
                  {autoResults
                    .filter((r) => r.status === "error")
                    .map((r, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <XCircle className="size-3.5 shrink-0 text-red-600" />
                        <span className="truncate">
                          {r.filename} — {r.error}
                        </span>
                      </div>
                    ))}
                </div>
              )}

              <div className="flex flex-col gap-3 sm:flex-row">
                {reviewCount > 0 && (
                  <Button onClick={startReview} className="flex-1">
                    <AlertTriangle className="mr-2 size-4" />
                    要確認書類を確認
                  </Button>
                )}
                <Button
                  variant={reviewCount > 0 ? "outline" : "default"}
                  onClick={resetForNextDocument}
                  className="flex-1"
                >
                  <Plus className="mr-2 size-4" />
                  次の書類を登録
                </Button>
                <Button
                  variant="outline"
                  onClick={() => router.push("/documents")}
                  className="flex-1"
                >
                  <ListIcon className="mr-2 size-4" />
                  書類一覧へ
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 要確認書類のレビューヘッダー */}
      {isReviewing && (
        <Card className="border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-5 text-amber-600" />
                <span className="text-sm font-medium">
                  要確認書類 ({reviewIndex + 1}/{autoResults.filter((r) => r.status === "needs_review").length})
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={skipReview}
                >
                  スキップ
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setIsReviewing(false)
                    setShowEditor(false)
                    setOcrResult(null)
                  }}
                >
                  レビュー終了
                </Button>
              </div>
            </div>
            {(() => {
              const needsReview = autoResults.filter((r) => r.status === "needs_review")
              const current = needsReview[reviewIndex]
              return current ? (
                <div className="mt-2 space-y-1">
                  <p className="text-sm">{current.filename}</p>
                  <div className="flex flex-wrap gap-1">
                    {current.review_reasons?.map((reason, i) => (
                      <span
                        key={i}
                        className="rounded-full bg-amber-200 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-800 dark:text-amber-200"
                      >
                        {reason}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null
            })()}
          </CardContent>
        </Card>
      )}

      {/* チェックモード: 登録成功画面 */}
      {registrationMode === "check" && isRegistered && (
        <Card className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center gap-4 py-4">
              <CheckCircle2 className="size-12 text-green-600 dark:text-green-400" />
              <p className="text-lg font-semibold text-green-700 dark:text-green-300">
                書類を登録しました
              </p>
              <div className="flex w-full flex-col gap-3 sm:flex-row">
                <Button
                  onClick={resetForNextDocument}
                  className="flex-1"
                >
                  <Plus className="mr-2 size-4" />
                  次の書類を登録
                </Button>
                <Button
                  variant="outline"
                  onClick={() => router.push("/documents")}
                  className="flex-1"
                >
                  <ListIcon className="mr-2 size-4" />
                  書類一覧へ
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* OCR結果編集フォーム（チェックモードまたはレビュー中） */}
      {showEditor && !isRegistered && (
        <OcrResultEditor
          ocrResult={ocrResult}
          defaultType={documentType}
          isAnalyzing={isAnalyzing}
          isSubmitting={isSubmitting}
          onSubmit={isReviewing ? handleReviewSubmit : handleSubmit}
          modelUsed={modelUsed}
          documentTypes={documentTypes.length > 0 ? documentTypes : undefined}
        />
      )}

      {/* 重複警告ダイアログ */}
      <Dialog open={showDuplicateDialog} onOpenChange={setShowDuplicateDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className={`flex items-center gap-2 ${
              duplicateLevel === "exact" ? "text-red-600" : "text-amber-600"
            }`}>
              <AlertTriangle className="size-5" />
              {duplicateLevel === "exact"
                ? "同じファイルが既に登録されています"
                : "似た書類が既に登録されています"}
            </DialogTitle>
            <DialogDescription>
              {duplicateLevel === "exact"
                ? "ファイルハッシュが一致する書類が見つかりました。同一ファイルの可能性が高いです。"
                : "取引先・金額・日付が一致する書類が見つかりました。"}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-60 space-y-2 overflow-y-auto">
            {duplicates.map((dup) => (
              <div
                key={dup.id}
                className={`rounded-md border p-3 text-sm ${
                  duplicateLevel === "exact"
                    ? "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30"
                    : "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"
                }`}
              >
                <div className="font-medium">{dup.vendor_name}</div>
                <div className="mt-1 text-muted-foreground">
                  {dup.type}
                  {dup.amount != null && ` ・ ¥${dup.amount.toLocaleString()}`}
                  {dup.issue_date && ` ・ ${dup.issue_date}`}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  登録日時: {new Date(dup.created_at).toLocaleString("ja-JP")}
                </div>
                {duplicateLevel === "exact" && (
                  <div className="mt-1 text-xs font-semibold text-red-600 dark:text-red-400">
                    同一ファイルです
                  </div>
                )}
              </div>
            ))}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                setShowDuplicateDialog(false)
                setPendingFormData(null)
                setPendingDropboxPath(null)
                setPendingFileHash(null)
                setDuplicates([])
                setDuplicateLevel(null)
              }}
            >
              キャンセル
            </Button>
            <Button
              variant="destructive"
              onClick={handleForceSubmit}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              それでも登録する
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 全自動モード用ドロップゾーン（テキスト変更版） */
function AutoDropzone({
  files,
  onFilesChange,
}: {
  files: UploadedFile[]
  onFilesChange: (files: UploadedFile[]) => void
}) {
  return (
    <div>
      <FileDropzone files={files} onFilesChange={onFilesChange} />
      {files.length === 0 && (
        <div className="mt-2 text-center">
          <p className="text-xs text-green-600 dark:text-green-400">
            ファイルをドロップすると自動で解析・登録されます
          </p>
          <p className="text-xs text-muted-foreground">
            複数ファイルをまとめてドロップできます
          </p>
        </div>
      )}
    </div>
  )
}
