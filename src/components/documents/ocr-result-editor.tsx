"use client"

import { useForm } from "react-hook-form"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2, Save, Sparkles } from "lucide-react"
import type { OcrResult } from "@/lib/gemini"

export interface DocumentFormData {
  type: string
  vendor_name: string
  amount: string
  issue_date: string
  due_date: string
  description: string
}

interface OcrResultEditorProps {
  ocrResult: OcrResult | null
  defaultType: string
  isAnalyzing: boolean
  isSubmitting: boolean
  onSubmit: (data: DocumentFormData) => void
  /** 使用されたGeminiモデル名 */
  modelUsed?: string
  /** 動的な書類種別リスト */
  documentTypes?: { name: string }[]
}

// OCR結果編集コンポーネント
export function OcrResultEditor({
  ocrResult,
  defaultType,
  isAnalyzing,
  isSubmitting,
  onSubmit,
  modelUsed,
  documentTypes,
}: OcrResultEditorProps) {
  const { register, handleSubmit, setValue, watch, formState: { errors } } = useForm<DocumentFormData>({
    defaultValues: {
      type: ocrResult?.type ?? defaultType,
      vendor_name: ocrResult?.vendor_name ?? "",
      amount: ocrResult?.amount != null ? String(ocrResult.amount) : "",
      issue_date: ocrResult?.issue_date ?? "",
      due_date: ocrResult?.due_date ?? "",
      description: ocrResult?.description ?? "",
    },
    values: ocrResult
      ? {
          type: ocrResult.type ?? defaultType,
          vendor_name: ocrResult.vendor_name,
          amount: ocrResult.amount != null ? String(ocrResult.amount) : "",
          issue_date: ocrResult.issue_date ?? "",
          due_date: ocrResult.due_date ?? "",
          description: ocrResult.description ?? "",
        }
      : undefined,
  })

  const currentType = watch("type")

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4" />
          {isAnalyzing ? "AI解析中..." : "解析結果を確認"}
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {modelUsed && (
            <Badge variant="secondary" className="text-xs font-normal">
              使用モデル: {modelUsed}
            </Badge>
          )}
          {ocrResult && ocrResult.confidence > 0 && (
            <p className="text-xs text-muted-foreground">
              AI確信度: {Math.round(ocrResult.confidence * 100)}%
            </p>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isAnalyzing ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="size-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">
              書類を解析しています...
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {/* 書類種別 */}
            <div className="space-y-2">
              <Label htmlFor="type">書類種別</Label>
              <Select
                value={currentType}
                onValueChange={(value) => setValue("type", value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="種別を選択" />
                </SelectTrigger>
                <SelectContent>
                  {documentTypes && documentTypes.length > 0 ? (
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

            {/* 取引先名 */}
            <div className="space-y-2">
              <Label htmlFor="vendor_name">取引先名</Label>
              <Input
                id="vendor_name"
                placeholder="取引先名を入力"
                {...register("vendor_name", { required: "取引先名は必須です" })}
              />
              {errors.vendor_name && (
                <p className="text-xs text-destructive">{errors.vendor_name.message}</p>
              )}
            </div>

            {/* 金額 */}
            <div className="space-y-2">
              <Label htmlFor="amount">金額</Label>
              <Input
                id="amount"
                type="number"
                placeholder="0"
                {...register("amount")}
              />
            </div>

            {/* 日付（横並び） */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="issue_date">発行日</Label>
                <Input
                  id="issue_date"
                  type="date"
                  {...register("issue_date")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="due_date">支払期日</Label>
                <Input
                  id="due_date"
                  type="date"
                  {...register("due_date")}
                />
              </div>
            </div>

            {/* 摘要 */}
            <div className="space-y-2">
              <Label htmlFor="description">摘要</Label>
              <Textarea
                id="description"
                placeholder="摘要を入力"
                {...register("description")}
              />
            </div>

            {/* 登録ボタン */}
            <Button
              type="submit"
              className="w-full"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  登録中...
                </>
              ) : (
                <>
                  <Save className="mr-2 size-4" />
                  書類を登録
                </>
              )}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
