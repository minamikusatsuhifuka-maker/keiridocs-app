"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { LogOut, Loader2, User } from "lucide-react"
import { useAuth } from "@/hooks/use-auth"

// アカウント設定
export function AccountSettings() {
  const { user, isLoading, signOut } = useAuth()

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
        <CardTitle>アカウント</CardTitle>
        <CardDescription>
          ログイン中のアカウント情報を表示します
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* ユーザー情報 */}
        <div className="flex items-center gap-4">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted">
            {user?.user_metadata?.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.user_metadata.avatar_url as string}
                alt="アバター"
                className="size-12 rounded-full"
              />
            ) : (
              <User className="size-6 text-muted-foreground" />
            )}
          </div>
          <div className="space-y-1">
            <p className="font-medium">
              {user?.user_metadata?.full_name as string ?? user?.email ?? "不明なユーザー"}
            </p>
            <p className="text-sm text-muted-foreground">{user?.email ?? ""}</p>
          </div>
        </div>

        {/* 詳細情報 */}
        <div className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">認証プロバイダー</span>
            <span>{user?.app_metadata?.provider === "google" ? "Google" : user?.app_metadata?.provider ?? "—"}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">ユーザーID</span>
            <span className="font-mono text-xs">{user?.id ?? "—"}</span>
          </div>
        </div>

        <Separator />

        {/* ログアウトボタン */}
        <div>
          <Button variant="destructive" onClick={signOut}>
            <LogOut className="size-4" />
            ログアウト
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
