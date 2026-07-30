"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2, Split, Trash2, FileStack, AlertTriangle } from "lucide-react"
import { type SplitPayment, TAX_CATEGORIES, ACCOUNT_TITLES } from "@/lib/gemini"

/** 編集用の行データ（金額は入力しやすいよう文字列で保持） */
interface SplitPaymentDraft {
  vendor_name: string
  amount: string
  issue_date: string
  due_date: string
  description: string
  tax_category: string
  account_title: string
}

interface SplitPaymentsConfirmProps {
  /** AI解析で検出された分割候補 */
  payments: SplitPayment[]
  /** 書類全体の合計金額（参考表示用） */
  totalAmount?: number | null
  isSubmitting: boolean
  /** 分割確定ボタンのラベル（既定: 分割して登録） */
  confirmLabel?: string
  /** 分割取消ボタンのラベル（既定: 1件のまま登録する） */
  singleLabel?: string
  /** 分割を確定したときに呼ばれる（編集後の内容） */
  onConfirmSplit: (payments: SplitPayment[]) => void
  /** 分割せず1件のまま進めるときに呼ばれる */
  onRegisterAsOne: () => void
}

/** SplitPayment → 編集用ドラフトに変換 */
function toDraft(p: SplitPayment): SplitPaymentDraft {
  return {
    vendor_name: p.vendor_name,
    amount: p.amount != null ? String(p.amount) : "",
    issue_date: p.issue_date ?? "",
    due_date: p.due_date ?? "",
    description: p.description ?? "",
    tax_category: p.tax_category ?? "未判定",
    account_title: p.account_title ?? "",
  }
}

/** 編集用ドラフト → SplitPayment に戻す */
function fromDraft(d: SplitPaymentDraft): SplitPayment {
  return {
    vendor_name: d.vendor_name.trim(),
    amount: d.amount !== "" && !isNaN(Number(d.amount)) ? Number(d.amount) : null,
    issue_date: d.issue_date || null,
    due_date: d.due_date || null,
    description: d.description || null,
    tax_category: d.tax_category || null,
    account_title: d.account_title || null,
  }
}

/**
 * 複数支払いの分割候補 確認UI
 * - 各支払いの金額・払込先・勘定科目などを編集できる
 * - 不要な行の削除、分割の取消（1件のまま登録）も選べる
 */
export function SplitPaymentsConfirm({
  payments,
  totalAmount,
  isSubmitting,
  confirmLabel = "分割して登録",
  singleLabel = "1件のまま登録する",
  onConfirmSplit,
  onRegisterAsOne,
}: SplitPaymentsConfirmProps) {
  const [drafts, setDrafts] = useState<SplitPaymentDraft[]>(payments.map(toDraft))

  // 解析し直し等で候補が変わったら編集内容をリセット
  useEffect(() => {
    setDrafts(payments.map(toDraft))
  }, [payments])

  function updateDraft(index: number, patch: Partial<SplitPaymentDraft>) {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)))
  }

  function removeDraft(index: number) {
    setDrafts((prev) => prev.filter((_, i) => i !== index))
  }

  const splitSum = drafts.reduce((sum, d) => {
    const n = Number(d.amount)
    return sum + (d.amount !== "" && !isNaN(n) ? n : 0)
  }, 0)
  const sumMismatch = totalAmount != null && splitSum !== totalAmount
  const hasInvalidRow = drafts.some((d) => !d.vendor_name.trim() || d.amount === "" || isNaN(Number(d.amount)))
  const canSplit = drafts.length >= 2 && !hasInvalidRow

  return (
    <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-amber-800 dark:text-amber-300">
          <FileStack className="size-4" />
          複数の支払いを検出しました
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          この書類には独立した支払いが{payments.length}件含まれている可能性があります。
          支払いごとに別レコードとして登録するか、従来どおり1件で登録するか選んでください。
          内容は下で修正できます。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {drafts.map((draft, i) => (
          <div
            key={i}
            className="space-y-3 rounded-lg border bg-white p-4 dark:bg-white/5"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">支払い {i + 1}</span>
              {drafts.length > 2 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeDraft(i)}
                  disabled={isSubmitting}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                  この行を削除
                </Button>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>払込先・納付先</Label>
                <Input
                  value={draft.vendor_name}
                  onChange={(e) => updateDraft(i, { vendor_name: e.target.value })}
                  placeholder="払込先を入力"
                />
              </div>
              <div className="space-y-1.5">
                <Label>金額</Label>
                <Input
                  type="number"
                  value={draft.amount}
                  onChange={(e) => updateDraft(i, { amount: e.target.value })}
                  placeholder="0"
                />
              </div>
              <div className="space-y-1.5">
                <Label>発行日</Label>
                <Input
                  type="date"
                  value={draft.issue_date}
                  onChange={(e) => updateDraft(i, { issue_date: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>支払期日</Label>
                <Input
                  type="date"
                  value={draft.due_date}
                  onChange={(e) => updateDraft(i, { due_date: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>税区分</Label>
                <Select
                  value={draft.tax_category || undefined}
                  onValueChange={(v) => updateDraft(i, { tax_category: v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="税区分を選択" />
                  </SelectTrigger>
                  <SelectContent>
                    {/* AI判定が選択肢にない場合も表示する */}
                    {draft.tax_category && !TAX_CATEGORIES.includes(draft.tax_category as typeof TAX_CATEGORIES[number]) && (
                      <SelectItem value={draft.tax_category}>{draft.tax_category}（AI判定）</SelectItem>
                    )}
                    {TAX_CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>勘定科目</Label>
                <Select
                  value={draft.account_title || undefined}
                  onValueChange={(v) => updateDraft(i, { account_title: v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="勘定科目を選択" />
                  </SelectTrigger>
                  <SelectContent>
                    {/* AI判定が選択肢にない場合も表示する（例: 租税公課） */}
                    {draft.account_title && !ACCOUNT_TITLES.includes(draft.account_title as typeof ACCOUNT_TITLES[number]) && (
                      <SelectItem value={draft.account_title}>{draft.account_title}（AI判定）</SelectItem>
                    )}
                    {ACCOUNT_TITLES.map((title) => (
                      <SelectItem key={title} value={title}>{title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>摘要（払込内容）</Label>
                <Input
                  value={draft.description}
                  onChange={(e) => updateDraft(i, { description: e.target.value })}
                  placeholder="払込内容を入力"
                />
              </div>
            </div>
          </div>
        ))}

        {/* 合計の確認 */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">分割合計: ¥{splitSum.toLocaleString()}</span>
          {totalAmount != null && (
            <span className="text-muted-foreground">
              / 書類全体の金額: ¥{totalAmount.toLocaleString()}
            </span>
          )}
          {sumMismatch && (
            <span className="flex items-center gap-1 rounded-full bg-amber-200 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-800 dark:text-amber-200">
              <AlertTriangle className="size-3" />
              合計が一致しません。金額を確認してください
            </span>
          )}
        </div>

        {hasInvalidRow && (
          <p className="text-xs text-destructive">
            払込先と金額が未入力の行があります。すべての行を入力すると分割登録できます。
          </p>
        )}

        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            type="button"
            className="btn-float-primary flex-1"
            disabled={isSubmitting || !canSplit}
            onClick={() => onConfirmSplit(drafts.map(fromDraft))}
          >
            {isSubmitting ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <Split className="mr-2 size-4" />
            )}
            {isSubmitting ? "登録中..." : `${confirmLabel}（${drafts.length}件）`}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="btn-float flex-1"
            disabled={isSubmitting}
            onClick={onRegisterAsOne}
          >
            {singleLabel}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
