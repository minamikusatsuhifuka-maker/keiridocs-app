"use client"

// 要振込バッジのボタン版。
// 「⚠要振込」をクリック → その場で支払い完了（payment-status API・/payments の「支払い完了」と同一処理）にし、
// 「✓振込完了」バッジに切り替える。楽観更新で即時反映し、API失敗時は元に戻す。
// 誤クリック対策として、完了直後のトースト「元に戻す」と、「✓振込完了」バッジ再クリック（確認トースト経由）の
// 2通りで「未払いに戻す」（既存処理を再利用）ができる。
// 一覧（document-table）と詳細ページの両方から使う。

import { useState } from "react"
import { AlertCircle, Check, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

/** 表示・更新に必要な最小限の書類情報 */
export interface TransferBadgeDoc {
  id: string
  status: string
  type: string
  payment_status: string | null
  payment_method: string | null
}

/** 楽観更新・確定反映で書き換えるフィールド */
export interface TransferBadgePatch {
  status: string
  payment_status: string
}

interface TransferBadgeButtonProps {
  doc: TransferBadgeDoc
  /** 表示を書き換えるコールバック（楽観更新・サーバー確定値・失敗時の差し戻しすべてここを通す） */
  onApplied: (patch: TransferBadgePatch) => void
  className?: string
}

/**
 * 「要振込だった書類（都度振込の請求書）」が支払い済みになった状態か。
 * 支払先マスタは参照できないため、payment_method（AI判定）ベースの近似で判定する
 * （要振込ステータスの自動判定 resolveAutoDocumentStatus と同じ基準の bank_transfer のみ対象）。
 */
function isCompletedTransfer(doc: TransferBadgeDoc): boolean {
  return (
    doc.type === "請求書" &&
    doc.status !== "要振込" &&
    doc.payment_status === "支払い済み" &&
    doc.payment_method === "bank_transfer"
  )
}

export function TransferBadgeButton({ doc, onApplied, className }: TransferBadgeButtonProps) {
  const [busy, setBusy] = useState(false)

  const isTransfer = doc.status === "要振込"
  const isCompleted = !isTransfer && isCompletedTransfer(doc)

  // 要振込でも振込完了でもない書類には何も表示しない（従来どおり）
  if (!isTransfer && !isCompleted) return null

  /** payment-status API を呼び、サーバー確定値（status / payment_status）を返す */
  async function callApi(next: "支払い済み" | "未対応"): Promise<TransferBadgePatch | null> {
    const res = await fetch(`/api/documents/${doc.id}/payment-status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payment_status: next }),
    })
    const json = (await res.json().catch(() => ({}))) as {
      data?: { status?: string | null; payment_status?: string | null }
      error?: string
    }
    if (!res.ok) {
      throw new Error(json.error ?? "支払状態の更新に失敗しました")
    }
    if (typeof json.data?.status === "string" && typeof json.data?.payment_status === "string") {
      return { status: json.data.status, payment_status: json.data.payment_status }
    }
    return null
  }

  /** 未払いに戻す（既存の「未払いに戻す」と同一API・振込完了状態からの取り消し） */
  async function revertToUnpaid() {
    const rollback: TransferBadgePatch = { status: "処理済み", payment_status: "支払い済み" }
    // 楽観更新: 即座に要振込表示へ戻す
    onApplied({ status: "要振込", payment_status: "未対応" })
    setBusy(true)
    try {
      const confirmed = await callApi("未対応")
      // サーバーの確定値で上書き（マスタ判定などで要振込に戻らないケースも正しく反映）
      if (confirmed) onApplied(confirmed)
      toast.success("未払いに戻しました")
    } catch (error) {
      onApplied(rollback)
      toast.error(error instanceof Error ? error.message : "支払状態の更新に失敗しました")
    } finally {
      setBusy(false)
    }
  }

  /** 振込完了にする（/payments の「支払い完了」と同一API） */
  async function markAsPaid() {
    const rollback: TransferBadgePatch = {
      status: doc.status,
      payment_status: doc.payment_status ?? "未対応",
    }
    // 楽観更新: 即座に振込完了表示へ切り替える（行頭マーク・行の色も status 連動で消える）
    onApplied({ status: "処理済み", payment_status: "支払い済み" })
    setBusy(true)
    try {
      const confirmed = await callApi("支払い済み")
      if (confirmed) onApplied(confirmed)
      toast.success("振込完了にしました", {
        action: { label: "元に戻す", onClick: () => void revertToUnpaid() },
      })
    } catch (error) {
      onApplied(rollback)
      toast.error(error instanceof Error ? error.message : "支払状態の更新に失敗しました")
    } finally {
      setBusy(false)
    }
  }

  if (isTransfer) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          if (!busy) void markAsPaid()
        }}
        disabled={busy}
        title="クリックで振込完了にする"
        aria-label="振込完了にする"
        className={cn(
          "inline-flex items-center gap-0.5 rounded-md border border-red-300 bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700",
          "cursor-pointer transition-colors hover:bg-red-200 hover:border-red-400 disabled:opacity-60 disabled:cursor-wait",
          className
        )}
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <AlertCircle className="size-3" />}
        要振込
      </button>
    )
  }

  // 振込完了バッジ（落ち着いた色）。再クリックで確認のうえ未払いに戻せる
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        if (busy) return
        toast("未払いに戻しますか？", {
          action: { label: "未払いに戻す", onClick: () => void revertToUnpaid() },
        })
      }}
      disabled={busy}
      title="振込完了（クリックで未払いに戻す）"
      aria-label="未払いに戻す"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700",
        "cursor-pointer transition-colors hover:bg-emerald-100 disabled:opacity-60 disabled:cursor-wait",
        "dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400",
        className
      )}
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
      振込完了
    </button>
  )
}
