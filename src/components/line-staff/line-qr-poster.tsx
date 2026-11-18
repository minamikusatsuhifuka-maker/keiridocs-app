"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Copy, Loader2, Printer, QrCode, RefreshCw } from "lucide-react"

/**
 * スタッフに配る「友だち追加」のQR案内。
 *
 * 紙に印刷して休憩室に貼る使い方を想定し、印刷すると
 * QRと手順だけが出るようにしている（画面のボタン類は印刷されない）。
 *
 * アカウントのIDはLINEから取得する。手で控えて貼り間違えると、
 * 誰も登録できない案内が貼られたままになるため。
 */

interface QrData {
  basicId: string
  displayName: string
  addUrl: string
  svg: string
}

export function LineQrPoster() {
  const [data, setData] = useState<QrData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/line/qr")
      const json = (await res.json().catch(() => ({}))) as Partial<QrData> & { error?: string }
      if (!res.ok) throw new Error(json.error || "QRコードを取得できませんでした")
      setData(json as QrData)
    } catch (e) {
      setError(e instanceof Error ? e.message : "QRコードを取得できませんでした")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function copyUrl() {
    if (!data) return
    try {
      await navigator.clipboard.writeText(data.addUrl)
      toast.success("友だち追加のURLをコピーしました")
    } catch {
      toast.info(data.addUrl, { description: "長押しでコピーしてください", duration: 8000 })
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3 print:hidden">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <QrCode className="size-4" />
          友だち追加のQRコード
        </CardTitle>
        <CardDescription>
          スタッフに配る案内です。印刷すると<strong>QRと手順だけ</strong>が出ます。
          休憩室に貼る、朝礼で見せる、画像で送る、どの使い方でも構いません。
          <br />
          スマホのLINEで読み取ると、申請用のアカウントが友だちに追加されます。
        </CardDescription>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm" style={{ color: "var(--muted-foreground)" }}>
            <Loader2 className="size-4 animate-spin" />
            読み込み中…
          </div>
        ) : error ? (
          <div className="flex flex-col gap-3 print:hidden">
            <p className="text-sm text-destructive">{error}</p>
            <div>
              <Button size="sm" variant="outline" onClick={load}>
                <RefreshCw className="size-3.5" />
                もう一度試す
              </Button>
            </div>
          </div>
        ) : data ? (
          <div className="flex flex-col gap-4">
            {/* 印刷される部分 */}
            <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 rounded-lg border p-6 text-center">
              <p className="text-lg font-bold">経費の申請はLINEから</p>
              <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
                スマホのLINEでこのQRコードを読み取って、
                <br />
                友だちに追加してください。
              </p>

              <div
                className="w-[260px] max-w-full [&>svg]:h-auto [&>svg]:w-full"
                // QRはサーバーで作ったSVG。外部から文字列は入らない
                dangerouslySetInnerHTML={{ __html: data.svg }}
              />

              <p className="font-mono text-sm font-bold">{data.basicId}</p>
              {data.displayName && (
                <p className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                  {data.displayName}
                </p>
              )}

              <div className="w-full text-left text-sm leading-relaxed">
                <p className="mb-1 font-bold">使い方</p>
                <ol className="ml-5 list-decimal space-y-1">
                  <li>友だち追加のあと、画面の案内にそってお名前を登録します</li>
                  <li>下のメニューの「申請する」を押します</li>
                  <li>領収書やICカードの利用履歴の写真を送るだけです</li>
                </ol>
                <p className="mt-3 text-xs" style={{ color: "var(--muted-foreground)" }}>
                  毎月20日締めです。20日までに完了した分が、その月のお給与に入ります。
                  <br />
                  分からないことは「問い合わせ」から担当にご連絡ください。
                </p>
              </div>
            </div>

            {/* 画面だけに出る操作 */}
            <div className="flex flex-wrap gap-2 print:hidden">
              <Button size="sm" onClick={() => window.print()}>
                <Printer className="size-3.5" />
                印刷する
              </Button>
              <Button size="sm" variant="outline" onClick={copyUrl}>
                <Copy className="size-3.5" />
                追加用のURLをコピー
              </Button>
              <Button size="sm" variant="ghost" onClick={load}>
                <RefreshCw className="size-3.5" />
                作り直す
              </Button>
            </div>
            <p className="text-xs print:hidden" style={{ color: "var(--muted-foreground)" }}>
              URLをコピーすると、LINEやメールで直接送れます（QRを読み取れない方向け）。
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
