"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
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
import { StaffManagement } from "@/components/line-staff/staff-management"
import { StaffAdminGuide } from "@/components/line-staff/staff-admin-guide"
import { CourseMaster } from "@/components/courses/course-master"
import { PriorCourseRegistration } from "@/components/courses/prior-course-registration"
import { PaymentMemo } from "@/components/mkadmin/payment-memo"
import { StaffReimburseList } from "@/components/mkadmin/staff-reimburse-list"
import { StaffManualEntry } from "@/components/mkadmin/staff-manual-entry"
import { Mail, Bell, FolderOpen, BellRing, UserCog, Sparkles, FileType, SlidersHorizontal, Download, Briefcase, MousePointerClick, Users, Wallet, Loader2, Receipt, ArrowRight, ClipboardList, HandCoins, GraduationCap } from "lucide-react"

// 管理画面（/mkadmin）認証用 sessionStorage キー
const SESSION_KEY = "mkadmin-auth"

/* ---------- タブの並び（用途ごとのグループ） ---------- */

/**
 * タブ一覧の折り返し対応。
 *
 * TabsList の既定の高さ指定は
 * `group-data-[orientation=horizontal]/tabs:h-9` という**修飾子付き**のため、
 * 素の `h-auto` を足しても tailwind-merge では打ち消せず残ってしまう
 * （高さ36pxのまま行が折り返し、2段目以降が下の内容に重なる）。
 * 同じ修飾子を付けた h-auto で上書きする必要がある。
 */
const TABS_LIST =
  "flex h-auto w-full flex-wrap items-start justify-start gap-x-4 gap-y-2 p-2 group-data-[orientation=horizontal]/tabs:h-auto"

/** 各タブ。高さを固定し、flex-1 の引き伸ばしを解除する（TabsTrigger 側の指定を上書き） */
const TAB_ITEM = "flex h-8 flex-none items-center gap-1.5 px-2.5"

const TAB_GROUPS: {
  label: string
  tabs: { value: string; label: string; icon: typeof Users }[]
}[] = [
  {
    label: "スタッフ・経費申請",
    tabs: [
      { value: "staff", label: "スタッフ", icon: Users },
      { value: "courses", label: "講座マスタ", icon: GraduationCap },
      { value: "staff-reimburse", label: "立替まとめ", icon: ClipboardList },
      { value: "staff-manual-entry", label: "立替手動登録", icon: HandCoins },
      { value: "line-receipts", label: "LINE領収書", icon: Receipt },
    ],
  },
  {
    label: "書類",
    tabs: [
      { value: "doc-types", label: "書類種別", icon: FileType },
      { value: "auto-classify", label: "自動仕分け", icon: SlidersHorizontal },
      { value: "folders", label: "フォルダ管理", icon: FolderOpen },
      { value: "accountant", label: "税理士提出", icon: Briefcase },
      { value: "payment-memo", label: "支払いメモ", icon: Wallet },
    ],
  },
  {
    label: "メール・取り込み",
    tabs: [
      { value: "senders", label: "送信元管理", icon: Mail },
      { value: "download-sources", label: "自動取得", icon: Download },
    ],
  },
  {
    label: "通知",
    tabs: [
      { value: "notify", label: "通知先管理", icon: Bell },
      { value: "notification-settings", label: "通知設定", icon: BellRing },
    ],
  },
  {
    label: "その他の設定",
    tabs: [
      { value: "ai", label: "AI設定", icon: Sparkles },
      { value: "floating-button", label: "フローティングボタン", icon: MousePointerClick },
      { value: "account", label: "アカウント", icon: UserCog },
    ],
  },
]

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

      <Tabs defaultValue="staff" className="space-y-6">
        {/*
          タブ数が多いため、用途ごとにグループ分けして並べる。

          折り返しで文字が重なる問題（h-9 の固定・各タブの
          h-[calc(100%-1px)]＝一覧全体の高さ・flex-1 の引き伸ばし）は、
          TABS_LIST と TAB_ITEM の指定でまとめて解除している。
          TAB_ITEM は TabsTrigger の className に渡すため tailwind-merge が
          元の指定を確実に打ち消す（セレクタ経由の上書きでは効かないことがある）。
        */}
        <TabsList className={TABS_LIST}>
          {TAB_GROUPS.map((group) => (
            <div key={group.label} className="flex flex-col gap-1">
              <span
                className="px-1 text-[10px] font-semibold tracking-wide"
                style={{ color: "var(--muted-foreground)" }}
              >
                {group.label}
              </span>
              <div className="flex flex-wrap gap-1">
                {group.tabs.map((tab) => {
                  const Icon = tab.icon
                  return (
                    <TabsTrigger key={tab.value} value={tab.value} className={TAB_ITEM}>
                      <Icon className="size-4" />
                      {tab.label}
                    </TabsTrigger>
                  )
                })}
              </div>
            </div>
          ))}
        </TabsList>

        <TabsContent value="senders">
          <SenderList />
        </TabsContent>

        <TabsContent value="notify">
          <NotifyList />
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

        <TabsContent value="staff-manual-entry">
          <StaffManualEntry />
        </TabsContent>

        <TabsContent value="staff-reimburse">
          <StaffReimburseList />
        </TabsContent>

        <TabsContent value="line-receipts">
          {/* LINE登録領収書の確認画面（スタッフ別・画像・精算状態・区分）への導線 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Receipt className="size-5" />
                LINE登録領収書
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                スタッフがLINEで送った領収書を、スタッフ別・月別で確認できます。
                画像サムネイル（クリックで拡大）、精算状態（小口現金／給与／保管・未精算）、
                アチーブメント区分、Dropbox実ファイルへの導線が表示されます。
              </p>
              <Button asChild className="btn-dusk-primary">
                <Link href="/staff-receipts/admin">
                  領収書一覧を開く
                  <ArrowRight className="ml-2 size-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="courses">
          {/* 講座マスタ（スタッフが申請時に選ぶ講座。支給率と30,000円上限の判定に使う）。
              スタッフごとの既受講回数は「スタッフ」タブに置き、スタッフの操作を1か所にまとめている */}
          <CourseMaster showHeader={false} />
        </TabsContent>

        <TabsContent value="staff">
          {/*
            スタッフに関する操作を1か所に集約する。
            入職・退職・氏名変更・既受講の登録・書類登録スタッフが別タブに散ると、
            どこを触るのか分からず確認もれにつながるため。
          */}
          <div className="flex flex-col gap-4">
            <StaffAdminGuide />
            <StaffManagement showHeader={false} />
            {/* 既受講の登録（アプリ導入前の受講回数。未登録だと既受講者に全額支給してしまう） */}
            <PriorCourseRegistration />
          </div>
        </TabsContent>

        <TabsContent value="account">
          <AccountSettings />
        </TabsContent>
      </Tabs>
    </div>
  )
}
