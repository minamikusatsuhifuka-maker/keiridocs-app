"use client"

import { useRef, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Upload, X, FileText, ImageIcon, FileSpreadsheet, Table2 } from "lucide-react"

interface UploadedFile {
  base64: string
  mimeType: string
  name: string
  size: number
  preview: string | null
}

interface FileDropzoneProps {
  onFilesChange: (files: UploadedFile[]) => void
  files: UploadedFile[]
}

const ACCEPTED_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/webp",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
  "text/csv", // .csv
]

// accept属性に指定する拡張子リスト
const ACCEPT_EXTENSIONS = ".jpg,.jpeg,.png,.heic,.webp,.pdf,.docx,.xlsx,.xls,.csv"

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

/** 拡張子からMIMEタイプを補正する（ブラウザがMIMEを正しく判定しない場合用） */
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

/** ファイルサイズを読みやすい形式に変換 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** MIMEタイプに応じたアイコンを返す */
function FileIcon({ mimeType, name }: { mimeType: string; name: string }) {
  const ext = name.split(".").pop()?.toLowerCase()

  // Word
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    return <FileText className="size-6 text-blue-600" />
  }

  // Excel
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.ms-excel" ||
    ext === "xlsx" || ext === "xls"
  ) {
    return <FileSpreadsheet className="size-6 text-green-600" />
  }

  // CSV
  if (mimeType === "text/csv" || ext === "csv") {
    return <Table2 className="size-6 text-orange-600" />
  }

  // PDF
  if (mimeType === "application/pdf") {
    return <FileText className="size-6 text-red-600" />
  }

  // その他（画像など）
  return <ImageIcon className="size-6 text-muted-foreground" />
}

// ファイルドロップゾーン
export function FileDropzone({ onFilesChange, files }: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

          // 画像の場合はプレビューを生成
          const preview = file.type.startsWith("image/") ? result : null

          resolve({
            base64,
            mimeType,
            name: file.name,
            size: file.size,
            preview,
          })
        }
        reader.onerror = () => reject(new Error(`読み込みに失敗しました: ${file.name}`))
        reader.readAsDataURL(file)
      })
    },
    []
  )

  // ファイルを処理して追加
  const handleFiles = useCallback(
    async (fileList: FileList) => {
      setError(null)
      const newFiles: UploadedFile[] = []

      for (let i = 0; i < fileList.length; i++) {
        try {
          const processed = await processFile(fileList[i])
          newFiles.push(processed)
        } catch (err) {
          setError(err instanceof Error ? err.message : "ファイルの処理に失敗しました")
        }
      }

      if (newFiles.length > 0) {
        onFilesChange([...files, ...newFiles])
      }
    },
    [files, onFilesChange, processFile]
  )

  // ドロップイベント
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

  // ファイル選択イベント
  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFiles(e.target.files)
      }
      // inputをリセットして同じファイルを再選択可能にする
      e.target.value = ""
    },
    [handleFiles]
  )

  // ファイルを削除
  const removeFile = useCallback(
    (index: number) => {
      const newFiles = files.filter((_, i) => i !== index)
      onFilesChange(newFiles)
    },
    [files, onFilesChange]
  )

  return (
    <div className="space-y-4">
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
            ファイルをドラッグ&ドロップ
          </p>
          <p className="text-xs text-muted-foreground">
            または クリックして選択（最大10MB）
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            JPG, PNG, HEIC, WebP, PDF, Word, Excel, CSV
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

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {/* アップロード済みファイル一覧 */}
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
                {/* プレビュー/アイコン */}
                {file.preview ? (
                  <img
                    src={file.preview}
                    alt={file.name}
                    className="size-12 rounded object-cover"
                  />
                ) : (
                  <div className="flex size-12 items-center justify-center rounded bg-muted">
                    <FileIcon mimeType={file.mimeType} name={file.name} />
                  </div>
                )}
                {/* ファイル情報 */}
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatFileSize(file.size)}
                  </p>
                </div>
                {/* 削除ボタン */}
                <Button
                  variant="ghost"
                  size="icon-xs"
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
            onClick={() => onFilesChange([])}
            className="text-muted-foreground"
          >
            すべて削除
          </Button>
        </div>
      )}
    </div>
  )
}
