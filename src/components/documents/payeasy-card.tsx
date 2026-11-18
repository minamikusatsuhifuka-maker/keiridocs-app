"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Check, Copy, CreditCard, Eye, EyeOff, Loader2, Pencil } from "lucide-react"
import { groupDigits } from "@/lib/gemini-shared"
import { isPayEasyComplete, onlyDigits, readPayEasy, type PayEasyEntry } from "@/lib/payeasy"

/**
 * Pay-easy（ペイジー）納付カード。
 *
 * 支払いのときに最初に見る情報なので、書類詳細の一番上に置く。
 *
 * ■ コピーは1項目ずつ
 * Pay-easyは1項目ずつ入力する画面のため、まとめてコピーしても貼れない。
 *
 * ■ 表示は4桁区切り、コピーは数字だけ
 * 空白が混ざると銀行の入力欄で弾かれる。
 *
 * ■ 確認番号は初期は伏せる
 * 番号だけで支払いができてしまうため。
 */

interface Props {
  documentId: string
  ocrRaw: unknown
  /** 保存後に親へ新しい ocr_raw を渡す（画面を作り直さずに反映するため） */
  onUpdated: (ocrRaw: unknown) => void
}

export function PayEasyCard({ documentId, ocrRaw, onUpdated }: Props) {
  const entries = readPayEasy(ocrRaw)
  const [saving, setSaving] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)

  if (entries.length === 0) return null

  const incomplete = entries.some((e) => !isPayEasyComplete(e))

  /** 納付済みの印を付け外しする */
  async function togglePaid(index: number, paid: boolean) {
    setSaving(index)
    try {
      const res = await fetch(`/api/documents/${documentId}/payeasy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index, paid }),
      })
      const json = (await res.json().catch(() => ({}))) as { ocr_raw?: unknown; error?: string }
      if (!res.ok) throw new Error(json.error || "保存できませんでした")
      onUpdated(json.ocr_raw)
      toast.success(paid ? "納付済みにしました" : "未納付に戻しました")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存できませんでした")
    } finally {
      setSaving(null)
    }
  }

  return (
    <Card className="border-2 border-sky-500">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <CreditCard className="size-4 text-sky-600" />
          Pay-easy 納付
          {incomplete && (
            <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
              番号が足りません
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setEditing((v) => !v)}
          >
            <Pencil className="size-3.5" />
            {editing ? "入力をやめる" : "自分で入力する"}
          </Button>
        </CardTitle>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {editing ? (
          <PayEasyEditor
            documentId={documentId}
            entries={entries}
            onDone={(raw) => {
              onUpdated(raw)
              setEditing(false)
            }}
          />
        ) : (
          <>
            {entries.map((entry, i) => (
              <PayEasySet
                key={`${entry.kind}-${i}`}
                entry={entry}
                index={i}
                total={entries.length}
                saving={saving === i}
                onTogglePaid={togglePaid}
              />
            ))}

            {incomplete && (
              <div className="flex flex-col gap-2 rounded-md border border-amber-500 bg-amber-50 px-3 py-2.5 dark:bg-amber-950/30">
                <p className="text-sm font-medium">番号の一部を読み取れませんでした</p>
                <p className="text-xs leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
                  読み取れなかった項目は「読み取れていません」と表示しています。
                  書類を見て「自分で入力する」から入力してください。
                  AIの読み直しを試す場合は、上の「再解析」を押してください。
                </p>
                <div>
                  <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                    <Pencil className="size-3.5" />
                    自分で入力する
                  </Button>
                </div>
              </div>
            )}

            {entries.length >= 2 && (
              <p className="rounded-md border-l-4 border-rose-500 bg-rose-50 px-3 py-2 text-xs leading-relaxed dark:bg-rose-950/30">
                <strong>納付書は「{entries.map((e) => e.kind).join("」と「")}」の{entries.length}枚です。</strong>
                <br />
                銀行の画面では1回ずつ分けて操作します。1枚目を納付してから2枚目に進んでください。
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** 1組（税金分・手数料分のいずれか） */
function PayEasySet({
  entry,
  index,
  total,
  saving,
  onTogglePaid,
}: {
  entry: PayEasyEntry
  index: number
  total: number
  saving: boolean
  onTogglePaid: (index: number, paid: boolean) => void
}) {
  const paid = !!entry.paid_at
  const ready = isPayEasyComplete(entry)

  return (
    <div className="rounded-lg border p-3">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">
            {total >= 2 ? `${index + 1}. ` : ""}
            {entry.kind}
          </span>
          {entry.note && (
            <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
              {entry.note}
            </span>
          )}
          {paid && (
            <Badge variant="outline" className="border-emerald-500 text-emerald-700 dark:text-emerald-400">
              <Check className="size-3" />
              納付済み
            </Badge>
          )}
        </div>
        {entry.amount != null && (
          <span className="font-mono text-base font-bold tabular-nums">
            ¥{entry.amount.toLocaleString("ja-JP")}
          </span>
        )}
      </div>

      {entry.due_date && (
        <p className="mb-3 text-xs" style={{ color: "var(--muted-foreground)" }}>
          納期限 {entry.due_date}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <CopyField label="収納機関番号" value={entry.institution_code} />
        <CopyField label="お客様番号・納付番号" value={entry.customer_number} />
        <CopyField label="確認番号" value={entry.confirmation_number} secret />
      </div>

      {entry.declaration_number && (
        <p className="mt-3 text-xs" style={{ color: "var(--muted-foreground)" }}>
          申告番号 {entry.declaration_number}
        </p>
      )}

      <div className="mt-3">
        <Button
          variant={paid ? "ghost" : "default"}
          size="sm"
          disabled={saving || !ready}
          onClick={() => onTogglePaid(index, !paid)}
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          {paid ? "未納付に戻す" : "納付済みにする"}
        </Button>
        {!ready && (
          <span className="ml-2 text-xs" style={{ color: "var(--muted-foreground)" }}>
            番号が揃っていないため納付できません
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * 1項目のコピー欄。
 *
 * 押したボタンだけ「コピーしました」に変え、どこまで入力したか分かるようにする。
 * クリップボードが使えない環境では、番号を選択状態にして手でコピーできるようにする。
 */
function CopyField({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [shown, setShown] = useState(false)

  const empty = !value
  const display = empty
    ? "読み取れていません"
    : secret && !shown
      ? "•".repeat(value.length)
      : groupDigits(value)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // クリップボードが使えない環境（古いブラウザ・権限なし）への備え
      toast.info(`${label}：${value}`, { description: "長押しでコピーしてください", duration: 8000 })
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-40 shrink-0 text-xs" style={{ color: "var(--muted-foreground)" }}>
        {label}
      </span>
      <span
        className="min-w-0 flex-1 break-all font-mono text-base font-bold tabular-nums"
        style={empty ? { color: "var(--muted-foreground)", fontWeight: 400 } : undefined}
      >
        {display}
      </span>
      {secret && !empty && (
        <Button variant="ghost" size="sm" onClick={() => setShown((v) => !v)}>
          {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          {shown ? "隠す" : "表示"}
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={empty}
        onClick={copy}
        className={copied ? "border-emerald-500 text-emerald-700 dark:text-emerald-400" : undefined}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? "コピーしました" : "コピー"}
      </Button>
    </div>
  )
}

/** 読み取れなかった番号を担当が手で入力する */
function PayEasyEditor({
  documentId,
  entries,
  onDone,
}: {
  documentId: string
  entries: PayEasyEntry[]
  onDone: (ocrRaw: unknown) => void
}) {
  const [rows, setRows] = useState<PayEasyEntry[]>(entries)
  const [saving, setSaving] = useState(false)

  function update(i: number, patch: Partial<PayEasyEntry>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/documents/${documentId}/payeasy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: rows.map((r) => ({ ...r, manual: true })) }),
      })
      const json = (await res.json().catch(() => ({}))) as { ocr_raw?: unknown; error?: string }
      if (!res.ok) throw new Error(json.error || "保存できませんでした")
      toast.success("入力した番号を保存しました")
      onDone(json.ocr_raw)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存できませんでした")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs" style={{ color: "var(--muted-foreground)" }}>
        書類に印字されている番号をそのまま入力してください。数字以外は自動で取り除きます。
      </p>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg border p-3">
          <p className="text-sm font-medium">{r.kind}</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`pe-inst-${i}`} className="text-xs">収納機関番号（5桁）</Label>
              <Input
                id={`pe-inst-${i}`}
                inputMode="numeric"
                value={r.institution_code}
                onChange={(e) => update(i, { institution_code: onlyDigits(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`pe-cust-${i}`} className="text-xs">お客様番号・納付番号</Label>
              <Input
                id={`pe-cust-${i}`}
                inputMode="numeric"
                value={r.customer_number}
                onChange={(e) => update(i, { customer_number: onlyDigits(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`pe-conf-${i}`} className="text-xs">確認番号（6桁）</Label>
              <Input
                id={`pe-conf-${i}`}
                inputMode="numeric"
                value={r.confirmation_number}
                onChange={(e) => update(i, { confirmation_number: onlyDigits(e.target.value) })}
              />
            </div>
          </div>
        </div>
      ))}
      <div>
        <Button size="sm" disabled={saving} onClick={save}>
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          入力した内容を保存
        </Button>
      </div>
    </div>
  )
}
