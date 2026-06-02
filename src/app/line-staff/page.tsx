"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2 } from "lucide-react"
import { StaffManagement } from "@/components/line-staff/staff-management"

const SESSION_KEY = "line-staff-auth"

export default function LineStaffPage() {
  // パスワード認証
  const [isAuthed, setIsAuthed] = useState(false)
  const [isCheckingAuth, setIsCheckingAuth] = useState(true)
  const [password, setPassword] = useState("")
  const [authError, setAuthError] = useState("")
  const [isVerifying, setIsVerifying] = useState(false)

  /* ---------- sessionStorage認証チェック ---------- */
  useEffect(() => {
    // 旧キーを削除（キー名変更に伴うクリーンアップ）
    sessionStorage.removeItem("line-staff-authed")

    const stored = sessionStorage.getItem(SESSION_KEY)
    if (stored === "true") {
      setIsAuthed(true)
    }
    setIsCheckingAuth(false)
  }, [])

  /* ---------- パスワード検証 ---------- */
  async function handleVerify() {
    if (!password) {
      setAuthError("パスワードを入力してください")
      return
    }
    setIsVerifying(true)
    setAuthError("")
    try {
      const res = await fetch("/api/line-staff/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      })
      const json = (await res.json()) as { ok: boolean; error?: string }
      if (json.ok) {
        sessionStorage.setItem(SESSION_KEY, "true")
        setIsAuthed(true)
      } else {
        setAuthError(json.error || "パスワードが違います")
      }
    } catch {
      setAuthError("認証に失敗しました")
    } finally {
      setIsVerifying(false)
    }
  }

  /* ---------- 認証チェック中 ---------- */
  if (isCheckingAuth) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--dusk-primary)" }} />
      </div>
    )
  }

  /* ---------- パスワード入力画面 ---------- */
  if (!isAuthed) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">🔐 LINEスタッフ管理</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="auth-password">パスワード</Label>
              <Input
                id="auth-password"
                type="password"
                placeholder="パスワードを入力"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value)
                  setAuthError("")
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isVerifying) handleVerify()
                }}
                autoFocus
              />
              {authError && (
                <p className="text-sm text-red-500">{authError}</p>
              )}
            </div>
            <Button
              className="btn-dusk-primary w-full"
              onClick={handleVerify}
              disabled={isVerifying || !password}
            >
              {isVerifying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              確認
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  /* ---------- 管理画面（認証済み） ---------- */
  return <StaffManagement />
}
