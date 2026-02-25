"use client"

import { useRef, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Upload, X, FileText, ImageIcon } from "lucide-react"

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
  "application/pdf",
]

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

/** ファイルサイズを読みやすい形式に変換 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
        if (!ACCEPTED_TYPES.includes(file.type)) {
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
            mimeType: file.type,
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
            または クリックして選択（JPG, PNG, PDF / 最大10MB）
          </p>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.pdf"
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
                    {file.mimeType === "application/pdf" ? (
                      <FileText className="size-6 text-muted-foreground" />
                    ) : (
                      <ImageIcon className="size-6 text-muted-foreground" />
                    )}
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
