"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Check, Loader2, MessageCircle, RefreshCw, Send, Undo2 } from "lucide-react"

/**
 * スタッフからの問い合わせ一覧。
 *
 * これまでは担当のLINEへ送るだけで、アプリには何も残らなかった。
 * 担当が見落とすとどこにも残らず消えてしまうため、ここで追えるようにする。
 *
 * **この場で返信できる**ようにしている。
 * 返信ボタンがスタッフの「詳細」の中にしか無く、探しにくかったため。
 */

interface Inquiry {
  staffMemberId: string
  staffName: string
  payrollName: string | null
  isTest: boolean
  retired: boolean
  at: string
  text: string
  doneAt: string | null
  doneBy: string | null
  lastRepliedAt: string | null
}

const jst = (iso: string) =>
  new Date(iso).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })

export function InquiryList() {
  const [items, setItems] = useState<Inquiry[]>([])
  const [loading, setLoading] = useState(true)
  const [showDone, setShowDone] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/line/inquiries")
      const json = (await res.json().catch(() => ({}))) as { items?: Inquiry[]; error?: string }
      if (!res.ok) throw new Error(json.error || "取得できませんでした")
      setItems(json.items ?? [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "取得できませんでした")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function setDone(q: Inquiry, done: boolean) {
    setBusy(q.at)
    try {
      const res = await fetch("/api/line/inquiries", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffMemberId: q.staffMemberId, at: q.at, done }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || "保存できませんでした")
      toast.success(done ? "対応済みにしました" : "未対応に戻しました")
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存できませんでした")
    } finally {
      setBusy(null)
    }
  }

  /** 返信を送り、そのまま対応済みにする（二度手間を避ける） */
  async function reply(q: Inquiry) {
    const text = replyText.trim()
    if (!text) {
      toast.error("返信の内容を入力してください")
      return
    }
    setBusy(q.at)
    try {
      const res = await fetch("/api/line/notify-staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffMemberId: q.staffMemberId, text }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || "送信できませんでした")

      await fetch("/api/line/inquiries", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffMemberId: q.staffMemberId, at: q.at, done: true }),
      })
      toast.success(`${q.staffName}さんに返信し、対応済みにしました`)
      setReplyTo(null)
      setReplyText("")
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "送信できませんでした")
    } finally {
      setBusy(null)
    }
  }

  const open = items.filter((q) => !q.doneAt)
  const done = items.filter((q) => !!q.doneAt)
  const shown = showDone ? done : open

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <MessageCircle className="size-4" />
          スタッフからの問い合わせ
          {open.length > 0 && (
            <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
              未対応 {open.length}件
            </Badge>
          )}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            更新
          </Button>
        </CardTitle>
        <CardDescription>
          LINEの「問い合わせ」から届いた内容です。<strong>この画面から直接返信できます。</strong>
          返信するとスタッフのLINEに「【担当からのご連絡】」として届き、自動で対応済みになります。
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={showDone ? "outline" : "default"}
            onClick={() => setShowDone(false)}
          >
            未対応{open.length > 0 ? `（${open.length}）` : ""}
          </Button>
          <Button
            size="sm"
            variant={showDone ? "default" : "outline"}
            onClick={() => setShowDone(true)}
          >
            対応済み{done.length > 0 ? `（${done.length}）` : ""}
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            読み込み中…
          </div>
        ) : shown.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">
            {showDone ? "対応済みの問い合わせはありません。" : "未対応の問い合わせはありません。"}
          </p>
        ) : (
          shown.map((q) => (
            <div key={`${q.staffMemberId}-${q.at}`} className="rounded-lg border p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-medium">{q.staffName}さん</span>
                {q.payrollName && (
                  <span className="text-xs text-muted-foreground">
                    （給与・手続き：{q.payrollName}）
                  </span>
                )}
                {q.isTest && <Badge variant="outline">テスト</Badge>}
                {q.retired && <Badge variant="outline">退職</Badge>}
                <span className="ml-auto text-xs text-muted-foreground">
                  {jst(q.at)}
                </span>
              </div>

              <p className="whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2 text-sm leading-relaxed">
                {q.text}
              </p>

              {q.doneAt && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {jst(q.doneAt)} に対応済み{q.doneBy ? `（${q.doneBy}）` : ""}
                </p>
              )}
              {q.lastRepliedAt && (
                <p className="mt-1 text-xs text-muted-foreground">
                  この方への最後の連絡：{jst(q.lastRepliedAt)}
                </p>
              )}

              {replyTo === q.at ? (
                <div className="mt-3 flex flex-col gap-2">
                  <Textarea
                    id={`reply-${q.staffMemberId}-${q.at}`}
                    rows={3}
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="返信の内容を入力してください"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy === q.at} onClick={() => reply(q)}>
                      {busy === q.at ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Send className="size-3.5" />
                      )}
                      LINEで返信する
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setReplyTo(null)
                        setReplyText("")
                      }}
                    >
                      やめる
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      setReplyTo(q.at)
                      setReplyText("")
                    }}
                  >
                    <MessageCircle className="size-3.5" />
                    返信する
                  </Button>
                  {q.doneAt ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy === q.at}
                      onClick={() => setDone(q, false)}
                    >
                      <Undo2 className="size-3.5" />
                      未対応に戻す
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === q.at}
                      onClick={() => setDone(q, true)}
                    >
                      <Check className="size-3.5" />
                      返信せずに対応済みにする
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
