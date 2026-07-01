"use client"

import { useMemo, useState, type ComponentProps } from "react"
import Link from "next/link"
import { ArrowLeft, Loader2, RotateCcw, Upload, CheckCircle2, XCircle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import { FileDropzone } from "@/components/documents/file-dropzone"
import { toast } from "sonner"

/** 取込カテゴリ（種別）とその既定取引先名 */
const INGEST_CATEGORIES = [
  { value: "返金", defaultVendor: "" },
  { value: "自動精算機データ", defaultVendor: "自動精算機" },
] as const

type Category = (typeof INGEST_CATEGORIES)[number]["value"]

/** FileDropzone が扱うファイル型に合わせる */
type UploadedFile = ComponentProps<typeof FileDropzone>["files"][number]

interface IngestResult {
  file_name: string
  status: "success" | "failed"
  message?: string
  vendor?: string
  date?: string
}

/** 画像/PDFか（AIで日付・取引先・金額を抽出する対象） */
function isImageOrPdf(mimeType: string, name: string): boolean {
  if (mimeType.startsWith("image/") || mimeType === "application/pdf") return true
  const ext = name.split(".").pop()?.toLowerCase()
  return ["jpg", "jpeg", "png", "heic", "webp", "pdf"].includes(ext ?? "")
}

/** YYYY-MM-DD が対象年月の範囲内か */
function isDateInMonth(date: string, year: number, month: number): boolean {
  const m = date.match(/^(\d{4})-(\d{2})/)
  if (!m) return false
  return Number(m[1]) === year && Number(m[2]) === month
}

// 返金・自動精算機データの取込ページ
// 画像/PDF/CSV・手動アップロードに対応。ソースフォルダ（/経理書類/{種別}/YYYY年/MM月/）に保存し、
// 税理士提出の一括コピー／追加分取込で自動的に対応サブフォルダへ振り分けられる。
export default function IngestPage() {
  const now = new Date()
  const [category, setCategory] = useState<Category>("返金")
  const [year, setYear] = useState<number>(now.getFullYear())
  const [month, setMonth] = useState<number>(now.getMonth() + 1)
  const [vendor, setVendor] = useState<string>("")
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [results, setResults] = useState<IngestResult[]>([])

  const defaultVendor = useMemo(
    () => INGEST_CATEGORIES.find((c) => c.value === category)?.defaultVendor ?? "",
    [category]
  )

  // カテゴリ変更時に取引先の既定値を反映
  function handleCategoryChange(next: string) {
    const cat = next as Category
    setCategory(cat)
    setVendor(INGEST_CATEGORIES.find((c) => c.value === cat)?.defaultVendor ?? "")
  }

  // 1ファイルを取り込む
  async function ingestOne(file: UploadedFile): Promise<IngestResult> {
    const monthStr = String(month).padStart(2, "0")
    // 既定の対象日（対象年月の1日）。画像/PDFはAIの発行日を優先する
    const fallbackDate = `${year}-${monthStr}-01`

    let issueDate = fallbackDate
    let vendorName = vendor.trim() || defaultVendor
    let amount: number | null = null
    let description: string | null = null
    let taxCategory = "未判定"
    let accountTitle = ""
    let ocrRaw: unknown = null
    let items: unknown[] = []

    // 画像/PDFはAIで日付・取引先・金額を抽出（CSVはそのまま格納・OCRしない）
    if (isImageOrPdf(file.mimeType, file.name)) {
      try {
        const aiRes = await fetch("/api/gemini", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base64: file.base64,
            mimeType: file.mimeType,
            fileName: file.name,
          }),
        })
        if (aiRes.ok) {
          const aiJson = (await aiRes.json()) as {
            data?: {
              vendor_name?: string | null
              amount?: number | null
              issue_date?: string | null
              description?: string | null
              tax_category?: string | null
              account_title?: string | null
              items?: unknown[]
            }
          }
          const d = aiJson.data
          if (d) {
            ocrRaw = d
            items = Array.isArray(d.items) ? d.items : []
            // 発行日は対象年月内のときのみ採用（月ズレ防止）。それ以外は選択年月を使う
            if (typeof d.issue_date === "string" && isDateInMonth(d.issue_date, year, month)) {
              issueDate = d.issue_date
            }
            if (!vendor.trim() && typeof d.vendor_name === "string" && d.vendor_name) {
              vendorName = d.vendor_name
            }
            if (typeof d.amount === "number") amount = d.amount
            if (typeof d.description === "string") description = d.description
            if (typeof d.tax_category === "string" && d.tax_category) taxCategory = d.tax_category
            if (typeof d.account_title === "string") accountTitle = d.account_title
          }
        }
      } catch {
        // AI失敗時は選択年月・既定取引先で続行
      }
    }

    if (!vendorName) vendorName = category

    // 1. Dropboxにアップロード（/経理書類/{種別}/YYYY年/MM月/未処理/...）
    const uploadRes = await fetch("/api/dropbox/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base64: file.base64,
        fileName: file.name,
        type: category,
        date: issueDate,
        status: "未処理",
        vendorName,
      }),
    })
    if (!uploadRes.ok) {
      const err = (await uploadRes.json().catch(() => ({}))) as { error?: string }
      throw new Error(err.error || "Dropboxへのアップロードに失敗しました")
    }
    const { data: uploadData } = (await uploadRes.json()) as {
      data: { path: string; file_hash: string }
    }

    // 2. DBに書類レコードを作成
    const docRes = await fetch("/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: category,
        vendor_name: vendorName,
        amount,
        issue_date: issueDate,
        due_date: null,
        description,
        input_method: "upload",
        dropbox_path: uploadData.path,
        ocr_raw: ocrRaw,
        tax_category: taxCategory,
        account_title: accountTitle,
        file_hash: uploadData.file_hash,
        items,
        skip_duplicate_check: true,
      }),
    })
    if (!docRes.ok) {
      const err = (await docRes.json().catch(() => ({}))) as { error?: string }
      throw new Error(err.error || "書類の登録に失敗しました")
    }

    return {
      file_name: file.name,
      status: "success",
      vendor: vendorName,
      date: issueDate,
    }
  }

  async function handleSubmit() {
    if (files.length === 0) {
      toast.warning("ファイルを選択してください")
      return
    }
    setIsSubmitting(true)
    setResults([])
    const collected: IngestResult[] = []
    try {
      for (const file of files) {
        try {
          collected.push(await ingestOne(file))
        } catch (error) {
          collected.push({
            file_name: file.name,
            status: "failed",
            message: error instanceof Error ? error.message : "取込に失敗しました",
          })
        }
      }
      setResults(collected)
      const ok = collected.filter((r) => r.status === "success").length
      const ng = collected.length - ok
      if (ng === 0) {
        toast.success(`${ok}件を取り込みました`)
        setFiles([])
      } else {
        toast.warning(`成功 ${ok}件 / 失敗 ${ng}件`)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/documents">
            <ArrowLeft className="size-4" />
            書類一覧へ戻る
          </Link>
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Upload className="size-6" />
          返金・自動精算機データの取込
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          スキャン画像／PDF・CSV・手動アップロードに対応。保存後、税理士提出の一括コピー／追加分取込で
          各月の「返金／自動精算機データ」フォルダへ自動で振り分けられます。
        </p>
      </div>

      {/* 入力フォーム */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">取込設定</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>種別</Label>
            <Select value={category} onValueChange={handleCategoryChange}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INGEST_CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label>対象年</Label>
              <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                <SelectTrigger className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 6 }, (_, i) => now.getFullYear() - 4 + i).map((y) => (
                    <SelectItem key={y} value={String(y)}>
                      {y}年
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>対象月</Label>
              <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
                <SelectTrigger className="w-[100px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {m}月
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            CSV（自動精算機データ等）は指定した対象年月に保存します。画像／PDFは書類の日付をAIが読み取り、
            対象年月内であればその日付を使います（判定できない場合は指定年月）。
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="vendor">取引先名（任意）</Label>
            <Input
              id="vendor"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              placeholder={defaultVendor || "（AIが自動判定／未入力可）"}
            />
          </div>

          <div className="space-y-1.5">
            <Label>ファイル</Label>
            <FileDropzone files={files} onFilesChange={setFiles} />
          </div>

          <Button onClick={handleSubmit} disabled={isSubmitting || files.length === 0} className="w-full">
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                取込中...
              </>
            ) : (
              <>
                <Upload className="mr-2 size-4" />
                取り込む（{files.length}件）
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* 結果 */}
      {results.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">取込結果</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {results.map((r, i) => (
                <div key={i} className="flex items-start gap-2 rounded-md border p-2.5 text-sm">
                  {r.status === "success" ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-600" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-red-600" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate font-medium">{r.file_name}</div>
                    {r.status === "success" ? (
                      <div className="text-xs text-muted-foreground">
                        {category} ／ {r.date}
                        {r.vendor ? ` ／ ${r.vendor}` : ""}
                      </div>
                    ) : (
                      <div className="text-xs text-red-600">{r.message}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex justify-end">
              <Button variant="outline" size="sm" onClick={() => setResults([])}>
                <RotateCcw className="mr-1.5 size-3.5" />
                結果をクリア
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
