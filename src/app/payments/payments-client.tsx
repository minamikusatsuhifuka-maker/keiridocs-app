"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  Wallet,
  AlertTriangle,
  CheckCircle2,
  RotateCcw,
  Loader2,
  Landmark,
  HelpCircle,
  ExternalLink,
  RefreshCw,
  Repeat,
  ChevronDown,
  ChevronRight,
  Trash2,
  ListChecks,
  Wand2,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { format, differenceInDays } from "date-fns"
import { toast } from "sonner"
import type { BankInfo } from "@/lib/gemini"
import {
  codeToCategory,
  requiresTransfer,
  isUnconfirmed,
  type PaymentCategory,
} from "@/lib/payment-methods"

/** 支払管理ページで扱う書類（請求書） */
export interface PaymentDoc {
  id: string
  vendor_name: string
  amount: number | null
  due_date: string | null
  payment_method: string
  bank_info: BankInfo | null
  payment_status: string
  /** 支払方法の最終カテゴリ（マスタ優先で判定済み） */
  category: PaymentCategory
  /** 支払先マスタに登録された支払方法（未登録なら null） */
  master_method: string | null
}

/** 口座振替の支払先マスタ1件 */
export interface VendorMaster {
  vendor_name: string
  method: string
  updated_at: string
}

interface PaymentsClientProps {
  /** 要振込（都度振込）の請求書 */
  payDocs: PaymentDoc[]
  /** 口座振替（振込不要）の請求書 */
  debitDocs: PaymentDoc[]
  /** 支払方法が未確定（要確認）の請求書 */
  unknownDocs: PaymentDoc[]
  vendorMasters: VendorMaster[]
}

/** カードを表示しているセクション */
type Section = "pay" | "debit" | "unknown"

/** 一括再判定の1リクエストあたりの件数（Vercelの実行時間上限に収まるよう小さめに分割する） */
const RECHECK_CHUNK_SIZE = 8

/** 振込先情報を1行の文字列に整形する */
function formatBankInfo(info: BankInfo | null): string {
  if (!info) return ""
  const parts = [
    info.bank_name,
    info.branch_name,
    info.account_type,
    info.account_number,
    info.account_holder,
  ].filter((v) => v && v.trim() !== "")
  return parts.join(" ")
}

/** 支払方法カテゴリバッジの見た目 */
function categoryBadge(category: PaymentCategory): { label: string; bg: string; fg: string } {
  switch (category) {
    case "都度振込":
      return { label: "🏦 都度振込", bg: "#E8D5A8", fg: "#8A5A1A" }
    case "口座振替":
      return { label: "🔁 口座振替", bg: "#DBEAFE", fg: "#1E40AF" }
    case "その他":
      return { label: "その他", bg: "#E5E7EB", fg: "#374151" }
    default:
      return { label: "❓ 要確認", bg: "#FEF3C7", fg: "#B45309" }
  }
}

