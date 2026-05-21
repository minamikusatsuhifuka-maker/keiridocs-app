"use client"

import { useEffect, useState } from "react"
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

interface Staff {
  id: string
  name: string
}

interface AnalyzedItem {
  filename: string
  vendor: string
  amount: number
  date: string | null
  note?: string
  error?: string
}

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSuccess?: () => void
}

type Tab = "manual" | "upload"

export function StaffRefundModal({ open, onOpenChange, onSuccess }: Props) {
  const today = new Date().toISOString().slice(0, 10)
  const [tab, setTab] = useState<Tab>("manual")
  const [staffList, setStaffList] = useState<Staff[]>([])
  const [staffId, setStaffId] = useState("")
  const [date, setDate] = useState(today)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  // 手入力
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")

  // アップロード
  const [files, setFiles] = useState<File[]>([])
  const [analyzed, setAnalyzed] = useState<AnalyzedItem[] | null>(null)
  const [analyzedTotal, setAnalyzedTotal] = useState(0)

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
    setTab("manual")
    setStaffId("")
    setAmount("")
    setNote("")
    setDate(today)
    setFiles([])
    setAnalyzed(null)
    setAnalyzedTotal(0)
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
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "解析に失敗しました")
      setAnalyzed(data.items)
      setAnalyzedTotal(data.total)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "解析に失敗しました")
    } finally {
      setLoading(false)
    }
  }

  const approve = async () => {
    if (!analyzed) return
    setError("")
    setLoading(true)
    try {
      const fd = new FormData()
      files.forEach((f) => fd.append("files", f))
      fd.append("staff_member_id", staffId)
      fd.append("total_amount", String(analyzedTotal))
      fd.append(
        "note",
        analyzed
          .map((it, i) => `${i + 1}. ${it.vendor || "?"} ¥${it.amount.toLocaleString()}`)
          .join(" / ")
      )
      fd.append("transaction_date", date)

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
      <DialogContent className="sm:max-w-[640px]">
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
              <Label>日付</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
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
              <div className="space-y-1">
                <Label>領収書ファイル（複数可・PDF/JPG/PNG）</Label>
                <Input
                  type="file"
                  multiple
                  accept="application/pdf,image/*"
                  onChange={(e) => {
                    setFiles(Array.from(e.target.files ?? []))
                    setAnalyzed(null)
                  }}
                />
                {files.length > 0 && (
                  <p className="text-xs text-gray-500 mt-1">{files.length}件選択中</p>
                )}
              </div>

              {!analyzed && (
                <Button onClick={runAnalyze} disabled={loading || files.length === 0}>
                  {loading ? "AI解析中…" : "AI解析を実行"}
                </Button>
              )}

              {analyzed && (
                <div className="border rounded p-3 bg-amber-50 space-y-2">
                  <p className="font-bold">解析結果</p>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left border-b">
                        <th className="py-1">ファイル</th>
                        <th>店名</th>
                        <th>日付</th>
                        <th className="text-right">金額</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analyzed.map((it, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-1">{it.filename}</td>
                          <td>{it.vendor || "-"}</td>
                          <td>{it.date || "-"}</td>
                          <td className="text-right">
                            {it.error ? (
                              <span className="text-red-600">{it.error}</span>
                            ) : (
                              `¥${it.amount.toLocaleString()}`
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="font-bold">
                        <td colSpan={3} className="text-right pt-2">
                          合計
                        </td>
                        <td className="text-right pt-2">¥{analyzedTotal.toLocaleString()}</td>
                      </tr>
                    </tfoot>
                  </table>
                  <p className="text-xs text-gray-600">
                    内容に問題がなければ「承認」を押すと、領収書はDropboxの
                    <code className="mx-1">スタッフ領収書/{"{スタッフ名}"}/{"{YYYY年MM月}"}/</code>
                    に保存され、合計金額が小口残高から差し引かれます。
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
                {loading ? "保存中…" : `承認（¥${analyzedTotal.toLocaleString()} を差引）`}
              </Button>
            )
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
