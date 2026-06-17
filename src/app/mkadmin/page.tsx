"use client"

import { useState, useEffect } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SenderList } from "@/components/settings/sender-list"
import { NotifyList } from "@/components/settings/notify-list"
import { FolderSettings } from "@/components/settings/folder-settings"
import { NotificationSettings } from "@/components/settings/notification-settings"
import { AccountSettings } from "@/components/settings/account-settings"
import { AiSettings } from "@/components/settings/ai-settings"
import { DocumentTypeSettings } from "@/components/settings/document-type-settings"
import { AutoClassifySettings } from "@/components/settings/auto-classify-settings"
import { DownloadSourceSettings } from "@/components/settings/download-source-settings"
import { AccountantSettings } from "@/components/settings/accountant-settings"
import { FloatingButtonSettings } from "@/components/settings/floating-button-settings"
import { RegistrantList } from "@/components/settings/registrant-list"
import { DocumentStaffList } from "@/components/settings/document-staff-list"
import { StaffManagement } from "@/components/line-staff/staff-management"
import { PaymentMemo } from "@/components/mkadmin/payment-memo"
import { Mail, Bell, FolderOpen, BellRing, UserCog, Sparkles, FileType, SlidersHorizontal, Download, Briefcase, MousePointerClick, UserPlus, Users, MessageCircle, Wallet, Loader2 } from "lucide-react"

// 管理画面（/mkadmin）認証用 sessionStorage キー
const SESSION_KEY = "mkadmin-auth"

// 管理画面（旧「設定」+ LINEスタッフ管理 を統合、パスワード保護）
export default function MkadminPage() {
  // パスワード認証
  const [isAuthed, setIsAuthed] = useState(false)
  const [isCheckingAuth, setIsCheckingAuth] = useState(true)
  const [password, setPassword] = useState("")
  const [authError, setAuthError] = useState("")
  const [isVerifying, setIsVerifying] = useState(false)

  /* ---------- sessionStorage認証チェック ---------- */
  useEffect(() => {
    const stored = sessionStorage.getItem(SESSION_KEY)
    if (stored === "true") {
      setIsAuthed(true)
    }
    setIsCheckingAuth(false)
  }, [])

  /* ---------- パスワード検証（/line-staff と同方式） ---------- */
  async function handleVerify() {
    if (!password) {
      setAuthError("パスワードを入力してください")
      return
    }
    setIsVerifying(true)
    setAuthError("")
    try {
      const res = await fetch("/api/mkadmin/verify", {
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
            <CardTitle className="text-xl">🔐 管理画面</CardTitle>
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
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">管理画面</h1>

      <Tabs defaultValue="senders" className="space-y-6">
        <TabsList className="flex w-full flex-wrap">
          <TabsTrigger value="senders" className="flex items-center gap-1.5">
            <Mail className="size-4" />
            送信元管理
          </TabsTrigger>
          <TabsTrigger value="notify" className="flex items-center gap-1.5">
            <Bell className="size-4" />
            通知先管理
          </TabsTrigger>
          <TabsTrigger value="registrants" className="flex items-center gap-1.5">
            <UserPlus className="size-4" />
            登録者管理
          </TabsTrigger>
          <TabsTrigger value="document-staff" className="flex items-center gap-1.5">
            <Users className="size-4" />
            書類登録スタッフ
          </TabsTrigger>
          <TabsTrigger value="doc-types" className="flex items-center gap-1.5">
            <FileType className="size-4" />
            書類種別
          </TabsTrigger>
          <TabsTrigger value="auto-classify" className="flex items-center gap-1.5">
            <SlidersHorizontal className="size-4" />
            自動仕分け
          </TabsTrigger>
          <TabsTrigger value="folders" className="flex items-center gap-1.5">
            <FolderOpen className="size-4" />
            フォルダ管理
          </TabsTrigger>
          <TabsTrigger value="notification-settings" className="flex items-center gap-1.5">
            <BellRing className="size-4" />
            通知設定
          </TabsTrigger>
          <TabsTrigger value="download-sources" className="flex items-center gap-1.5">
            <Download className="size-4" />
            自動取得
          </TabsTrigger>
          <TabsTrigger value="accountant" className="flex items-center gap-1.5">
            <Briefcase className="size-4" />
            税理士提出
          </TabsTrigger>
          <TabsTrigger value="floating-button" className="flex items-center gap-1.5">
            <MousePointerClick className="size-4" />
            フローティングボタン
          </TabsTrigger>
          <TabsTrigger value="ai" className="flex items-center gap-1.5">
            <Sparkles className="size-4" />
            AI設定
          </TabsTrigger>
          <TabsTrigger value="payment-memo" className="flex items-center gap-1.5">
            <Wallet className="size-4" />
            支払いメモ
          </TabsTrigger>
          <TabsTrigger value="line-staff" className="flex items-center gap-1.5">
            <MessageCircle className="size-4" />
            LINEスタッフ管理
          </TabsTrigger>
          <TabsTrigger value="account" className="flex items-center gap-1.5">
            <UserCog className="size-4" />
            アカウント
          </TabsTrigger>
        </TabsList>

        <TabsContent value="senders">
          <SenderList />
        </TabsContent>

        <TabsContent value="notify">
          <NotifyList />
        </TabsContent>

        <TabsContent value="registrants">
          <RegistrantList />
        </TabsContent>

        <TabsContent value="document-staff">
          <DocumentStaffList />
        </TabsContent>

        <TabsContent value="doc-types">
          <DocumentTypeSettings />
        </TabsContent>

        <TabsContent value="auto-classify">
          <AutoClassifySettings />
        </TabsContent>

        <TabsContent value="folders">
          <FolderSettings />
        </TabsContent>

        <TabsContent value="notification-settings">
          <NotificationSettings />
        </TabsContent>

        <TabsContent value="download-sources">
          <DownloadSourceSettings />
        </TabsContent>

        <TabsContent value="accountant">
          <AccountantSettings />
        </TabsContent>

        <TabsContent value="floating-button">
          <FloatingButtonSettings />
        </TabsContent>

        <TabsContent value="ai">
          <AiSettings />
        </TabsContent>

        <TabsContent value="payment-memo">
          <PaymentMemo />
        </TabsContent>

        <TabsContent value="line-staff">
          {/* LINEスタッフ管理（タブ内なので見出しは非表示） */}
          <StaffManagement showHeader={false} />
        </TabsContent>

        <TabsContent value="account">
          <AccountSettings />
        </TabsContent>
      </Tabs>
    </div>
  )
}
