"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Download,
  FileQuestion,
  History,
  Loader2,
  Plus,
  XCircle,
} from "lucide-react"

type RunType = "range_copy" | "additional_import"

/** range_copy の summary（月別・フォルダ別のコピー結果） */
interface RangeCopyMonthResult {
  year: number
  month: number
  copied: number
  skipped: number
  failed: number
  total: number
  folderBreakdown: Record<string, { copied: number; skipped: number; failed: number }>
  error?: string
}

/** additional_import の summary（月ごとの本体/追加分振り分け結果） */
interface AdditionalImportSummary {
  months: Array<{
    year: number
    month: number
    toBody: number
    toAdditional: number
    skipped: number
    needsReview: number
  }>
  totals: {
    toBody: number
    toAdditional: number
    skipped: number
    needsReview: number
  }
}

interface IssueEntry {
  file_name: string
  reason?: string
  year?: number
  month?: number
  folder?: string
  source?: string
}

interface TaxCopyRunRow {
  id: string
  run_at: string
  run_by: string | null
  run_type: RunType
  period_start: string
  period_end: string
  target_folders: string[]
  summary: unknown
  issues: IssueEntry[] | null
}

const RUN_TYPE_LABEL: Record<RunType, string> = {
  range_copy: "単月/期間指定コピー",
  additional_import: "追加分の一括取り込み",
}

