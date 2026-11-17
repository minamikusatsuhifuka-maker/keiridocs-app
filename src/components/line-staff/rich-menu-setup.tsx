"use client"

import { useCallback, useEffect, useState } from "react"
import Image from "next/image"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react"

/**
 * リッチメニュー（LINEのトーク下部に常時出る6つのボタン）の登録・公開。
 *
 * 作成しただけでは誰にも表示されない。
 * 担当のLINEだけに出して確認してから全員に公開する、という順番を
 * 画面の並び（1→2→3）で示す。公開前にテストできるようにするため。
 */

interface StaffRow {
  id: string
  name: string
  line_user_id: string | null
  retired_at?: string | null
}

interface MenuRow {
  richMenuId: string
  name: string
}

export function RichMenuSetup() {
  const [menus, setMenus] = useState<MenuRow[]>([])
  const [published, setPublished] = useState(false)
  const [staff, setStaff] = useState<StaffRow[]>([])
  const [targetUserId, setTargetUserId] = useState("")
  const [isLoading, setIsLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    try {
      const [mRes, sRes] = await Promise.all([fetch("/api/line/richmenu"), fetch("/api/line-staff")])
      const mJson = (await mRes.json().catch(() => ({}))) as {
        menus?: MenuRow[]
        published?: boolean
        error?: string
      }
      if (!mRes.ok) throw new Error(mJson.error || "状況を取得できませんでした")
      setMenus(mJson.menus ?? [])
      setPublished(!!mJson.published)
      const sJson = (await sRes.json().catch(() => ({}))) as { data?: StaffRow[] }
      setStaff((sJson.data ?? []).filter((m) => !m.retired_at && m.line_user_id))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "状況を取得できませんでした")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function call(action: string, extra: Record<string, unknown> = {}, label = "実行しました") {
    setBusy(action)
    try {
      const res = await fetch("/api/line/richmenu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || "失敗しました")
      toast.success(label)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "失敗しました")
    } finally {
      setBusy(null)
    }
  }

  const menu = menus[0] ?? null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          LINEのメニュー
          {published ? (
            <Badge className="bg-green-600 text-white hover:bg-green-600">全員に公開中</Badge>
          ) : menu ? (
            <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
              作成済み・未公開
            </Badge>
          ) : (
            <Badge variant="outline">未作成</Badge>
          )}
        </CardTitle>
        <CardDescription>
          スタッフのLINEのトーク下部に、いつでも押せる6つのボタンを出します。
          <strong>作っただけでは誰にも表示されません。</strong>
          まずご自身のLINEだけに出して確かめ、問題なければ全員に公開してください。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {/* 実際に表示される画像 */}
        <div className="max-w-sm overflow-hidden rounded-lg border" style={{ borderColor: "var(--dusk-border)" }}>
          <Image
            src="/line/richmenu.jpg"
            alt="LINEのメニュー"
            width={2500}
            height={1686}
            className="h-auto w-full"
            unoptimized
          />
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm" style={{ color: "var(--muted-foreground)" }}>
            <Loader2 className="size-4 animate-spin" />
            状況を確認しています…
          </div>
        ) : (
          <>
            {/* 1. 作成 */}
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">1. メニューを作る</p>
              <p className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                LINEにメニューと画像を登録します。この時点ではまだ誰にも表示されません。
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={busy !== null || !!menu}
                  onClick={() => call("setup", {}, "メニューを作成しました")}
                >
                  {busy === "setup" && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                  {menu ? "作成済み" : "メニューを作る"}
                </Button>
                {menu && (
                  <span className="inline-flex items-center gap-1 text-xs text-green-600">
                    <CheckCircle2 className="size-3.5" />
                    作成済み
                  </span>
                )}
              </div>
            </div>

            {/* 2. 自分だけに表示して確認 */}
            <div className="flex flex-col gap-2 border-t pt-4" style={{ borderColor: "var(--dusk-border)" }}>
              <p className="text-sm font-medium">2. 自分のLINEだけに出して確かめる</p>
              <p className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                LINEを紐づけ済みのスタッフから選ぶか、LINEユーザーIDを直接入力します。
                選んだ方だけにメニューが表示され、他のスタッフには出ません。
              </p>
              <div className="flex flex-col gap-2 sm:max-w-md">
                <Label htmlFor="rm-target" className="text-xs">
                  表示する相手
                </Label>
                <select
                  id="rm-target"
                  className="h-9 rounded-md border px-2 text-sm"
                  style={{ borderColor: "var(--dusk-border)", background: "var(--background)" }}
                  value={targetUserId}
                  onChange={(e) => setTargetUserId(e.target.value)}
                >
                  <option value="">選択してください</option>
                  {staff.map((m) => (
                    <option key={m.id} value={m.line_user_id ?? ""}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <Input
                  placeholder="または LINEユーザーID（U から始まる文字列）"
                  value={targetUserId}
                  onChange={(e) => setTargetUserId(e.target.value)}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || !menu || !targetUserId.trim()}
                  onClick={() =>
                    call(
                      "assign",
                      { richMenuId: menu?.richMenuId, lineUserId: targetUserId.trim() },
                      "メニューを表示しました。LINEのトークを開き直してご確認ください"
                    )
                  }
                >
                  {busy === "assign" && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                  この相手にだけ表示する
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null || !targetUserId.trim()}
                  onClick={() =>
                    call("unassign", { lineUserId: targetUserId.trim() }, "表示を取り消しました")
                  }
                >
                  表示を取り消す
                </Button>
              </div>
            </div>

            {/* 3. 全員に公開 */}
            <div className="flex flex-col gap-2 border-t pt-4" style={{ borderColor: "var(--dusk-border)" }}>
              <p className="text-sm font-medium">3. 全員に公開する</p>
              <p className="flex items-start gap-1.5 text-xs" style={{ color: "var(--muted-foreground)" }}>
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                <span>
                  押すと<strong>スタッフ全員のLINEにメニューが出ます</strong>。
                  2で動作を確かめてから押してください。公開後も「公開をやめる」で戻せます。
                </span>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={busy !== null || !menu || published}
                  onClick={() => {
                    if (!confirm("スタッフ全員のLINEにメニューを表示します。よろしいですか？")) return
                    call("publishAll", { richMenuId: menu?.richMenuId }, "全員に公開しました")
                  }}
                >
                  {busy === "publishAll" && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                  {published ? "公開中" : "全員に公開する"}
                </Button>
                {published && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => {
                      if (!confirm("全員への表示をやめます。よろしいですか？")) return
                      call("unpublishAll", {}, "公開をやめました")
                    }}
                  >
                    公開をやめる
                  </Button>
                )}
              </div>
            </div>

            {/* 作り直し */}
            {menu && (
              <div className="border-t pt-4" style={{ borderColor: "var(--dusk-border)" }}>
                <p className="text-sm font-medium">画像やボタンを変えたとき</p>
                <p className="mt-1 text-xs" style={{ color: "var(--muted-foreground)" }}>
                  いったん削除してから「1. メニューを作る」をやり直します。削除すると全員への表示も消えます。
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2 text-destructive hover:text-destructive"
                  disabled={busy !== null}
                  onClick={() => {
                    if (!confirm("作成済みのメニューをすべて削除します。よろしいですか？")) return
                    call("deleteAll", {}, "削除しました")
                  }}
                >
                  {busy === "deleteAll" && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                  メニューを削除して作り直す
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
