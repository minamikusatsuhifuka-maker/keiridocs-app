"use client"

import { useState } from "react"
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

type Subcategory = "insurance_refund" | "self_pay_refund" | "other"

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSuccess?: () => void
}

export function PatientResponseModal({ open, onOpenChange, onSuccess }: Props) {
  const today = new Date().toISOString().slice(0, 10)
  const [amount, setAmount] = useState("")
  const [subcategory, setSubcategory] = useState<Subcategory>("insurance_refund")
  const [note, setNote] = useState("")
  const [date, setDate] = useState(today)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const reset = () => {
    setAmount("")
    setSubcategory("insurance_refund")
    setNote("")
    setDate(today)
    setError("")
  }

  const handleSubmit = async () => {
    setError("")
    const amt = Number(amount)
    if (!amt || amt <= 0) {
      setError("金額を入力してください")
      return
    }
    if (subcategory === "other" && !note.trim()) {
      setError("「その他」の場合は内容を入力してください")
      return
    }

    setLoading(true)
    try {
      const res = await fetch("/api/petty-cash/patient-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: amt,
          subcategory,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>患者対応 支出登録</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>日付</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div className="space-y-2">
            <Label>金額（円）</Label>
            <Input
              type="number"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="例: 3500"
            />
          </div>

          <div className="space-y-2">
            <Label>内容</Label>
            <div className="flex flex-col gap-2 mt-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={subcategory === "insurance_refund"}
                  onChange={() => setSubcategory("insurance_refund")}
                />
                保険診療返金
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={subcategory === "self_pay_refund"}
                  onChange={() => setSubcategory("self_pay_refund")}
                />
                自費診療返金
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={subcategory === "other"}
                  onChange={() => setSubcategory("other")}
                />
                その他（自由入力）
              </label>
              {subcategory === "other" && (
                <Input
                  className="mt-1"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="内容を入力"
                />
              )}
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            キャンセル
          </Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? "登録中…" : "登録（残高から差引）"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
