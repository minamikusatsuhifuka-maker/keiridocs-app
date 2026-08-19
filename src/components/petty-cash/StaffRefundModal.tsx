"use client"

import { useEffect, useRef, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Upload } from "lucide-react"
import {
  SUBSIDY_OPTIONS,
  STAFF_EXPENSE_DETAILS,
  EXPENSE_GROUP_LABELS,
  getExpenseDetail,
  calcSubsidy,
  type SubsidyCategory,
  type ExpenseGroup,
} from "@/lib/subsidy"

interface Staff {
  id: string
  name: string
}

/** 解析APIが返すファイル1つ分の結果 */
interface AnalyzedApiFile {
  filename: string
  single: { vendor: string; amount: number; date: string | null; note: string }
  splitCandidates: { vendor: string; amount: number; date: string | null; note: string }[]
  error?: string
}

/** 編集可能な1行（支払い1件＝1行。店名/日付/金額/費用区分を修正できる） */
interface RowDraft {
  store: string
  amount: string
  date: string
  detailKey: string
  note: string
}

/** ファイル1つ分の編集状態（分割候補があれば「分割する/しない」を選べる） */
interface AnalyzedFileState {
  filename: string
  error?: string
  single: RowDraft
  splitCandidates: RowDraft[]
  /** true=支払いごとに分割して登録（分割候補があるファイルの既定） */
  useSplit: boolean
}

const EXPENSE_GROUPS: ExpenseGroup[] = ["ach", "other"]

function toRowDraft(r: { vendor: string; amount: number; date: string | null; note: string }): RowDraft {
  return {
    store: r.vendor ?? "",
    amount: r.amount ? String(r.amount) : "",
    date: (r.date ?? "").slice(0, 10),
    detailKey: "",
    note: r.note ?? "",
  }
}

/** そのファイルで実際に登録される行（分割ON＝候補行、OFF＝単体1行） */
function activeRows(f: AnalyzedFileState): RowDraft[] {
  return f.useSplit && f.splitCandidates.length >= 2 ? f.splitCandidates : [f.single]
}

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSuccess?: () => void
}

type Tab = "manual" | "upload"
type SettlementMethod = "petty_cash" | "payroll" | "storage_only"

// 精算方法の表示ラベル
const SETTLEMENT_OPTIONS: { value: SettlementMethod; label: string; hint: string }[] = [
  { value: "petty_cash", label: "小口現金から返金", hint: "小口残高から差し引きます（少額向け）" },
  { value: "payroll", label: "給与で返金", hint: "次回給与に上乗せ。小口残高は減りません（大金向け）" },
  { value: "storage_only", label: "保管のみ", hint: "返金せず領収書の保管だけ。残高は動きません" },
]

