"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Loader2, Save } from "lucide-react"
import { toast } from "sonner"
import { GEMINI_MODELS, DEFAULT_GEMINI_MODEL } from "@/lib/gemini"

/** 自動解析モードの選択肢 */
type AnalyzeMode = "manual" | "auto"

// AI設定コンポーネント
export function AiSettings() {
  const [currentModel, setCurrentModel] = useState(DEFAULT_GEMINI_MODEL)
  const [analyzeMode, setAnalyzeMode] = useState<AnalyzeMode>("manual")
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  // 現在の設定を取得
  const fetchSetting = useCallback(async () => {
    try {
      const [modelRes, modeRes] = await Promise.all([
        fetch("/api/settings?table=settings&key=gemini_model"),
        fetch("/api/settings?table=settings&key=auto_analyze_mode"),
      ])

      if (modelRes.ok) {
        const json = await modelRes.json() as { data: { value: unknown } | null }
        if (json.data && typeof json.data.value === "string") {
          setCurrentModel(json.data.value)
        }
      }

      if (modeRes.ok) {
        const json = await modeRes.json() as { data: { value: unknown } | null }
        if (json.data && (json.data.value === "auto" || json.data.value === "manual")) {
          setAnalyzeMode(json.data.value as AnalyzeMode)
        }
      }
    } catch {
      // 未設定の場合はデフォルトのまま
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSetting()
  }, [fetchSetting])

  // 保存
  const handleSave = async () => {
    setIsSaving(true)
    try {
      const [modelRes, modeRes] = await Promise.all([
        fetch("/api/settings?table=settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: "gemini_model", value: currentModel }),
        }),
        fetch("/api/settings?table=settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: "auto_analyze_mode", value: analyzeMode }),
        }),
      ])
      if (!modelRes.ok || !modeRes.ok) throw new Error()
      toast.success("AI設定を保存しました")
    } catch {
      toast.error("設定の保存に失敗しました")
    } finally {
      setIsSaving(false)
    }
  }

  const selectedModelInfo = GEMINI_MODELS.find((m) => m.id === currentModel)

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI設定</CardTitle>
        <CardDescription>
          書類OCRに使用するGeminiモデルを選択します
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 現在のモデル */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">現在のモデル:</span>
          <Badge variant="secondary">
            {selectedModelInfo?.label ?? currentModel}
          </Badge>
        </div>

        {/* モデル選択 */}
        <div className="space-y-2">
          <Label htmlFor="gemini-model">モデルを選択</Label>
          <Select value={currentModel} onValueChange={setCurrentModel}>
            <SelectTrigger id="gemini-model" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GEMINI_MODELS.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  <div className="flex flex-col">
                    <span>{m.label}</span>
                    <span className="text-xs text-muted-foreground">{m.description}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* アップロード時の動作 */}
        <div className="space-y-2">
          <Label htmlFor="analyze-mode">アップロード時の動作</Label>
          <Select value={analyzeMode} onValueChange={(v) => setAnalyzeMode(v as AnalyzeMode)}>
            <SelectTrigger id="analyze-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">
                <div className="flex flex-col">
                  <span>手動解析</span>
                  <span className="text-xs text-muted-foreground">「AI解析して次へ」ボタンで解析開始</span>
                </div>
              </SelectItem>
              <SelectItem value="auto">
                <div className="flex flex-col">
                  <span>自動解析</span>
                  <span className="text-xs text-muted-foreground">ファイルアップロード後に自動でAI解析を開始</span>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* 保存ボタン */}
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <Save className="mr-2 size-4" />
          )}
          保存
        </Button>
      </CardContent>
    </Card>
  )
}
