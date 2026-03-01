"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Briefcase, Loader2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

// デフォルトの対象書類種別
const DEFAULT_DOC_TYPES = [
  "請求書",
  "領収書",
  "売り上げ記録",
  "自動精算機の売上表",
  "社会保険料",
  "医薬品仕入",
]

interface DocumentType {
  id: string
  name: string
}

// 税理士提出設定
export function AccountantSettings() {
  const [allDocTypes, setAllDocTypes] = useState<DocumentType[]>([])
  const [selectedTypes, setSelectedTypes] = useState<string[]>(DEFAULT_DOC_TYPES)
  const [autoEnabled, setAutoEnabled] = useState(false)
  const [customType, setCustomType] = useState("")
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  // document_typesテーブルから全種別を取得
  const fetchDocumentTypes = useCallback(async () => {
    try {
      const res = await fetch("/api/settings?table=document_types")
      const json = await res.json() as { data?: DocumentType[]; error?: string }
      if (json.data) {
        setAllDocTypes(json.data)
      }
    } catch {
      // デフォルト値を使用
    }
  }, [])

  // settingsからaccountant設定を取得
  const fetchSettings = useCallback(async () => {
    try {
      // 対象種別の取得
      const typesRes = await fetch("/api/settings?table=settings&key=accountant_doc_types")
      const typesJson = await typesRes.json() as { data?: { value: unknown }; error?: string }
      if (typesJson.data?.value && Array.isArray(typesJson.data.value)) {
        setSelectedTypes(typesJson.data.value as string[])
      }

      // 自動実行設定の取得
      const autoRes = await fetch("/api/settings?table=settings&key=accountant_auto_enabled")
      const autoJson = await autoRes.json() as { data?: { value: unknown }; error?: string }
      if (autoJson.data?.value === true) {
        setAutoEnabled(true)
      }
    } catch {
      // デフォルト値を使用
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchDocumentTypes()
    fetchSettings()
  }, [fetchDocumentTypes, fetchSettings])

  // 種別の選択/解除
  function toggleType(typeName: string) {
    setSelectedTypes((prev) =>
      prev.includes(typeName)
        ? prev.filter((t) => t !== typeName)
        : [...prev, typeName]
    )
  }

  // カスタム種別を追加
  function addCustomType() {
    const name = customType.trim()
    if (!name) return
    if (selectedTypes.includes(name)) {
      toast.error("既に追加されています")
      return
    }
    setSelectedTypes((prev) => [...prev, name])
    setCustomType("")
  }

  // カスタムで追加した種別を削除（document_typesにもDEFAULTにもない種別）
  function removeCustomType(name: string) {
    setSelectedTypes((prev) => prev.filter((t) => t !== name))
  }

  // 保存
  async function handleSave() {
    setIsSaving(true)
    try {
      // 対象種別を保存
      const typesRes = await fetch("/api/settings?table=settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "accountant_doc_types",
          value: selectedTypes,
        }),
      })
      const typesJson = await typesRes.json() as { error?: string }
      if (typesJson.error) throw new Error(typesJson.error)

      // 自動実行設定を保存
      const autoRes = await fetch("/api/settings?table=settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "accountant_auto_enabled",
          value: autoEnabled,
        }),
      })
      const autoJson = await autoRes.json() as { error?: string }
      if (autoJson.error) throw new Error(autoJson.error)

      toast.success("税理士提出設定を保存しました")
    } catch {
      toast.error("設定の保存に失敗しました")
    } finally {
      setIsSaving(false)
    }
  }

  // document_typesとDEFAULT_DOC_TYPESを統合した種別リスト
  const allTypeNames = Array.from(
    new Set([
      ...DEFAULT_DOC_TYPES,
      ...allDocTypes.map((dt) => dt.name),
    ])
  )

  // selectedTypesに含まれるがallTypeNamesにない種別（カスタム追加分）
  const customAddedTypes = selectedTypes.filter(
    (t) => !allTypeNames.includes(t)
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 対象書類種別 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Briefcase className="size-5" />
            対象書類種別
          </CardTitle>
          <CardDescription>
            税理士提出フォルダに含める書類の種別を選択します
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 既存の種別チェックボックス */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {allTypeNames.map((name) => (
              <div key={name} className="flex items-center gap-2">
                <Checkbox
                  id={`accountant-type-${name}`}
                  checked={selectedTypes.includes(name)}
                  onCheckedChange={() => toggleType(name)}
                />
                <Label
                  htmlFor={`accountant-type-${name}`}
                  className="cursor-pointer text-sm"
                >
                  {name}
                </Label>
              </div>
            ))}
          </div>

          {/* カスタム追加した種別 */}
          {customAddedTypes.length > 0 && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">追加した種別</Label>
              <div className="flex flex-wrap gap-2">
                {customAddedTypes.map((name) => (
                  <div
                    key={name}
                    className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm"
                  >
                    {name}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-5 text-destructive hover:text-destructive"
                      onClick={() => removeCustomType(name)}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* その他の種別を追加 */}
          <div className="flex gap-2">
            <Input
              placeholder="その他の種別を入力"
              value={customType}
              onChange={(e) => setCustomType(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  addCustomType()
                }
              }}
              className="max-w-xs"
            />
            <Button
              variant="outline"
              onClick={addCustomType}
              disabled={!customType.trim()}
            >
              <Plus className="size-4" />
              追加
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 自動実行設定 */}
      <Card>
        <CardHeader>
          <CardTitle>自動実行</CardTitle>
          <CardDescription>
            毎月1日に前月分の税理士提出フォルダを自動で作成します
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch
              id="accountant-auto"
              checked={autoEnabled}
              onCheckedChange={setAutoEnabled}
            />
            <Label htmlFor="accountant-auto">
              毎月1日に自動実行する
            </Label>
          </div>
        </CardContent>
      </Card>

      {/* 保存ボタン */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving && <Loader2 className="size-4 animate-spin" />}
          設定を保存
        </Button>
      </div>
    </div>
  )
}
