"use client"

import { useState, useEffect, useCallback, useRef } from "react"
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
import { Upload, X, Loader2, CheckCircle2, ImageIcon, FileText, Receipt } from "lucide-react"
import { toast } from "sonner"

/** スタッフ */
interface StaffMember {
  id: string
  name: string
}

/** アップロード用ファイル */
interface UploadedFile {
  base64: string
  mimeType: string
  name: string
  size: number
  preview: string | null
}

/** AI解析結果 */
interface OcrInfo {
  vendor_name: string
  amount: number | null
  issue_date: string | null
  type: string
  tax_category: string | null
  account_title: string | null
  confidence: number
  model_used: string
}

/** アップロード結果（各ファイル） */
interface UploadResult {
  fileName: string
  status: "success" | "error"
  ocr?: OcrInfo
  error?: string
}

const ACCEPTED_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/webp",
  "application/pdf",
]

const ACCEPT_EXTENSIONS = ".jpg,.jpeg,.png,.heic,.webp,.pdf"
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

/** 拡張子からMIMEタイプを補正 */
function normalizeMimeType(file: File): string {
  if (ACCEPTED_TYPES.includes(file.type)) return file.type
  const ext = file.name.split(".").pop()?.toLowerCase()
  switch (ext) {
    case "heic": return "image/heic"
    case "webp": return "image/webp"
    default: return file.type
  }
}