/** 実行日時をわかりやすい表記でフォーマット */
function formatRunAt(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** 対象期間の表示（単月ならその月のみ、期間指定なら開始〜終了） */
function formatPeriod(row: TaxCopyRunRow): string {
  return row.period_start === row.period_end
    ? row.period_start
    : `${row.period_start} 〜 ${row.period_end}`
}

/** 行全体の件数サマリー（合計コピー数など）を run_type ごとに集計 */
function summarizeRow(row: TaxCopyRunRow): string {
  if (row.run_type === "range_copy") {
    const months = (row.summary as RangeCopyMonthResult[] | undefined) ?? []
    const copied = months.reduce((n, m) => n + (m.copied ?? 0), 0)
    const failed = months.reduce((n, m) => n + (m.failed ?? 0), 0)
    return failed > 0 ? `コピー ${copied}件（失敗 ${failed}件）` : `コピー ${copied}件`
  }
  const s = row.summary as AdditionalImportSummary | undefined
  const totals = s?.totals ?? { toBody: 0, toAdditional: 0, skipped: 0, needsReview: 0 }
  const copied = totals.toBody + totals.toAdditional
  return totals.needsReview > 0
    ? `取込 ${copied}件（要確認 ${totals.needsReview}件）`
    : `取込 ${copied}件`
}

/** 提出書類一覧CSVを再ダウンロード（既存のexport-tax-csv APIを再利用） */
function downloadTaxCsv(year: number, month: number) {
  window.location.href = `/api/documents/export-tax-csv?year=${year}&month=${month}`
}

/** 行が対象とした年月一覧（重複を除く）を取り出す */
function monthsTouchedByRow(row: TaxCopyRunRow): Array<{ year: number; month: number }> {
  const raw = row.run_type === "range_copy"
    ? ((row.summary as RangeCopyMonthResult[] | undefined) ?? []).map((m) => ({ year: m.year, month: m.month }))
    : ((row.summary as AdditionalImportSummary | undefined)?.months ?? []).map((m) => ({ year: m.year, month: m.month }))
  const seen = new Set<string>()
  return raw.filter((m) => {
    const key = `${m.year}-${m.month}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export default function TaxCopyHistoryPage() {
  const [rows, setRows] = useState<TaxCopyRunRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    async function fetchHistory() {
      setIsLoading(true)
      setError(null)
      try {
        const res = await fetch("/api/documents/tax-copy-runs")
        const json = await res.json() as { data?: TaxCopyRunRow[]; error?: string }
        if (!res.ok) throw new Error(json.error || "履歴の取得に失敗しました")
        setRows(json.data ?? [])
      } catch (err) {
        setError(err instanceof Error ? err.message : "エラーが発生しました")
      } finally {
        setIsLoading(false)
      }
    }
    fetchHistory()
  }, [])

  function toggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? null : id))
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <History className="size-7 text-primary" />
          <h1 className="text-2xl font-bold">税理士提出の実行履歴</h1>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/documents">
            <ArrowLeft className="mr-1.5 size-3.5" />
            書類一覧へ戻る
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            実行履歴はまだありません。「税理士フォルダへ一括コピー」または「追加分をまとめて取り込む」を実行すると、ここに記録されます。
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const isExpanded = expandedId === row.id
            return (
              <Card key={row.id}>
                <button
                  type="button"
                  onClick={() => toggleExpand(row.id)}
                  className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
                >
                  {isExpanded ? (
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="text-sm font-medium whitespace-nowrap">
                    {formatRunAt(row.run_at)}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs whitespace-nowrap">
                    {RUN_TYPE_LABEL[row.run_type]}
                  </span>
                  <span className="text-sm text-muted-foreground whitespace-nowrap">
                    {formatPeriod(row)}
                  </span>
                  <span className="text-sm font-medium whitespace-nowrap ml-auto">
                    {summarizeRow(row)}
                  </span>
                  {row.run_by && (
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {row.run_by}
                    </span>
                  )}
                </button>

                {isExpanded && (
                  <CardContent className="border-t pt-4">
                    {row.run_type === "range_copy" ? (
                      <RangeCopyDetail months={(row.summary as RangeCopyMonthResult[] | undefined) ?? []} />
                    ) : (
                      <AdditionalImportDetail
                        summary={
                          (row.summary as AdditionalImportSummary | undefined) ?? {
                            months: [],
                            totals: { toBody: 0, toAdditional: 0, skipped: 0, needsReview: 0 },
                          }
                        }
                      />
                    )}

                    {row.issues && row.issues.length > 0 && (
                      <div className="mt-4 space-y-2">
                        <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                          <AlertTriangle className="size-4" />
                          失敗・要確認: {row.issues.length}件
                        </div>
                        <div className="rounded-md border max-h-[30vh] overflow-y-auto">
                          <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-background border-b">
                              <tr className="text-left">
                                <th className="px-3 py-2 font-medium">ファイル名</th>
                                <th className="px-3 py-2 font-medium">理由</th>
                              </tr>
                            </thead>
                            <tbody>
                              {row.issues.map((issue, i) => (
                                <tr key={i} className="border-t">
                                  <td className="px-3 py-1.5 max-w-[220px] truncate">
                                    {issue.file_name}
                                  </td>
                                  <td className="px-3 py-1.5 text-muted-foreground">
                                    {issue.reason ?? "-"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    <UnclearFilesPanel months={monthsTouchedByRow(row)} />
                  </CardContent>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 単月/期間指定コピーの詳細（月別・フォルダ別内訳 + CSV再ダウンロード） */
function RangeCopyDetail({ months }: { months: RangeCopyMonthResult[] }) {
  if (months.length === 0) {
    return <p className="text-sm text-muted-foreground">対象月のデータがありません</p>
  }
  return (
    <div className="space-y-2">
      {months.map((r) => {
        const folderEntries = Object.entries(r.folderBreakdown ?? {})
          .filter(([, c]) => c.copied > 0 || c.failed > 0)
          .sort((a, b) => b[1].copied - a[1].copied)
        return (
          <div key={`${r.year}-${r.month}`} className="rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">
                {r.year}年{String(r.month).padStart(2, "0")}月
              </div>
              {r.error ? (
                <span className="inline-flex items-center gap-1 text-xs text-red-600">
                  <XCircle className="size-3.5" /> {r.error}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  コピー {r.copied} / スキップ {r.skipped} / 失敗 {r.failed}
                </span>
              )}
            </div>
            {!r.error && folderEntries.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {folderEntries.map(([folder, c]) => (
                  <span
                    key={folder}
                    className="rounded-full bg-muted px-2 py-0.5 text-[11px]"
                    title={`${folder}: コピー${c.copied} / スキップ${c.skipped} / 失敗${c.failed}`}
                  >
                    {folder} {c.copied}
                    {c.failed > 0 ? <span className="text-red-600">（失敗{c.failed}）</span> : null}
                  </span>
                ))}
              </div>
            )}
            {!r.error && (r.copied > 0 || r.skipped > 0) && (
              <button
                type="button"
                onClick={() => downloadTaxCsv(r.year, r.month)}
                className="mt-2 inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2"
              >
                <Download className="size-3" />
                提出書類一覧CSVを再ダウンロード
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 追加分の一括取り込みの詳細（月別内訳 + CSV再ダウンロード） */
function AdditionalImportDetail({ summary }: { summary: AdditionalImportSummary }) {
  if (summary.months.length === 0) {
    return <p className="text-sm text-muted-foreground">対象月のデータがありません</p>
  }
  return (
    <div className="rounded-md border max-h-[40vh] overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-background border-b">
          <tr className="text-left">
            <th className="px-3 py-2 font-medium">年月</th>
            <th className="px-3 py-2 font-medium text-right">本体へ</th>
            <th className="px-3 py-2 font-medium text-right">追加分へ</th>
            <th className="px-3 py-2 font-medium text-right">スキップ</th>
            <th className="px-3 py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {summary.months.map((m, i) => (
            <tr key={i} className="border-t">
              <td className="px-3 py-1.5">
                {m.year}年{String(m.month).padStart(2, "0")}月
              </td>
              <td className="px-3 py-1.5 text-right">{m.toBody}</td>
              <td className="px-3 py-1.5 text-right">
                {m.toAdditional > 0 ? (
                  <span className="text-amber-700 dark:text-amber-400 font-medium">
                    {m.toAdditional}
                  </span>
                ) : (
                  0
                )}
              </td>
              <td className="px-3 py-1.5 text-right text-muted-foreground">{m.skipped}</td>
              <td className="px-3 py-1.5">
                {(m.toBody > 0 || m.toAdditional > 0) && (
                  <button
                    type="button"
                    onClick={() => downloadTaxCsv(m.year, m.month)}
                    className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2"
                  >
                    <Download className="size-3" />
                    CSV
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface UnclearFile {
  fileName: string
  path: string
  year: number
  month: number
}

/**
 * 内容不明（DB未登録）ファイルと新旧フォルダ構造の重複除外件数を、
 * 表示時に最新ロジックで再判定して表示する。
 * 過去の実行履歴（保存済みsummary）にはこの情報が無いため、対象月ごとに
 * /api/documents/tax-folder-unclear を呼んで都度算出する（展開時のみ）。
 */
function UnclearFilesPanel({ months }: { months: Array<{ year: number; month: number }> }) {
  const [isLoading, setIsLoading] = useState(true)
  const [files, setFiles] = useState<UnclearFile[]>([])
  const [duplicatesRemoved, setDuplicatesRemoved] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function fetchUnclear() {
      setIsLoading(true)
      try {
        const results = await Promise.all(
          months.map(async (m) => {
            const res = await fetch(`/api/documents/tax-folder-unclear?year=${m.year}&month=${m.month}`)
            if (!res.ok) return { needsReviewFiles: [], duplicatesRemoved: 0 }
            const json = await res.json() as {
              data?: { needsReviewFiles: Array<{ fileName: string; path: string }>; duplicatesRemoved: number }
            }
            return {
              needsReviewFiles: (json.data?.needsReviewFiles ?? []).map((f) => ({ ...f, year: m.year, month: m.month })),
              duplicatesRemoved: json.data?.duplicatesRemoved ?? 0,
            }
          })
        )
        if (cancelled) return
        setFiles(results.flatMap((r) => r.needsReviewFiles))
        setDuplicatesRemoved(results.reduce((n, r) => n + r.duplicatesRemoved, 0))
      } catch {
        if (!cancelled) {
          setFiles([])
          setDuplicatesRemoved(0)
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    if (months.length > 0) {
      fetchUnclear()
    } else {
      setIsLoading(false)
    }
    return () => {
      cancelled = true
    }
  }, [months])

  if (isLoading) {
    return (
      <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        内容不明ファイルを確認中...
      </div>
    )
  }

  if (files.length === 0 && duplicatesRemoved === 0) return null

  return (
    <div className="mt-4 space-y-2">
      {duplicatesRemoved > 0 && (
        <p className="text-xs text-muted-foreground">
          （新旧フォルダ構造の重複を除外: {duplicatesRemoved}件）
        </p>
      )}
      {files.length > 0 && (
        <>
          <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
            <FileQuestion className="size-4" />
            内容不明ファイル（{files.length}件） — DBに書類レコードが見つかりません
          </div>
          <div className="rounded-md border max-h-[30vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background border-b">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">ファイル名</th>
                  <th className="px-3 py-2 font-medium">対象月</th>
                  <th className="px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {files.map((f, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-3 py-1.5 max-w-[220px] truncate" title={f.path}>
                      {f.fileName}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">
                      {f.year}年{String(f.month).padStart(2, "0")}月
                    </td>
                    <td className="px-3 py-1.5">
                      <Button variant="ghost" size="sm" asChild className="h-6 gap-1 text-xs">
                        <Link href="/documents/new">
                          <Plus className="size-3" />
                          書類登録へ
                        </Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