export function PaymentsClient({
  payDocs,
  debitDocs,
  unknownDocs,
  vendorMasters,
}: PaymentsClientProps) {
  const router = useRouter()

  const [payItems, setPayItems] = useState<PaymentDoc[]>(payDocs)
  const [debitItems, setDebitItems] = useState<PaymentDoc[]>(debitDocs)
  const [unknownItems, setUnknownItems] = useState<PaymentDoc[]>(unknownDocs)
  const [vendorRows, setVendorRows] = useState<VendorMaster[]>(vendorMasters)

  // サーバー側の再取得（router.refresh）結果を画面に反映する
  useEffect(() => setPayItems(payDocs), [payDocs])
  useEffect(() => setDebitItems(debitDocs), [debitDocs])
  useEffect(() => setUnknownItems(unknownDocs), [unknownDocs])
  useEffect(() => setVendorRows(vendorMasters), [vendorMasters])

  const [tab, setTab] = useState<"invoices" | "vendors">("invoices")
  const [debitOpen, setDebitOpen] = useState(false)
  const [unknownOpen, setUnknownOpen] = useState(false)

  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [reanalyzingId, setReanalyzingId] = useState<string | null>(null)
  // 支払先マスタ操作中の支払先名（ボタンのローディング表示用）
  const [vendorBusy, setVendorBusy] = useState<string | null>(null)

  // 一括再判定：確認パネルの表示 / 進捗 / 結果サマリー
  const [recheckConfirm, setRecheckConfirm] = useState(false)
  const [recheckProgress, setRecheckProgress] = useState<{ done: number; total: number } | null>(null)
  const [recheckSummary, setRecheckSummary] = useState<string | null>(null)

  // 要振込（未払い）を支払期限が近い順に並べる（支払済みは後ろ）
  const sortedPay = useMemo(() => {
    return [...payItems].sort((a, b) => {
      const aPaid = a.payment_status === "支払い済み" ? 1 : 0
      const bPaid = b.payment_status === "支払い済み" ? 1 : 0
      if (aPaid !== bPaid) return aPaid - bPaid
      if (!a.due_date && !b.due_date) return 0
      if (!a.due_date) return 1
      if (!b.due_date) return -1
      return new Date(a.due_date).getTime() - new Date(b.due_date).getTime()
    })
  }, [payItems])

  const sortedDebit = useMemo(() => {
    return [...debitItems].sort((a, b) => {
      if (!a.due_date && !b.due_date) return 0
      if (!a.due_date) return 1
      if (!b.due_date) return -1
      return new Date(a.due_date).getTime() - new Date(b.due_date).getTime()
    })
  }, [debitItems])

  // 支払方法が未確定のもの（支払期限が古い順）
  const sortedUnknown = useMemo(() => {
    return [...unknownItems].sort((a, b) => {
      if (!a.due_date && !b.due_date) return 0
      if (!a.due_date) return 1
      if (!b.due_date) return -1
      return new Date(a.due_date).getTime() - new Date(b.due_date).getTime()
    })
  }, [unknownItems])

  // 要振込の未払い合計・件数
  const unpaidTotal = useMemo(
    () =>
      payItems
        .filter((d) => d.payment_status !== "支払い済み")
        .reduce((sum, d) => sum + (d.amount ?? 0), 0),
    [payItems]
  )
  const unpaidCount = payItems.filter((d) => d.payment_status !== "支払い済み").length

  /**
   * 1件の請求書を、判定し直したカテゴリに応じて 要振込 / 口座振替 / 未確定 のリストへ移し替える。
   * 「その他」（カード払い等）はどのリストにも載せない。
   */
  function placeDoc(next: PaymentDoc) {
    const remove = (prev: PaymentDoc[]) => prev.filter((d) => d.id !== next.id)
    setPayItems((prev) => (next.category === "都度振込" ? [...remove(prev), next] : remove(prev)))
    setDebitItems((prev) => (next.category === "口座振替" ? [...remove(prev), next] : remove(prev)))
    setUnknownItems((prev) => (next.category === "要確認" ? [...remove(prev), next] : remove(prev)))
  }

  // 支払状態を切り替え（未払い⇄支払済み）
  async function togglePaid(doc: PaymentDoc, section: Section) {
    const next = doc.payment_status === "支払い済み" ? "未対応" : "支払い済み"
    setUpdatingId(doc.id)
    try {
      const res = await fetch(`/api/documents/${doc.id}/payment-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payment_status: next }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error ?? "支払状態の更新に失敗しました")
      }
      const setter =
        section === "pay" ? setPayItems : section === "debit" ? setDebitItems : setUnknownItems
      setter((prev) =>
        prev.map((d) => (d.id === doc.id ? { ...d, payment_status: next } : d))
      )
      toast.success(next === "支払い済み" ? "支払済みにしました" : "未払いに戻しました")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "支払状態の更新に失敗しました")
    } finally {
      setUpdatingId(null)
    }
  }

  // 1件を再解析して支払方法・振込先を判定し直す
  async function reanalyze(doc: PaymentDoc) {
    setReanalyzingId(doc.id)
    try {
      const res = await fetch(`/api/documents/${doc.id}/reanalyze`, { method: "POST" })
      const json = (await res.json().catch(() => ({}))) as {
        data?: { payment_method?: string | null; bank_info?: BankInfo | null }
        result?: { payment_category?: PaymentCategory }
        error?: string
        reason?: string
      }
      if (!res.ok) {
        throw new Error(json.error ?? "再解析に失敗しました")
      }
      const newMethod = json.data?.payment_method ?? "unknown"
      const newBank = (json.data?.bank_info as BankInfo | null) ?? null

      // サーバー側でマスタ優先の最終カテゴリを返す。無い場合はAIコードから判定（マスタ登録があればそちら優先）
      const newCategory =
        json.result?.payment_category ?? (doc.master_method ? doc.category : codeToCategory(newMethod))

      placeDoc({ ...doc, payment_method: newMethod, bank_info: newBank, category: newCategory })

      if (newCategory === "口座振替") {
        toast.success("口座振替と判定されました（口座振替セクションへ移動）")
      } else if (newCategory === "その他") {
        toast.success("カード払い等と判定されました（支払管理から除外）")
      } else if (newCategory === "都度振込") {
        toast.success("都度振込が必要と判定されました（要振込リストへ）")
      } else {
        toast.warning("再解析しましたが支払方法は判定できませんでした")
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "再解析に失敗しました")
    } finally {
      setReanalyzingId(null)
    }
  }

  /**
   * 支払方法が未確定の請求書をまとめて再判定する。
   * Geminiのレート制限・実行時間上限に配慮して数件ずつに分割して逐次実行する。
   */
  async function recheckAllUnknown() {
    const targets = unknownItems.map((d) => d.id)
    if (targets.length === 0) return

    setRecheckConfirm(false)
    setRecheckSummary(null)
    setRecheckProgress({ done: 0, total: targets.length })

    const totals = { 都度振込: 0, 口座振替: 0, その他: 0, 要確認: 0 }
    let successCount = 0
    let failCount = 0

    try {
      for (let i = 0; i < targets.length; i += RECHECK_CHUNK_SIZE) {
        const chunk = targets.slice(i, i + RECHECK_CHUNK_SIZE)
        try {
          const res = await fetch("/api/documents/reanalyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: chunk }),
          })
          const json = (await res.json().catch(() => ({}))) as {
            successCount?: number
            failCount?: number
            categoryCounts?: Record<string, number>
            error?: string
          }
          if (!res.ok) throw new Error(json.error ?? "再判定に失敗しました")

          successCount += json.successCount ?? 0
          failCount += json.failCount ?? 0
          for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
            totals[key] += json.categoryCounts?.[key] ?? 0
          }
        } catch (error) {
          // 1チャンク失敗しても残りは続行する
          console.error("一括再判定エラー:", error)
          failCount += chunk.length
        }
        setRecheckProgress({ done: Math.min(i + chunk.length, targets.length), total: targets.length })
      }

      setRecheckSummary(
        `${targets.length}件を再判定しました（成功 ${successCount}件 / 失敗 ${failCount}件）。` +
          `内訳: 口座振替 ${totals.口座振替}件 / 都度振込 ${totals.都度振込}件 / ` +
          `その他 ${totals.その他}件 / 未確定のまま ${totals.要確認}件`
      )
      toast.success(`一括再判定が完了しました（口座振替 ${totals.口座振替}件 / 都度振込 ${totals.都度振込}件）`)
      // サーバー側の最新状態（要振込マークを含む）を取り直す
      router.refresh()
    } finally {
      setRecheckProgress(null)
    }
  }

  /** 支払先マスタに支払方法を登録/更新する（口座振替に設定 / 都度振込に戻す） */
  async function setVendorMethod(vendorName: string, method: "口座振替" | "都度振込") {
    if (!vendorName) {
      toast.warning("取引先が不明なため設定できません")
      return
    }
    setVendorBusy(vendorName)
    try {
      const res = await fetch("/api/vendor-payment-methods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor_name: vendorName, method }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        vendor?: VendorMaster
        error?: string
      }
      if (!res.ok) {
        throw new Error(json.error ?? "支払先マスタの更新に失敗しました")
      }
      const updatedAt = json.vendor?.updated_at ?? new Date().toISOString()

      // 当該支払先の請求書（要振込・口座振替・未確定のどこにあっても）をマスタの支払方法へ集約する
      const moved = [...payItems, ...debitItems, ...unknownItems]
        .filter((d) => d.vendor_name === vendorName)
        .map((d) => ({ ...d, category: method as PaymentCategory, master_method: method }))
      const others = (prev: PaymentDoc[]) => prev.filter((d) => d.vendor_name !== vendorName)

      setUnknownItems(others)
      if (method === "口座振替") {
        setPayItems(others)
        setDebitItems((prev) => [...others(prev), ...moved])
        // 支払先マスタ一覧を更新
        setVendorRows((prev) => [
          { vendor_name: vendorName, method: "口座振替", updated_at: updatedAt },
          ...prev.filter((v) => v.vendor_name !== vendorName),
        ])
        toast.success(`「${vendorName}」を口座振替に設定しました（要振込リストから除外）`)
      } else {
        setDebitItems(others)
        setPayItems((prev) => [...others(prev), ...moved])
        // 口座振替一覧からは外す
        setVendorRows((prev) => prev.filter((v) => v.vendor_name !== vendorName))
        toast.success(`「${vendorName}」を都度振込に設定しました（要振込リストへ）`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "支払先マスタの更新に失敗しました")
    } finally {
      setVendorBusy(null)
    }
  }

  /** 支払先マスタの登録を解除（削除）。以降はAI判定に従う */
  async function deleteVendor(vendorName: string) {
    setVendorBusy(vendorName)
    try {
      const res = await fetch(
        `/api/vendor-payment-methods?vendor_name=${encodeURIComponent(vendorName)}`,
        { method: "DELETE" }
      )
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        throw new Error(json.error ?? "支払先マスタの削除に失敗しました")
      }

      // 当該支払先の請求書を、AI判定に基づき再配置する（マスタ優先が外れるため）
      const affected = [...payItems, ...debitItems, ...unknownItems].filter(
        (d) => d.vendor_name === vendorName
      )
      const toDebit: PaymentDoc[] = []
      const toPay: PaymentDoc[] = []
      const toUnknown: PaymentDoc[] = []
      for (const d of affected) {
        const cat = codeToCategory(d.payment_method)
        const updated = { ...d, master_method: null, category: cat }
        if (cat === "口座振替") toDebit.push(updated)
        else if (requiresTransfer(cat)) toPay.push(updated)
        else if (isUnconfirmed(cat)) toUnknown.push(updated)
        // その他はどのリストにも載せない
      }
      const others = (prev: PaymentDoc[]) => prev.filter((d) => d.vendor_name !== vendorName)
      setDebitItems((prev) => [...others(prev), ...toDebit])
      setPayItems((prev) => [...others(prev), ...toPay])
      setUnknownItems((prev) => [...others(prev), ...toUnknown])
      setVendorRows((prev) => prev.filter((v) => v.vendor_name !== vendorName))
      toast.success(`「${vendorName}」の登録を解除しました`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "支払先マスタの削除に失敗しました")
    } finally {
      setVendorBusy(null)
    }
  }

  /** 請求書カード1件を描画 */
  function renderCard(doc: PaymentDoc, section: Section) {
    const isPaid = doc.payment_status === "支払い済み"
    const isUpdating = updatingId === doc.id
    const isReanalyzing = reanalyzingId === doc.id
    const isVendorBusy = vendorBusy === doc.vendor_name
    const isUnknown = doc.category === "要確認"
    const badge = categoryBadge(doc.category)
    const bankText = formatBankInfo(doc.bank_info)

    const daysLeft = doc.due_date
      ? differenceInDays(new Date(doc.due_date), new Date())
      : null
    const isOverdue = !isPaid && section === "pay" && daysLeft !== null && daysLeft < 0
    const isSoon = !isPaid && section === "pay" && daysLeft !== null && daysLeft >= 0 && daysLeft <= 3

    const dueColor = isPaid
      ? "#6B7280"
      : isOverdue
      ? "#DC2626"
      : isSoon
      ? "#D97706"
      : "#4A4A4A"

    return (
      <div
        key={doc.id}
        className="rounded-lg border p-4"
        style={{
          borderColor: isOverdue ? "#DC2626" : isSoon ? "#F59E0B" : "#E5DCC8",
          borderWidth: isOverdue || isSoon ? "2px" : "1px",
          backgroundColor: isPaid
            ? "rgba(243,244,246,0.6)"
            : isOverdue
            ? "rgba(254,226,226,0.5)"
            : isSoon
            ? "rgba(254,243,199,0.5)"
            : "#FFFFFF",
          opacity: isPaid ? 0.85 : 1,
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          {/* 左：取引先・バッジ・期限・振込先 */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="truncate text-sm font-semibold"
                style={{
                  color: "#1A1A1A",
                  textDecoration: isPaid ? "line-through" : "none",
                }}
              >
                {doc.vendor_name || "（取引先不明）"}
              </span>
              <span
                className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                style={{ backgroundColor: badge.bg, color: badge.fg }}
              >
                {badge.label}
              </span>
              {doc.master_method && (
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
                  style={{ backgroundColor: "#EDE9FE", color: "#5B21B6" }}
                  title="支払先マスタで設定済み（AI判定より優先）"
                >
                  設定済み
                </span>
              )}
              {section === "pay" && (
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  style={
                    isPaid
                      ? { backgroundColor: "#059669", color: "#FFFFFF" }
                      : { backgroundColor: "#DC2626", color: "#FFFFFF" }
                  }
                >
                  {isPaid ? "✅ 支払済み" : "⚠️ 未払い"}
                </span>
              )}
            </div>

            {/* 支払期限 */}
            <div
              className="mt-1.5 flex items-center gap-1.5 text-xs"
              style={{ color: dueColor, fontWeight: isOverdue || isSoon ? 700 : 500 }}
            >
              {(isOverdue || isSoon) && <AlertTriangle className="size-3.5" />}
              支払期限:{" "}
              {doc.due_date ? format(new Date(doc.due_date), "yyyy/MM/dd") : "未設定"}
              {!isPaid && section === "pay" && daysLeft !== null && (
                <span>
                  （{daysLeft < 0 ? `${Math.abs(daysLeft)}日超過` : daysLeft === 0 ? "本日" : `残り${daysLeft}日`}）
                </span>
              )}
            </div>

            {/* 振込先（都度振込のみ） */}
            {doc.category === "都度振込" && (
              <div
                className="mt-1.5 rounded-md px-2.5 py-1.5 text-xs"
                style={{ backgroundColor: "#FAF6EC", color: "#5A4A30" }}
              >
                <span className="font-semibold">振込先: </span>
                {bankText || "（振込先情報なし。書類を再解析または詳細で確認してください）"}
              </div>
            )}

            {/* 要確認の注意表示 + 導線（未確定セクションのみ） */}
            {section === "unknown" && isUnknown && (
              <div
                className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md px-2.5 py-1.5 text-xs"
                style={{ backgroundColor: "#FEF3C7", color: "#92400E" }}
              >
                <span className="flex items-center gap-1 font-semibold">
                  <HelpCircle className="size-3.5" />
                  支払方法が未確定です
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  disabled={isReanalyzing}
                  onClick={() => reanalyze(doc)}
                >
                  {isReanalyzing ? (
                    <Loader2 className="mr-1 size-3 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1 size-3" />
                  )}
                  再解析で判定
                </Button>
                <Link href={`/documents/${doc.id}`} className="flex items-center gap-1 underline">
                  <ExternalLink className="size-3" />
                  詳細で確認
                </Link>
              </div>
            )}

            {/* 支払方法の切り替えアクション（支払先マスタに登録して以降を自動で仕分ける） */}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {section !== "debit" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  disabled={isVendorBusy || !doc.vendor_name}
                  onClick={() => setVendorMethod(doc.vendor_name, "口座振替")}
                  title={
                    doc.vendor_name
                      ? "この支払先を口座振替として登録し、要振込リストから除外します（以降の請求書も自動で除外）"
                      : "取引先が不明なため設定できません"
                  }
                >
                  {isVendorBusy ? (
                    <Loader2 className="mr-1 size-3 animate-spin" />
                  ) : (
                    <Repeat className="mr-1 size-3" />
                  )}
                  口座振替に設定
                </Button>
              )}
              {section !== "pay" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  disabled={isVendorBusy || !doc.vendor_name}
                  onClick={() => setVendorMethod(doc.vendor_name, "都度振込")}
                  title={
                    doc.vendor_name
                      ? "この支払先を都度振込として登録し、要振込リストに表示します（以降の請求書も自動で表示）"
                      : "取引先が不明なため設定できません"
                  }
                >
                  {isVendorBusy ? (
                    <Loader2 className="mr-1 size-3 animate-spin" />
                  ) : (
                    <RotateCcw className="mr-1 size-3" />
                  )}
                  {section === "debit" ? "都度振込に戻す" : "都度振込に設定"}
                </Button>
              )}
              <Link
                href={`/documents/${doc.id}`}
                className="flex items-center gap-1 text-xs underline"
                style={{ color: "#8A5A1A" }}
              >
                <ExternalLink className="size-3" />
                詳細で確認
              </Link>
            </div>
          </div>

          {/* 右：金額・支払い完了ボタン（要振込リストのみ） */}
          <div className="flex flex-col items-end gap-2">
            {doc.amount !== null && (
              <div
                className="text-lg font-bold"
                style={{
                  color: isPaid ? "#6B7280" : "#1A1A1A",
                  textDecoration: isPaid ? "line-through" : "none",
                }}
              >
                ¥{doc.amount.toLocaleString()}
              </div>
            )}
            {section === "pay" &&
              (isPaid ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isUpdating}
                  onClick={() => togglePaid(doc, "pay")}
                >
                  {isUpdating ? (
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="mr-1.5 size-3.5" />
                  )}
                  未払いに戻す
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={isUpdating}
                  onClick={() => togglePaid(doc, "pay")}
                  style={{
                    background: "linear-gradient(135deg, #C8922A, #B8782A)",
                    color: "#fff",
                    boxShadow: "0 4px 12px rgba(180,120,40,0.35)",
                  }}
                >
                  {isUpdating ? (
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-1.5 size-3.5" />
                  )}
                  支払い完了
                </Button>
              ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: "#1A1A1A" }}>
          <Wallet className="size-6" style={{ color: "#B8782A" }} />
          支払管理
        </h1>
        <p className="mt-1 text-sm" style={{ color: "#4A4A4A" }}>
          手動で都度振込が必要な請求書だけを要振込リストに表示します（口座振替・自動引落・支払方法が未確定のものは除外）
        </p>
      </div>

      {/* タブ切り替え */}
      <div className="flex flex-wrap gap-2 border-b" style={{ borderColor: "#E5DCC8" }}>
        <button
          onClick={() => setTab("invoices")}
          className="px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors"
          style={{
            borderColor: tab === "invoices" ? "#B8782A" : "transparent",
            color: tab === "invoices" ? "#B8782A" : "#6B7280",
          }}
        >
          <span className="flex items-center gap-1.5">
            <Landmark className="size-4" />
            請求書
          </span>
        </button>
        <button
          onClick={() => setTab("vendors")}
          className="px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors"
          style={{
            borderColor: tab === "vendors" ? "#B8782A" : "transparent",
            color: tab === "vendors" ? "#B8782A" : "#6B7280",
          }}
        >
          <span className="flex items-center gap-1.5">
            <ListChecks className="size-4" />
            口座振替の支払先（{vendorRows.length}）
          </span>
        </button>
      </div>

      {tab === "invoices" ? (
        <>
          {/* 未払い金額の合計 */}
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 py-5">
              <div>
                <div className="text-sm" style={{ color: "#4A4A4A" }}>
                  未払い合計（要振込）
                </div>
                <div className="mt-1 text-3xl font-bold" style={{ color: "#B8782A" }}>
                  ¥{unpaidTotal.toLocaleString()}
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm" style={{ color: "#4A4A4A" }}>
                  未払い件数
                </div>
                <div className="mt-1 text-2xl font-bold" style={{ color: "#1A1A1A" }}>
                  {unpaidCount}件
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 要振込の請求書 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base" style={{ color: "#1A1A1A" }}>
                <Landmark className="size-5" style={{ color: "#B8782A" }} />
                要振込の請求書（支払期限が近い順）
              </CardTitle>
            </CardHeader>
            <CardContent>
              {sortedPay.length === 0 ? (
                <p className="py-10 text-center text-sm" style={{ color: "#4A4A4A" }}>
                  要振込の請求書はありません
                </p>
              ) : (
                <div className="space-y-3">{sortedPay.map((doc) => renderCard(doc, "pay"))}</div>
              )}
            </CardContent>
          </Card>

          {/* 支払方法が未確定の請求書（要振込には載せず、ここで仕分ける） */}
          <Card>
            <CardHeader
              className="cursor-pointer"
              onClick={() => setUnknownOpen((v) => !v)}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className="flex items-center gap-2 text-base" style={{ color: "#1A1A1A" }}>
                  {unknownOpen ? (
                    <ChevronDown className="size-5" style={{ color: "#B45309" }} />
                  ) : (
                    <ChevronRight className="size-5" style={{ color: "#B45309" }} />
                  )}
                  <HelpCircle className="size-5" style={{ color: "#B45309" }} />
                  支払方法が未確定の請求書 — {unknownItems.length}件
                </CardTitle>
                {unknownItems.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    disabled={recheckProgress !== null}
                    onClick={(e) => {
                      e.stopPropagation()
                      setRecheckConfirm(true)
                      setUnknownOpen(true)
                    }}
                    title="未確定の請求書をまとめてAIで再判定します"
                  >
                    {recheckProgress ? (
                      <Loader2 className="mr-1 size-3.5 animate-spin" />
                    ) : (
                      <Wand2 className="mr-1 size-3.5" />
                    )}
                    まとめて再判定
                  </Button>
                )}
              </div>
              <p className="mt-1 text-xs" style={{ color: "#6B7280" }}>
                口座振替か都度振込かをAIが判別できなかった請求書です。要振込リストには含めていません。
                「口座振替に設定」「都度振込に設定」で支払先ごとに登録すると、以降は自動で仕分けされます。
              </p>
            </CardHeader>

            {/* 一括再判定の確認 / 進捗 / 結果（折りたたみ状態に関わらず表示する） */}
            {(recheckConfirm || recheckProgress || recheckSummary) && (
              <CardContent className="pt-0">
                {recheckConfirm && (
                  <div
                    className="rounded-md border p-3 text-sm"
                    style={{ borderColor: "#F59E0B", backgroundColor: "#FFFBEB", color: "#92400E" }}
                  >
                    <p className="font-semibold">
                      {unknownItems.length}件の請求書をAIで再判定します。よろしいですか？
                    </p>
                    <p className="mt-1 text-xs">
                      各書類の原本をDropboxから取得してAI解析をやり直し、支払方法（口座振替／都度振込／カード払い）を判定し直します。
                      支払先マスタに登録済みの支払先はマスタの設定が優先されます。金額・取引先などの抽出結果も最新のAIで更新されます。
                      件数によっては数分かかります。
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" className="h-7 px-3 text-xs" onClick={recheckAllUnknown}>
                        {unknownItems.length}件を再判定する
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-3 text-xs"
                        onClick={() => setRecheckConfirm(false)}
                      >
                        キャンセル
                      </Button>
                    </div>
                  </div>
                )}

                {recheckProgress && (
                  <div
                    className="flex items-center gap-2 rounded-md border p-3 text-sm"
                    style={{ borderColor: "#E5DCC8", backgroundColor: "#FAF6EC", color: "#5A4A30" }}
                  >
                    <Loader2 className="size-4 animate-spin" />
                    再判定中… {recheckProgress.done} / {recheckProgress.total}件
                  </div>
                )}

                {!recheckProgress && recheckSummary && (
                  <div
                    className="rounded-md border p-3 text-sm"
                    style={{ borderColor: "#A7F3D0", backgroundColor: "#ECFDF5", color: "#065F46" }}
                  >
                    {recheckSummary}
                  </div>
                )}
              </CardContent>
            )}

            {unknownOpen && (
              <CardContent>
                {sortedUnknown.length === 0 ? (
                  <p className="py-8 text-center text-sm" style={{ color: "#4A4A4A" }}>
                    支払方法が未確定の請求書はありません
                  </p>
                ) : (
                  <div className="space-y-3">
                    {sortedUnknown.map((doc) => renderCard(doc, "unknown"))}
                  </div>
                )}
              </CardContent>
            )}
          </Card>

          {/* 口座振替（振込不要）の折りたたみセクション */}
          <Card>
            <CardHeader className="cursor-pointer" onClick={() => setDebitOpen((v) => !v)}>
              <CardTitle className="flex items-center gap-2 text-base" style={{ color: "#1A1A1A" }}>
                {debitOpen ? (
                  <ChevronDown className="size-5" style={{ color: "#1E40AF" }} />
                ) : (
                  <ChevronRight className="size-5" style={{ color: "#1E40AF" }} />
                )}
                <Repeat className="size-5" style={{ color: "#1E40AF" }} />
                口座振替（振込不要）— {debitItems.length}件
              </CardTitle>
            </CardHeader>
            {debitOpen && (
              <CardContent>
                {sortedDebit.length === 0 ? (
                  <p className="py-8 text-center text-sm" style={{ color: "#4A4A4A" }}>
                    口座振替の請求書はありません
                  </p>
                ) : (
                  <div className="space-y-3">{sortedDebit.map((doc) => renderCard(doc, "debit"))}</div>
                )}
              </CardContent>
            )}
          </Card>
        </>
      ) : (
        // 口座振替の支払先マスタ一覧
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base" style={{ color: "#1A1A1A" }}>
              <ListChecks className="size-5" style={{ color: "#B8782A" }} />
              口座振替として登録中の支払先（{vendorRows.length}件）
            </CardTitle>
          </CardHeader>
          <CardContent>
            {vendorRows.length === 0 ? (
              <p className="py-10 text-center text-sm" style={{ color: "#4A4A4A" }}>
                口座振替として登録された支払先はありません。
                <br />
                請求書カードの「口座振替に設定」から登録できます。
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b" style={{ borderColor: "#E5DCC8" }}>
                    <tr className="text-left" style={{ color: "#4A4A4A" }}>
                      <th className="px-3 py-2 font-medium">支払先名</th>
                      <th className="px-3 py-2 font-medium">支払方法</th>
                      <th className="px-3 py-2 font-medium">更新日時</th>
                      <th className="px-3 py-2 font-medium text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendorRows.map((v) => {
                      const busy = vendorBusy === v.vendor_name
                      return (
                        <tr key={v.vendor_name} className="border-t" style={{ borderColor: "#EFE8D8" }}>
                          <td className="px-3 py-2 font-medium" style={{ color: "#1A1A1A" }}>
                            {v.vendor_name}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                              style={{ backgroundColor: "#DBEAFE", color: "#1E40AF" }}
                            >
                              🔁 口座振替
                            </span>
                          </td>
                          <td className="px-3 py-2" style={{ color: "#4A4A4A" }}>
                            {v.updated_at ? format(new Date(v.updated_at), "yyyy/MM/dd HH:mm") : "-"}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 px-2.5 text-xs"
                                disabled={busy}
                                onClick={() => setVendorMethod(v.vendor_name, "都度振込")}
                              >
                                {busy ? (
                                  <Loader2 className="mr-1 size-3 animate-spin" />
                                ) : (
                                  <RotateCcw className="mr-1 size-3" />
                                )}
                                都度振込に戻す
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 px-2.5 text-xs"
                                style={{ color: "#DC2626", borderColor: "#FCA5A5" }}
                                disabled={busy}
                                onClick={() => deleteVendor(v.vendor_name)}
                              >
                                {busy ? (
                                  <Loader2 className="mr-1 size-3 animate-spin" />
                                ) : (
                                  <Trash2 className="mr-1 size-3" />
                                )}
                                削除
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
