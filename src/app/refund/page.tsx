"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Loader2, RefreshCw, Upload, RotateCcw } from "lucide-react"
import { toast } from "sonner"

interface RefundRecord {
  id: string
  patient_name: string | null
  amount: number | null
  cancel_date: string | null
  refund_date: string | null
  service_name: string | null
  staff_name: string | null
  status: string
  dropbox_path: string | null
  created_at: string
}

interface OcrPreview {
  patient_name: string
  amount: number | null
  cancel_date: string
  refund_date: string
  service_name: string
  staff_name: string
}

export default function RefundPage() {
  const [isDragOver, setIsDragOver] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isRegistering, setIsRegistering] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<OcrPreview | null>(null)
  const [base64, setBase64] = useState<string>("")
  const [records, setRecords] = useState<RefundRecord[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  // 返金一覧を取得
  const fetchRecords = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch("/api/refund")
      const json = await res.json() as { data?: RefundRecord[]; error?: string }
      if (json.data) setRecords(json.data)
    } catch {
      toast.error("一覧の取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { fetchRecords() }, [fetchRecords])

  // ファイルを選択してAI解析（DB登録はしない）
  async function analyzeFile(file: File) {
    const ext = file.name.split(".").pop()?.toLowerCase()
    if (!["pdf", "jpg", "jpeg", "png", "heic", "webp"].includes(ext ?? "")) {
      toast.error("PDF・JPG・PNGのみ対応しています")
      return
    }

    setIsAnalyzing(true)
    setPreview(null)

    try {
      const reader = new FileReader()
      const b64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      setBase64(b64)
      setSelectedFile(file)

      // APIでAI解析（analyzeモード: 登録せず解析のみ）
      const res = await fetch("/api/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: b64,
          filename: file.name,
          contentType: file.type || `image/${ext}`,
          mode: "analyze",
        }),
      })
      const json = await res.json() as {
        ocr_result?: {
          vendor_name?: string
          amount?: number | null
          issue_date?: string | null
          due_date?: string | null
          description?: string | null
        }
        error?: string
        skipped?: boolean
        reason?: string
      }

      if (json.skipped) {
        toast.warning(json.reason ?? "重複ファイルです")
        return
      }
      if (json.error) throw new Error(json.error)

      const ocr = json.ocr_result ?? {}
      setPreview({
        patient_name: ocr.vendor_name ?? "",
        amount: ocr.amount ?? null,
        cancel_date: ocr.issue_date ?? "",
        refund_date: ocr.due_date ?? "",
        service_name: "",
        staff_name: "",
      })
      toast.success("AI解析完了！内容を確認・修正してから登録してください")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "解析に失敗しました")
    } finally {
      setIsAnalyzing(false)
    }
  }

  // 登録実行（Dropbox保存・DB登録・メール送信）
  async function handleRegister() {
    if (!selectedFile || !base64 || !preview) return
    setIsRegistering(true)

    try {
      const res = await fetch("/api/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: base64,
          filename: selectedFile.name,
          contentType: selectedFile.type,
          patient_name: preview.patient_name,
          amount: preview.amount,
          cancel_date: preview.cancel_date,
          refund_date: preview.refund_date,
          service_name: preview.service_name,
          staff_name: preview.staff_name,
        }),
      })
      const json = await res.json() as {
        data?: RefundRecord
        mail_sent?: boolean
        mail_error?: string
        error?: string
        skipped?: boolean
        reason?: string
      }

      if (json.skipped) { toast.warning(json.reason ?? "重複"); return }
      if (json.error) throw new Error(json.error)

      toast.success(
        json.mail_sent
          ? "✅ 返金登録完了！アラートメールを送信しました"
          : `✅ 返金登録完了（メール: ${json.mail_error ?? "未送信"}）`
      )

      setSelectedFile(null)
      setPreview(null)
      setBase64("")
      fetchRecords()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "登録に失敗しました")
    } finally {
      setIsRegistering(false)
    }
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault(); e.stopPropagation(); setIsDragOver(true)
  }
  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault(); e.stopPropagation(); setIsDragOver(false)
  }
  async function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault(); e.stopPropagation(); setIsDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) await analyzeFile(file)
  }
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) await analyzeFile(file)
    e.target.value = ""
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <RotateCcw className="size-7 text-primary" />
        <h1 className="text-2xl font-bold">返金管理</h1>
      </div>

      {/* アップロードカード */}
      <Card>
        <CardHeader>
          <CardTitle>解約返金資料のアップロード</CardTitle>
          <CardDescription>
            継続的役務契約の解約返金資料（PDF・JPG・PNG）をアップロードすると、
            AIが返金情報を自動抽出してDropboxに保存し、担当者にアラートメールを送信します。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* ドロップゾーン */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => !isAnalyzing && inputRef.current?.click()}
            className={[
              "flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-8 transition cursor-pointer",
              isDragOver ? "border-[#A0703A] bg-[#F5EFE6] scale-[1.01]" : "border-[#E0CEB8] bg-[#FAF7F0] hover:bg-[#F5EFE6]",
              isAnalyzing ? "opacity-60 cursor-not-allowed" : "",
            ].join(" ")}
          >
            {isAnalyzing ? (
              <>
                <Loader2 className="size-8 animate-spin text-[#A0703A]" />
                <span className="text-sm text-[#8B5E2F]">AI解析中...</span>
              </>
            ) : isDragOver ? (
              <>
                <Upload className="size-8 text-[#A0703A]" />
                <span className="text-sm font-medium text-[#A0703A]">ここでドロップ！</span>
              </>
            ) : (
              <>
                <Upload className="size-8 text-[#A0703A]" />
                <span className="text-sm font-medium text-[#8B5E2F]">
                  クリックまたはドロップして返金資料をアップロード
                </span>
                <span className="text-xs text-[#A0703A]/70">PDF・JPG・PNG対応</span>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.heic,.webp"
              className="hidden"
              disabled={isAnalyzing}
              onChange={handleFileChange}
            />
          </div>

          {/* AI解析結果プレビュー・編集フォーム */}
          {preview && (
            <div className="rounded-lg border border-[#E0CEB8] bg-white/60 p-5 space-y-4">
              <p className="text-sm font-semibold text-[#8B5E2F]">
                📋 AI解析結果 — 内容を確認・修正して「返金登録」を押してください
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs text-[#8B5E2F]">患者名・顧客名</Label>
                  <Input
                    value={preview.patient_name}
                    onChange={(e) => setPreview({ ...preview, patient_name: e.target.value })}
                    placeholder="例: 山田 花子"
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-[#8B5E2F]">返金金額（円）</Label>
                  <Input
                    type="number"
                    value={preview.amount ?? ""}
                    onChange={(e) => setPreview({ ...preview, amount: e.target.value ? Number(e.target.value) : null })}
                    placeholder="例: 50000"
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-[#8B5E2F]">解約日</Label>
                  <Input
                    type="date"
                    value={preview.cancel_date}
                    onChange={(e) => setPreview({ ...preview, cancel_date: e.target.value })}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-[#8B5E2F]">返金日</Label>
                  <Input
                    type="date"
                    value={preview.refund_date}
                    onChange={(e) => setPreview({ ...preview, refund_date: e.target.value })}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-[#8B5E2F]">契約内容・サービス名</Label>
                  <Input
                    value={preview.service_name}
                    onChange={(e) => setPreview({ ...preview, service_name: e.target.value })}
                    placeholder="例: 脱毛コース 全身30回"
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-[#8B5E2F]">担当者名</Label>
                  <Input
                    value={preview.staff_name}
                    onChange={(e) => setPreview({ ...preview, staff_name: e.target.value })}
                    placeholder="例: 楠葉"
                    className="h-8 text-sm"
                  />
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <Button
                  onClick={handleRegister}
                  disabled={isRegistering}
                  className="gap-2 bg-gradient-to-r from-[#D4A860] to-[#C090C0] text-white hover:opacity-90"
                >
                  {isRegistering ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                  {isRegistering ? "登録中..." : "返金登録 & メール送信"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => { setPreview(null); setSelectedFile(null); setBase64("") }}
                  disabled={isRegistering}
                >
                  キャンセル
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 返金一覧 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>返金記録一覧</CardTitle>
            <CardDescription>登録済みの解約返金記録</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={fetchRecords} className="gap-1">
            <RefreshCw className="size-3.5" />
            更新
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-6 animate-spin text-[#A0703A]" />
            </div>
          ) : records.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              返金記録がありません
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>患者名</TableHead>
                  <TableHead className="text-right">返金金額</TableHead>
                  <TableHead>解約日</TableHead>
                  <TableHead>返金日</TableHead>
                  <TableHead>サービス名</TableHead>
                  <TableHead>担当者</TableHead>
                  <TableHead>ステータス</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.patient_name ?? "-"}</TableCell>
                    <TableCell className="text-right">
                      {r.amount !== null ? `¥${r.amount.toLocaleString()}` : "-"}
                    </TableCell>
                    <TableCell>{r.cancel_date ?? "-"}</TableCell>
                    <TableCell>{r.refund_date ?? "-"}</TableCell>
                    <TableCell className="max-w-[160px] truncate">{r.service_name ?? "-"}</TableCell>
                    <TableCell>{r.staff_name ?? "-"}</TableCell>
                    <TableCell>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        r.status === "完了" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
                      }`}>
                        {r.status}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