export function StaffRefundModal({ open, onOpenChange, onSuccess }: Props) {
  const today = new Date().toISOString().slice(0, 10)
  // デフォルトは資料アップロード（AI解析）タブ
  const [tab, setTab] = useState<Tab>("upload")
  const [staffList, setStaffList] = useState<Staff[]>([])
  const [staffId, setStaffId] = useState("")
  const [date, setDate] = useState(today)
  const [settlement, setSettlement] = useState<SettlementMethod>("petty_cash")
  // アチーブメント参加区分（既定は「それ以外」＝全額）
  const [subsidyCategory, setSubsidyCategory] = useState<SubsidyCategory>("other")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  // 手入力
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")

  // アップロード
  const [files, setFiles] = useState<File[]>([])
  const [analyzed, setAnalyzed] = useState<AnalyzedFileState[] | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 登録対象の全行（分割ON/OFFを反映）と合計
  const allRows = (analyzed ?? []).flatMap((f, fileIndex) =>
    f.error ? [] : activeRows(f).map((row) => ({ fileIndex, row, file: f }))
  )
  const analyzedTotal = allRows.reduce((sum, { row }) => {
    const n = Number(row.amount)
    return sum + (Number.isFinite(n) && n > 0 ? n : 0)
  }, 0)
  const analyzedSubsidyTotal = allRows.reduce((sum, { row }) => {
    const n = Number(row.amount)
    const detail = getExpenseDetail(row.detailKey)
    if (!Number.isFinite(n) || n <= 0 || !detail) return sum
    return sum + calcSubsidy(Math.round(n), detail.subsidyCategory)
  }, 0)

  /** 行の編集を反映する（isSplit=trueは分割候補行、falseは単体行） */
  function updateRow(fileIndex: number, isSplit: boolean, rowIndex: number, patch: Partial<RowDraft>) {
    setAnalyzed((prev) => {
      if (!prev) return prev
      return prev.map((f, i) => {
        if (i !== fileIndex) return f
        if (isSplit) {
          const next = f.splitCandidates.map((r, j) => (j === rowIndex ? { ...r, ...patch } : r))
          return { ...f, splitCandidates: next }
        }
        return { ...f, single: { ...f.single, ...patch } }
      })
    })
  }

  /** 分割する/しないの切り替え（分割候補があるファイルのみ） */
  function toggleSplit(fileIndex: number, useSplit: boolean) {
    setAnalyzed((prev) =>
      prev ? prev.map((f, i) => (i === fileIndex ? { ...f, useSplit } : f)) : prev
    )
  }

  // PDF / JPG / PNG を許可
  const acceptedTypeRegex = /^(application\/pdf|image\/(jpeg|jpg|png))$/i

  const addFiles = (incoming: File[]) => {
    const accepted = incoming.filter((f) => acceptedTypeRegex.test(f.type))
    setFiles((prev) => {
      const merged = [...prev]
      for (const f of accepted) {
        const dup = merged.some((m) => m.name === f.name && m.size === f.size)
        if (!dup) merged.push(f)
      }
      return merged
    })
    setAnalyzed(null)
  }

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
    setAnalyzed(null)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    addFiles(Array.from(e.dataTransfer.files))
  }

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const fileIcon = (file: File) => {
    if (file.type === "application/pdf") return "📄"
    if (file.type.startsWith("image/")) return "🖼️"
    return "📎"
  }

  useEffect(() => {
    if (!open) return
    fetch("/api/staff-members")
      .then((r) => r.json())
      .then((d) => {
        // /api/staff-members は { data: [...] } で返る
        const list: Staff[] = Array.isArray(d) ? d : d.data || d.staff || []
        setStaffList(list)
      })
      .catch(() => {})
  }, [open])

  const reset = () => {
    setTab("upload")
    setStaffId("")
    setAmount("")
    setNote("")
    setDate(today)
    setSettlement("petty_cash")
    setSubsidyCategory("other")
    setFiles([])
    setAnalyzed(null)
    setIsDragOver(false)
    setError("")
  }

  const submitManual = async () => {
    setError("")
    if (!staffId) {
      setError("スタッフを選択してください")
      return
    }
    const amt = Number(amount)
    if (!amt || amt <= 0) {
      setError("金額を入力してください")
      return
    }

    setLoading(true)
    try {
      const res = await fetch("/api/petty-cash/staff-refund/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staff_member_id: staffId,
          amount: amt,
          note,
          transaction_date: date,
          settlement_method: settlement,
          subsidy_category: subsidyCategory,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "登録に失敗しました")
      reset()
      onOpenChange(false)
      onSuccess?.()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "登録に失敗しました")
    } finally {
      setLoading(false)
    }
  }

  const runAnalyze = async () => {
    setError("")
    if (!staffId) {
      setError("スタッフを選択してください")
      return
    }
    if (files.length === 0) {
      setError("ファイルを選択してください")
      return
    }

    const staffName = staffList.find((s) => s.id === staffId)?.name ?? ""

    setLoading(true)
    try {
      const fd = new FormData()
      files.forEach((f) => fd.append("files", f))
      fd.append("staff_name", staffName)

      const res = await fetch("/api/petty-cash/staff-refund/analyze", {
        method: "POST",
        body: fd,
      })
      const data = await res.json() as { files?: AnalyzedApiFile[]; error?: string }
      if (!res.ok) throw new Error(data.error || "解析に失敗しました")
      // 分割候補があるファイルは既定で「分割して登録」にする（確認UIで切り替え可能）
      setAnalyzed(
        (data.files ?? []).map((f) => ({
          filename: f.filename,
          error: f.error,
          single: toRowDraft(f.single),
          splitCandidates: (f.splitCandidates ?? []).map(toRowDraft),
          useSplit: (f.splitCandidates ?? []).length >= 2,
        }))
      )
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "解析に失敗しました")
    } finally {
      setLoading(false)
    }
  }

  const approve = async () => {
    if (!analyzed) return
    setError("")

    // 行のバリデーション（金額・支払年月日・費用区分）
    for (const [i, { row }] of allRows.entries()) {
      const n = Number(row.amount)
      if (!Number.isFinite(n) || n <= 0) {
        setError(`行${i + 1}: 金額を入力してください`)
        return
      }
      if (!row.date) {
        setError(`行${i + 1}: 支払年月日を入力してください`)
        return
      }
      if (!getExpenseDetail(row.detailKey)) {
        setError(`行${i + 1}: 費用区分を選択してください`)
        return
      }
    }
    if (allRows.length === 0) {
      setError("登録できる行がありません")
      return
    }

    setLoading(true)
    try {
      const fd = new FormData()
      files.forEach((f) => fd.append("files", f))
      fd.append("staff_member_id", staffId)
      fd.append("transaction_date", date)
      fd.append("settlement_method", settlement)
      fd.append(
        "rows",
        JSON.stringify(
          allRows.map(({ fileIndex, row }) => ({
            fileIndex,
            store: row.store,
            amount: Math.round(Number(row.amount)),
            date: row.date,
            detailKey: row.detailKey,
            note: row.note,
          }))
        )
      )

      const res = await fetch("/api/petty-cash/staff-refund/approve", {
        method: "POST",
        body: fd,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "承認に失敗しました")
      reset()
      onOpenChange(false)
      onSuccess?.()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "承認に失敗しました")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>スタッフ返金 登録</DialogTitle>
        </DialogHeader>

        <div className="flex gap-2 border-b pb-2 mb-2">
          <button
            className={`px-3 py-1 rounded-t text-sm ${tab === "manual" ? "bg-amber-100 font-bold" : ""}`}
            onClick={() => setTab("manual")}
          >
            手入力
          </button>
          <button
            className={`px-3 py-1 rounded-t text-sm ${tab === "upload" ? "bg-amber-100 font-bold" : ""}`}
            onClick={() => setTab("upload")}
          >
            資料アップロード（AI解析）
          </button>
        </div>

        <div className="space-y-3 py-2 max-h-[60vh] overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>スタッフ</Label>
              <select
                className="w-full border rounded px-2 py-1.5 text-sm"
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
              >
                <option value="">選択してください</option>
                {staffList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>{tab === "upload" ? "提出日（申請日）" : "日付"}</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>

          {/* 区分（アチーブメント参加区分。手入力タブのみ。アップロードは行ごとに費用区分を選ぶ） */}
          {tab === "manual" && (
            <div className="space-y-1">
              <Label>区分</Label>
              <select
                className="w-full border rounded px-2 py-1.5 text-sm"
                value={subsidyCategory}
                onChange={(e) => setSubsidyCategory(e.target.value as SubsidyCategory)}
              >
                {SUBSIDY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500">
                {subsidyCategory === "achievement_repeat"
                  ? "2回目以降のため、支給額は立替額の半額（端数切り捨て）で計算されます。"
                  : "全額支給（立替額どおり）で計算されます。"}
              </p>
            </div>
          )}

          {/* 精算方法（手入力・アップロード共通） */}
          <div className="space-y-1">
            <Label>精算方法</Label>
            <select
              className="w-full border rounded px-2 py-1.5 text-sm"
              value={settlement}
              onChange={(e) => setSettlement(e.target.value as SettlementMethod)}
            >
              {SETTLEMENT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500">
              {SETTLEMENT_OPTIONS.find((o) => o.value === settlement)?.hint}
            </p>
          </div>

          {tab === "manual" ? (
            <>
              <div className="space-y-1">
                <Label>金額（円）</Label>
                <Input
                  type="number"
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>内容</Label>
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="例: 備品購入立替分"
                />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label>領収書ファイル（複数可・PDF/JPG/PNG）</Label>

                {/* D&Dゾーン */}
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDrop={onDrop}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  className={[
                    "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 transition cursor-pointer",
                    isDragOver
                      ? "border-[#A0703A] bg-[#F5EFE6] scale-[1.01]"
                      : "border-[#E0CEB8] bg-[#FAF7F0] hover:bg-[#F5EFE6]",
                  ].join(" ")}
                >
                  <Upload className="size-8 text-[#A0703A]" />
                  {isDragOver ? (
                    <span className="text-sm font-medium text-[#A0703A]">ここでドロップ！</span>
                  ) : (
                    <>
                      <span className="text-sm font-medium text-[#8B5E2F]">
                        クリックまたはドロップして領収書をアップロード
                      </span>
                      <span className="text-xs text-[#A0703A]/70">
                        PDF・JPG・PNG対応 / 複数ファイル一括OK
                      </span>
                    </>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="application/pdf,image/*"
                    className="hidden"
                    onChange={(e) => {
                      addFiles(Array.from(e.target.files ?? []))
                      e.target.value = ""
                    }}
                  />
                </div>

                {/* 選択済みファイル一覧 */}
                {files.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-gray-600">{files.length} 件選択中</p>
                    <ul className="border rounded divide-y bg-white max-h-48 overflow-y-auto">
                      {files.map((f, i) => (
                        <li
                          key={`${f.name}-${f.size}-${i}`}
                          className="flex items-center justify-between px-3 py-2 text-sm"
                        >
                          <span className="flex items-center gap-2 truncate">
                            <span>{fileIcon(f)}</span>
                            <span className="truncate">{f.name}</span>
                            <span className="text-xs text-gray-500 shrink-0">
                              ({formatSize(f.size)})
                            </span>
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              removeFile(i)
                            }}
                            className="ml-2 text-gray-400 hover:text-red-500 text-lg leading-none shrink-0"
                            aria-label="削除"
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {!analyzed && (
                <Button onClick={runAnalyze} disabled={loading || files.length === 0}>
                  {loading ? "AI解析中…" : "AI解析を実行"}
                </Button>
              )}

              {analyzed && (
                <div className="border rounded p-3 bg-amber-50 space-y-3">
                  <p className="font-bold">解析結果（支払いごとに1行・各行を修正できます）</p>
                  {analyzed.map((f, fileIndex) => {
                    const hasSplit = f.splitCandidates.length >= 2
                    const rows = activeRows(f)
                    const editingSplit = hasSplit && f.useSplit
                    return (
                      <div key={`${f.filename}-${fileIndex}`} className="rounded border bg-white p-2 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="max-w-full truncate text-xs font-medium">📎 {f.filename}</span>
                          {hasSplit && !f.error && (
                            <div className="flex flex-wrap items-center gap-1 text-xs">
                              <span className="font-medium text-amber-700">
                                複数の領収書を検出（{f.splitCandidates.length}件）
                              </span>
                              <button
                                type="button"
                                onClick={() => toggleSplit(fileIndex, true)}
                                className={`rounded border px-2 py-0.5 ${
                                  f.useSplit
                                    ? "border-amber-500 bg-amber-100 font-bold"
                                    : "border-gray-300 bg-white hover:bg-gray-50"
                                }`}
                              >
                                分割して登録
                              </button>
                              <button
                                type="button"
                                onClick={() => toggleSplit(fileIndex, false)}
                                className={`rounded border px-2 py-0.5 ${
                                  !f.useSplit
                                    ? "border-amber-500 bg-amber-100 font-bold"
                                    : "border-gray-300 bg-white hover:bg-gray-50"
                                }`}
                              >
                                分割せず1件のまま登録
                              </button>
                            </div>
                          )}
                        </div>
                        {f.error ? (
                          <p className="text-sm text-red-600">{f.error}（このファイルは登録されません）</p>
                        ) : (
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b text-left">
                                <th className="py-1">店名</th>
                                <th className="w-[120px]">支払年月日</th>
                                <th className="w-[90px] text-right">金額</th>
                                <th className="w-[190px]">費用区分</th>
                                <th className="w-[80px] text-right">支給額</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((r, rowIndex) => {
                                const detail = getExpenseDetail(r.detailKey)
                                const n = Number(r.amount)
                                const subsidy =
                                  detail && Number.isFinite(n) && n > 0
                                    ? calcSubsidy(Math.round(n), detail.subsidyCategory)
                                    : null
                                return (
                                  <tr key={rowIndex} className="border-b last:border-0 align-top">
                                    <td className="py-1 pr-1">
                                      <Input
                                        value={r.store}
                                        onChange={(e) =>
                                          updateRow(fileIndex, editingSplit, rowIndex, { store: e.target.value })
                                        }
                                        className="h-7 text-xs"
                                        placeholder="店名"
                                      />
                                      {r.note && (
                                        <p className="mt-0.5 truncate text-[10px] text-gray-500" title={r.note}>
                                          {r.note}
                                        </p>
                                      )}
                                    </td>
                                    <td className="py-1 pr-1">
                                      <Input
                                        type="date"
                                        value={r.date}
                                        onChange={(e) =>
                                          updateRow(fileIndex, editingSplit, rowIndex, { date: e.target.value })
                                        }
                                        className="h-7 text-xs"
                                      />
                                    </td>
                                    <td className="py-1 pr-1">
                                      <Input
                                        type="number"
                                        inputMode="numeric"
                                        value={r.amount}
                                        onChange={(e) =>
                                          updateRow(fileIndex, editingSplit, rowIndex, { amount: e.target.value })
                                        }
                                        className="h-7 text-right text-xs"
                                      />
                                    </td>
                                    <td className="py-1 pr-1">
                                      <select
                                        value={r.detailKey}
                                        onChange={(e) =>
                                          updateRow(fileIndex, editingSplit, rowIndex, { detailKey: e.target.value })
                                        }
                                        className="h-7 w-full rounded border px-1 text-xs"
                                      >
                                        <option value="">区分を選択…</option>
                                        {EXPENSE_GROUPS.map((g) => (
                                          <optgroup key={g} label={EXPENSE_GROUP_LABELS[g]}>
                                            {STAFF_EXPENSE_DETAILS.filter((d) => d.group === g).map((d) => (
                                              <option key={d.key} value={d.key}>
                                                {d.fullLabel}
                                              </option>
                                            ))}
                                          </optgroup>
                                        ))}
                                      </select>
                                    </td>
                                    <td className="py-1 text-right">
                                      {subsidy !== null ? (
                                        <span>
                                          ¥{subsidy.toLocaleString()}
                                          {detail?.subsidyCategory === "achievement_repeat" && (
                                            <span className="block text-[10px] text-red-600">半額</span>
                                          )}
                                        </span>
                                      ) : (
                                        <span className="text-gray-400">—</span>
                                      )}
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )
                  })}
                  <div className="flex justify-end gap-4 text-sm font-bold">
                    <span>立替合計 ¥{analyzedTotal.toLocaleString()}</span>
                    <span>支給額合計 ¥{analyzedSubsidyTotal.toLocaleString()}</span>
                  </div>
                  <p className="text-xs text-gray-600">
                    「承認」を押すと行ごとに別レコードとして登録され、領収書はDropboxの
                    <code className="mx-1">スタッフ領収書/{"{スタッフ名}"}/{"{提出日}"}/</code>
                    に保存されます（分割行は同じファイルを共有します）。
                    {settlement === "petty_cash"
                      ? "合計金額が小口残高から差し引かれます。"
                      : settlement === "payroll"
                      ? "給与で返金するため小口残高は変動しません（給与返金待ちに計上）。"
                      : "保管のみのため小口残高は変動しません。"}
                  </p>
                </div>
              )}
            </>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            キャンセル
          </Button>
          {tab === "manual" ? (
            <Button onClick={submitManual} disabled={loading}>
              {loading ? "登録中…" : "登録"}
            </Button>
          ) : (
            analyzed && (
              <Button onClick={approve} disabled={loading}>
                {loading
                  ? "保存中…"
                  : settlement === "petty_cash"
                  ? `承認（¥${analyzedTotal.toLocaleString()} を差引）`
                  : `承認（¥${analyzedTotal.toLocaleString()}）`}
              </Button>
            )
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
