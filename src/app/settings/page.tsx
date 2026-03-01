"use client"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
import { Mail, Bell, FolderOpen, BellRing, UserCog, Sparkles, FileType, SlidersHorizontal, Download, Briefcase } from "lucide-react"

// 設定画面（5タブ構成）
export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">設定</h1>

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
          <TabsTrigger value="ai" className="flex items-center gap-1.5">
            <Sparkles className="size-4" />
            AI設定
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

        <TabsContent value="ai">
          <AiSettings />
        </TabsContent>

        <TabsContent value="account">
          <AccountSettings />
        </TabsContent>
      </Tabs>
    </div>
  )
}
