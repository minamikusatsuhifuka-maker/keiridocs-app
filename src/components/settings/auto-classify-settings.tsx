"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Plus, Trash2, Loader2, Wand2, Pencil, Check, X } from "lucide-react"
import { toast } from "sonner"
import type { Database } from "@/types/database"

type AutoClassifyRule = Database["public"]["Tables"]["auto_classify_rules"]["Row"]

// 医療法人向けクイック追加プリセット
const PRESET_RULES = [
  { keyword: "薬品", document_type: "医薬品仕入" },
  { keyword: "リース", document_type: "医療機器" },
  { keyword: "社保", document_type: "社会保険料" },
  { keyword: "給与", document_type: "給与明細" },
  { keyword: "保険", document_type: "保険請求" },
  { keyword: "税", document_type: "税務関連" },
]

// 自動仕分けルール設定
export function AutoClassifySettings() {
  const [rules, setRules] = useState<AutoClassifyRule[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isAdding, setIsAdding] = useState(false)
  const [keyword, setKeyword] = useState("")
  const [documentType, setDocumentType] = useState("")
  const [documentTypes, setDocumentTypes] = useState<{ name: string }[]>([])

  // 編集中の行
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editKeyword, setEditKeyword] = useState("")
  const [editDocumentType, setEditDocumentType] = useState("")

  // ルール一覧を取得
  const fetchRules = useCallback(async () => {
    try {
      const res = await fetch("/api/settings?table=auto_classify_rules")
      const json = await res.json() as { data?: AutoClassifyRule[]; error?: string }
      if (json.error) throw new Error(json.error)
      setRules(json.data ?? [])
    } catch {
      toast.error("自動仕分けルールの取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }, [])

  // 書類種別リストを取得
  const fetchDocumentTypes = useCallback(async () => {
    try {
      const res = await fetch("/api/settings?table=document_types")
      if (!res.ok) return
      const json = await res.json() as { data: { name: string }[] }
      if (json.data && json.data.length > 0) {
        setDocumentTypes(json.data)
      }
    } catch {
      // フォールバック: デフォルトを使う
    }
  }, [])

  useEffect(() => {
    fetchRules()
    fetchDocumentTypes()
  }, [fetchRules, fetchDocumentTypes])

  // 種別の選択肢（動的 + プリセットの種別をマージ）
  const allTypeOptions = (() => {
    const names = new Set(documentTypes.map((t) => t.name))
    // プリセットの種別も選択肢に含める
    for (const preset of PRESET_RULES) {
      names.add(preset.document_type)
    }
    return Array.from(names).sort()
  })()

  // ルールを追加
  async function handleAdd() {
    if (!keyword.trim()) {
      toast.error("キーワードを入力してください")
      return
    }
    if (!documentType) {
      toast.error("書類種別を選択してください")
      return
    }

    setIsAdding(true)
    try {
      const res = await fetch("/api/settings?table=auto_classify_rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword: keyword.trim(), document_type: documentType }),
      })
      const json = await res.json() as { data?: AutoClassifyRule; error?: string }
      if (json.error) throw new Error(json.error)
      setRules((prev) => [...prev, json.data!])
      setKeyword("")
      setDocumentType("")
      toast.success("自動仕分けルールを追加しました")
    } catch (e) {
      const msg = e instanceof Error ? e.message : "自動仕分けルールの追加に失敗しました"
      toast.error(msg)
    } finally {
      setIsAdding(false)
    }
  }

  // ルールを削除
  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/settings?table=auto_classify_rules&id=${id}`, {
        method: "DELETE",
      })
      const json = await res.json() as { success?: boolean; error?: string }
      if (json.error) throw new Error(json.error)
      setRules((prev) => prev.filter((r) => r.id !== id))
      toast.success("ルールを削除しました")
    } catch {
      toast.error("ルールの削除に失敗しました")
    }
  }

  // 有効/無効トグル
  async function handleToggle(rule: AutoClassifyRule) {
    try {
      const res = await fetch(`/api/settings?table=auto_classify_rules&id=${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !rule.is_active }),
      })
      const json = await res.json() as { data?: AutoClassifyRule; error?: string }
      if (json.error) throw new Error(json.error)
      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, is_active: !r.is_active } : r))
      )
    } catch {
      toast.error("ルールの更新に失敗しました")
    }
  }

  // 編集開始
  function startEdit(rule: AutoClassifyRule) {
    setEditingId(rule.id)
    setEditKeyword(rule.keyword)
    setEditDocumentType(rule.document_type)
  }

  // 編集保存
  async function handleSaveEdit(id: string) {
    if (!editKeyword.trim() || !editDocumentType) return

    try {
      const res = await fetch(`/api/settings?table=auto_classify_rules&id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword: editKeyword.trim(), document_type: editDocumentType }),
      })
      const json = await res.json() as { data?: AutoClassifyRule; error?: string }
      if (json.error) throw new Error(json.error)
      setRules((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, keyword: editKeyword.trim(), document_type: editDocumentType } : r
        )
      )
      setEditingId(null)
      toast.success("ルールを更新しました")
    } catch {
      toast.error("ルールの更新に失敗しました")
    }
  }

  // プリセット一括追加
  async function handleAddPresets() {
    const existingKeywords = new Set(rules.map((r) => r.keyword))
    const toAdd = PRESET_RULES.filter((p) => !existingKeywords.has(p.keyword))

    if (toAdd.length === 0) {
      toast.info("すべてのプリセットルールが既に登録されています")
      return
    }

    let added = 0
    for (const preset of toAdd) {
      try {
        const res = await fetch("/api/settings?table=auto_classify_rules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(preset),
        })
        const json = await res.json() as { data?: AutoClassifyRule; error?: string }
        if (json.data) {
          setRules((prev) => [...prev, json.data!])
          added++
        }
      } catch {
        // 個別のエラーは無視して続行
      }
    }

    if (added > 0) {
      toast.success(`${added}件のプリセットルールを追加しました`)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>自動仕分けルール</CardTitle>
        <CardDescription>
          取引先名や摘要にキーワードが含まれている場合、書類種別を自動設定します。AIの判定より優先されます。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* クイック追加ボタン */}
        <div className="space-y-2">
          <Label>医療法人向けプリセット</Label>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={handleAddPresets}>
              <Wand2 className="size-3.5" />
              プリセットを一括追加
            </Button>
            <div className="flex flex-wrap gap-1">
              {PRESET_RULES.map((preset) => (
                <Badge key={preset.keyword} variant="secondary" className="text-xs">
                  {preset.keyword} → {preset.document_type}
                </Badge>
              ))}
            </div>
          </div>
        </div>

        {/* 追加フォーム */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2">
            <Label htmlFor="rule-keyword">キーワード</Label>
            <Input
              id="rule-keyword"
              placeholder="例: 薬品"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <div className="flex-1 space-y-2">
            <Label htmlFor="rule-type">対応する書類種別</Label>
            <Select value={documentType} onValueChange={setDocumentType}>
              <SelectTrigger id="rule-type">
                <SelectValue placeholder="種別を選択" />
              </SelectTrigger>
              <SelectContent>
                {allTypeOptions.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={handleAdd} disabled={isAdding || !keyword.trim() || !documentType}>
            {isAdding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            追加
          </Button>
        </div>

        {/* 一覧テーブル */}
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : rules.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            自動仕分けルールが登録されていません
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>キーワード</TableHead>
                <TableHead>書類種別</TableHead>
                <TableHead className="w-24">有効</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>
                    {editingId === rule.id ? (
                      <Input
                        value={editKeyword}
                        onChange={(e) => setEditKeyword(e.target.value)}
                        className="h-8"
                      />
                    ) : (
                      <span className="font-medium">{rule.keyword}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {editingId === rule.id ? (
                      <Select value={editDocumentType} onValueChange={setEditDocumentType}>
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {allTypeOptions.map((name) => (
                            <SelectItem key={name} value={name}>
                              {name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant="outline">{rule.document_type}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={rule.is_active}
                      onCheckedChange={() => handleToggle(rule)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {editingId === rule.id ? (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleSaveEdit(rule.id)}
                            className="size-8"
                          >
                            <Check className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setEditingId(null)}
                            className="size-8"
                          >
                            <X className="size-4" />
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => startEdit(rule)}
                            className="size-8"
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(rule.id)}
                            className="size-8 text-destructive hover:text-destructive"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
