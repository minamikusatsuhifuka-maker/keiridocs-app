"use client"

import { useState, useCallback, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
import { Camera, Upload, ArrowRight, Loader2 } from "lucide-react"
import { toast } from "sonner"

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

// 書類登録ページ
export default function NewDocumentPage() {
  const router = useRouter()
  const [documentType, setDocumentType] = useState("請求書")
  const [activeTab, setActiveTab] = useState("camera")

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

  // 動的書類種別
  const [documentTypes, setDocumentTypes] = useState<DocumentTypeRecord[]>([])

  // 書類種別リストを取得
  useEffect(() => {
    async function fetchTypes() {
      try {
        const res = await fetch("/api/settings?table=document_types")
        if (!res.ok) return
        const json = await res.json() as { data: DocumentTypeRecord[] }
        if (json.data && json.data.length > 0) {
          setDocumentTypes(json.data)
          setDocumentType(json.data[0].name)
        }
      } catch {
        // フォールバック: デフォルト種別を使う
      }
    }
    fetchTypes()
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
      // 解析に使うデータを取得（最初のファイル/画像）
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

      const response = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base64, mimeType }),
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
      // エラー時もフォームを表示（手動入力可能）
      setOcrResult(null)
    } finally {
      setIsAnalyzing(false)
    }
  }, [activeTab, capturedImages, uploadedFiles])

  // 書類を登録する
  const handleSubmit = useCallback(
    async (formData: DocumentFormData) => {
      setIsSubmitting(true)

      try {
        // 1. ファイルデータを準備
        let fileBase64: string
        let fileName: string
        let fileMimeType: string

        if (activeTab === "camera" && capturedImages.length > 0) {
          // 複数画像の場合はPDF結合APIを使う
          if (capturedImages.length > 1) {
            const pdfResponse = await fetch("/api/documents", {
              method: "OPTIONS",
            })
            // PDF結合はクライアントサイドで実施
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
            // 複数画像の場合はPDF結合
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
              // 単一ファイルとして扱う（最初のファイル）
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
          const ext = fileMimeType === "application/pdf" ? ".pdf" : ".jpg"
          fileName += ext
        }

        // 2. Dropboxにアップロード
        const uploadResponse = await fetch("/api/dropbox/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base64: fileBase64,
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

        // 3. DB に書類レコードを保存
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
            input_method: activeTab === "camera" ? "camera" : "upload",
            dropbox_path: uploadData.path,
            ocr_raw: ocrResult,
          }),
        })

        if (!docResponse.ok) {
          const errorData = await docResponse.json() as { error: string }
          throw new Error(errorData.error || "書類の登録に失敗しました")
        }

        toast.success("書類を登録しました")
        router.push("/documents")
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "登録に失敗しました"
        )
      } finally {
        setIsSubmitting(false)
      }
    },
    [activeTab, capturedImages, uploadedFiles, ocrResult, router]
  )

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* 種別選択 */}
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

      {/* ファイル選択（タブ切替） */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">書類を取り込む</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="w-full">
              <TabsTrigger value="camera" className="flex-1">
                <Camera className="mr-2 size-4" />
                カメラ撮影
              </TabsTrigger>
              <TabsTrigger value="upload" className="flex-1">
                <Upload className="mr-2 size-4" />
                ファイル選択
              </TabsTrigger>
            </TabsList>
            <TabsContent value="camera" className="mt-4">
              <CameraCapture
                images={capturedImages}
                onCapture={setCapturedImages}
              />
            </TabsContent>
            <TabsContent value="upload" className="mt-4">
              <FileDropzone
                files={uploadedFiles}
                onFilesChange={setUploadedFiles}
              />
            </TabsContent>
          </Tabs>

          {/* AI解析ボタン */}
          {hasFiles && !showEditor && (
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

      {/* OCR結果編集フォーム */}
      {showEditor && (
        <OcrResultEditor
          ocrResult={ocrResult}
          defaultType={documentType}
          isAnalyzing={isAnalyzing}
          isSubmitting={isSubmitting}
          onSubmit={handleSubmit}
          modelUsed={modelUsed}
          documentTypes={documentTypes.length > 0 ? documentTypes : undefined}
        />
      )}
    </div>
  )
}
