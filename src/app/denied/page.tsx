"use client"

import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ShieldAlert } from "lucide-react"

/**
 * 許可されていないアカウントでログインしたときの画面。
 *
 * 誰でもログインできる状態を避けるため、許可リスト（allowed_emails）に
 * 無いアドレスはここに来る。何も操作できない。
 */
export default function DeniedPage() {
  async function signOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    window.location.href = "/login"
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <ShieldAlert className="mb-2 h-10 w-10" style={{ color: "var(--dusk-primary)" }} />
          <CardTitle className="text-xl">このアカウントでは利用できません</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          <p className="text-sm" style={{ color: "var(--dusk-text-muted)" }}>
            このアプリは、許可されたアカウントだけが利用できます。
            <br />
            ご利用が必要な場合は、担当にご連絡ください。
          </p>
          <p className="text-xs" style={{ color: "var(--dusk-text-muted)" }}>
            別のアカウントをお持ちの場合は、いったんログアウトしてから
            そのアカウントでログインしてください。
          </p>
          <Button className="btn-dusk-primary w-full" onClick={signOut}>
            ログアウトする
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