/** ファイルサイズ表示 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// スタッフ領収書ページ
export default function StaffReceiptsPage() {
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>([])
  const [selectedStaffId, setSelectedStaffId] = useState<string>("")
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [results, setResults] = useState<UploadResult[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // スタッフ一覧取得
  useEffect(() => {
    async function fetchStaff() {
      try {
        const res = await fetch("/api/staff-members")
        if (!res.ok) throw new Error("取得失敗")
        const json = await res.json() as { data: StaffMember[] }
        setStaffMembers(json.data || [])
      } catch {
        toast.error("スタッフ一覧の取得に失敗しました")
      }
    }
    fetchStaff()
  }, [])

  // ファイルをBase64に変換
  const processFile = useCallback(
    (file: File): Promise<UploadedFile> => {
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
          const preview = file.type.startsWith("image/") ? result : null
          resolve({ base64, mimeType, name: file.name, size: file.size, preview })
        }
        reader.onerror = () => reject(new Error(`読み込みに失敗しました: ${file.name}`))
        reader.readAsDataURL(file)
      })
    },
    []
  )

  // ファイル追加
  const handleFiles = useCallback(
    async (fileList: FileList) => {
      const newFiles: UploadedFile[] = []
      for (let i = 0; i < fileList.length; i++) {
        try {
          const processed = await processFile(fileList[i])
          newFiles.push(processed)
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "ファイルの処理に失敗しました")
        }
      }
      if (newFiles.length > 0) {
        setFiles((prev) => [...prev, ...newFiles])
        setResults([]) // 結果をリセット
      }
    },
    [processFile]
  )

  // ドロップ
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files)
      }
    },
    [handleFiles]
  )

  // ファイル選択
  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFiles(e.target.files)
      }
      e.target.value = ""
    },
    [handleFiles]
  )

  // ファイル削除
  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }, [])

  // アップロード実行
  const handleUpload = async () => {
    if (!selectedStaffId) {
      toast.error("スタッフを選択してください")
      return
    }
    if (files.length === 0) {
      toast.error("ファイルを選択してください")
      return
    }

    const staff = staffMembers.find((s) => s.id === selectedStaffId)
    if (!staff) return

    setIsUploading(true)
    setResults([])
    const uploadResults: UploadResult[] = []

    for (const file of files) {
      try {
        const res = await fetch("/api/staff-receipts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base64: file.base64,
            mimeType: file.mimeType,
            fileName: file.name,
            staffMemberId: selectedStaffId,
            staffName: staff.name,
          }),
        })

        if (!res.ok) {
          const json = await res.json().catch(() => ({})) as { error?: string }
          throw new Error(json.error || "アップロードに失敗しました")
        }

        const json = await res.json() as { ocr: OcrInfo }
        uploadResults.push({
          fileName: file.name,
          status: "success",
          ocr: json.ocr,
        })
      } catch (error) {
        uploadResults.push({
          fileName: file.name,
          status: "error",
          error: error instanceof Error ? error.message : "エラーが発生しました",
        })
      }
    }

    setResults(uploadResults)
    setIsUploading(false)

    const successCount = uploadResults.filter((r) => r.status === "success").length
    const errorCount = uploadResults.filter((r) => r.status === "error").length

    if (successCount > 0) toast.success(`${successCount}件の領収書を登録しました`)
    if (errorCount > 0) toast.error(`${errorCount}件のエラーが発生しました`)

    // 成功したらファイルをクリア
    if (errorCount === 0) {
      setFiles([])
    }
  }

  const selectedStaffName = staffMembers.find((s) => s.id === selectedStaffId)?.name || ""

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">スタッフ領収書</h1>

      {/* スタッフ選択 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">スタッフ選択</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label htmlFor="staff-select">担当スタッフ</Label>
            <Select value={selectedStaffId} onValueChange={setSelectedStaffId}>
              <SelectTrigger id="staff-select" className="w-full sm:w-64">
                <SelectValue placeholder="スタッフを選択" />
              </SelectTrigger>
              <SelectContent>
                {staffMembers.map((staff) => (
                  <SelectItem key={staff.id} value={staff.id}>
                    {staff.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* ファイルアップロード */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">領収書アップロード</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* ドロップゾーン */}
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setIsDragOver(true)
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            className={`flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
              isDragOver
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/25 hover:border-primary/50"
            }`}
          >
            <Upload className="size-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">
                領収書をドラッグ&ドロップ
              </p>
              <p className="text-xs text-muted-foreground">
                または クリックして選択（複数可・最大10MB）
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                JPG, PNG, HEIC, WebP, PDF
              </p>
            </div>
          </div>

          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT_EXTENSIONS}
            multiple
            onChange={handleFileInput}
            className="hidden"
          />

          {/* 選択済みファイル一覧 */}
          {files.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                選択済み: {files.length}ファイル
              </p>
              <div className="space-y-2">
                {files.map((file, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-3 rounded-md border p-2"
                  >
                    {file.preview ? (
                      <img
                        src={file.preview}
                        alt={file.name}
                        className="size-12 rounded object-cover"
                      />
                    ) : (
                      <div className="flex size-12 items-center justify-center rounded bg-muted">
                        {file.mimeType === "application/pdf" ? (
                          <FileText className="size-6 text-red-600" />
                        ) : (
                          <ImageIcon className="size-6 text-muted-foreground" />
                        )}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm">{file.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatFileSize(file.size)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeFile(idx)
                      }}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFiles([])}
                className="text-muted-foreground"
              >
                すべて削除
              </Button>
            </div>
          )}

          {/* アップロードボタン */}
          {files.length > 0 && (
            <Button
              onClick={handleUpload}
              disabled={isUploading || !selectedStaffId}
              className="w-full btn-float-primary"
            >
              {isUploading ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  AI解析・アップロード中...
                </>
              ) : (
                <>
                  <Receipt className="mr-2 size-4" />
                  {selectedStaffName
                    ? `${selectedStaffName}の領収書を登録（${files.length}件）`
                    : `領収書を登録（${files.length}件）`}
                </>
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* AI解析結果 */}
      {results.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">登録結果</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {results.map((result, idx) => (
                <div
                  key={idx}
                  className={`rounded-lg border p-4 ${
                    result.status === "success"
                      ? "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950"
                      : "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    {result.status === "success" ? (
                      <CheckCircle2 className="size-4 text-[#A0703A]" />
                    ) : (
                      <X className="size-4 text-red-600" />
                    )}
                    <span className="text-sm font-medium">{result.fileName}</span>
                  </div>

                  {result.status === "success" && result.ocr && (
                    <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                      <div>
                        <span className="text-muted-foreground">店名: </span>
                        <span className="font-medium">{result.ocr.vendor_name || "—"}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">金額: </span>
                        <span className="font-medium">
                          {result.ocr.amount != null
                            ? `¥${result.ocr.amount.toLocaleString()}`
                            : "—"}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">日付: </span>
                        <span className="font-medium">{result.ocr.issue_date || "—"}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">種別: </span>
                        <span className="font-medium">{result.ocr.type || "—"}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">税区分: </span>
                        <span className="font-medium">{result.ocr.tax_category || "—"}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">科目: </span>
                        <span className="font-medium">{result.ocr.account_title || "—"}</span>
                      </div>
                    </div>
                  )}

                  {result.status === "error" && (
                    <p className="text-sm text-red-600">{result.error}</p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
