"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Loader2, Send } from "lucide-react"

/**
 * 担当からスタッフへLINEで連絡するダイアログ。
 *
 * 要対応の行から直接開けるようにして、別のアプリに移らず連絡できるようにする。
 * よくある連絡は定型文のボタンで入るため、毎回書かなくてよい。
 */

/** よく使う連絡（押すと本文に入る。そのまま送っても、直してから送ってもよい） */
const TEMPLATES: { label: string; text: string }[] = [
  {
    label: "金額が読み取れない",
    text:
      "お送りいただいた領収書の金額が読み取れませんでした。\n" +
      "お手数ですが、金額の部分がはっきり写るように撮り直して、もう一度お送りいただけますか。",
  },
  {
    label: "内容を教えてほしい",
    text:
      "申請いただいた費用について、内容を確認させてください。\n" +
      "何に使われたものか、このトークで教えていただけますか。",
  },
  {
    label: "定期券区間の確認",
    text:
      "交通費について確認させてください。\n" +
      "この金額に定期券の区間が含まれていませんか。\n" +
      "切符を買われた場合は含まれていることがあります。",
  },
  {
    label: "合格通知をお願い",
    text:
      "受験料の申請について、合格通知または修了通知の写真をお送りいただけますか。\n" +
      "写真が届きましたら支給額を確定します。",
  },
  {
    label: "申請が途中のまま",
    text:
      "お送りいただいた領収書の区分が選ばれていないため、まだ支給の対象になっていません。\n" +
      "お手数ですが、区分を選んで申請を完了していただけますか。",
  },
  {
    label: "承認しました",
    text: "申請を確認し、承認しました。今月のお給与に反映されます。",
  },
]

export function NotifyStaffDialog({
  open,
  onOpenChange,
  staffMemberId,
  staffName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  staffMemberId: string | null
  staffName: string
}) {
  const [text, setText] = useState("")
  const [isSending, setIsSending] = useState(false)

  async function send() {
    if (!staffMemberId || !text.trim()) return
    setIsSending(true)
    try {
      const res = await fetch("/api/line/notify-staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffMemberId, text: text.trim() }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || "送信できませんでした")
      toast.success(`${staffName}さんに送りました`)
      setText("")
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "送信できませんでした")
    } finally {
      setIsSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{staffName}さんにLINEで連絡</DialogTitle>
          <DialogDescription>
            スタッフのLINEに届きます。先頭に「【担当からのご連絡】」が付きます。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-1">
          <div className="space-y-1.5">
            <Label className="text-xs">よく使う連絡（押すと本文に入ります）</Label>
            <div className="flex flex-wrap gap-1.5">
              {TEMPLATES.map((t) => (
                <Button
                  key={t.label}
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setText(t.text)}
                >
                  {t.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="notify-text">本文</Label>
            <textarea
              id="notify-text"
              rows={7}
              className="w-full rounded-md border p-2 text-sm"
              style={{ borderColor: "var(--dusk-border)", background: "var(--background)" }}
              placeholder="そのまま送るか、書き直してから送ってください"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <p className="text-xs" style={{ color: "var(--muted-foreground)" }}>
              スタッフからの返信は、このトークにそのまま届きます（LINE公式アカウントの画面で読めます）。
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              やめる
            </Button>
            <Button className="btn-dusk-primary" onClick={send} disabled={isSending || !text.trim()}>
              {isSending ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Send className="mr-1 size-4" />}
              送る
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
