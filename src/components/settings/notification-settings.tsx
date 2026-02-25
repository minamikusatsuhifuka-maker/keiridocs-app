"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

interface NotificationFlags {
  due_date_notify: boolean
  month_end_notify: boolean
  unapproved_mail_notify: boolean
}

const DEFAULT_FLAGS: NotificationFlags = {
  due_date_notify: true,
  month_end_notify: false,
  unapproved_mail_notify: true,
}

// 通知設定
export function NotificationSettings() {
  const [flags, setFlags] = useState<NotificationFlags>(DEFAULT_FLAGS)
  const [isLoading, setIsLoading] = useState(true)

  // 設定を取得
  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings?table=settings&key=notification_flags")
      const json = await res.json() as { data?: { value: unknown } | null; error?: string }
      if (json.error) throw new Error(json.error)
      if (json.data?.value && typeof json.data.value === "object" && json.data.value !== null) {
        const saved = json.data.value as Partial<NotificationFlags>
        setFlags({
          due_date_notify: saved.due_date_notify ?? DEFAULT_FLAGS.due_date_notify,
          month_end_notify: saved.month_end_notify ?? DEFAULT_FLAGS.month_end_notify,
          unapproved_mail_notify: saved.unapproved_mail_notify ?? DEFAULT_FLAGS.unapproved_mail_notify,
        })
      }
    } catch {
      // デフォルト値を使用
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  // 設定を保存
  async function saveFlags(newFlags: NotificationFlags) {
    setFlags(newFlags)
    try {
      const res = await fetch("/api/settings?table=settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "notification_flags", value: newFlags }),
      })
      const json = await res.json() as { data?: unknown; error?: string }
      if (json.error) throw new Error(json.error)
      toast.success("通知設定を保存しました")
    } catch {
      toast.error("通知設定の保存に失敗しました")
      // 失敗時はフェッチし直す
      fetchSettings()
    }
  }

  // トグル切り替え
  function handleToggle(key: keyof NotificationFlags, value: boolean) {
    saveFlags({ ...flags, [key]: value })
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>通知設定</CardTitle>
        <CardDescription>
          各種通知のON/OFFを切り替えます
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="due-date-notify" className="text-base font-medium">
              支払期限通知
            </Label>
            <p className="text-sm text-muted-foreground">
              支払期日が近い書類がある場合に通知を送信します
            </p>
          </div>
          <Switch
            id="due-date-notify"
            checked={flags.due_date_notify}
            onCheckedChange={(v) => handleToggle("due_date_notify", v)}
          />
        </div>

        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="month-end-notify" className="text-base font-medium">
              月末通知
            </Label>
            <p className="text-sm text-muted-foreground">
              月末に未処理書類のサマリーを通知します
            </p>
          </div>
          <Switch
            id="month-end-notify"
            checked={flags.month_end_notify}
            onCheckedChange={(v) => handleToggle("month_end_notify", v)}
          />
        </div>

        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="unapproved-mail-notify" className="text-base font-medium">
              未承認メール通知
            </Label>
            <p className="text-sm text-muted-foreground">
              未承認のメール添付書類がある場合に通知を送信します
            </p>
          </div>
          <Switch
            id="unapproved-mail-notify"
            checked={flags.unapproved_mail_notify}
            onCheckedChange={(v) => handleToggle("unapproved_mail_notify", v)}
          />
        </div>
      </CardContent>
    </Card>
  )
}
