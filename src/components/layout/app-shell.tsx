"use client"

import { usePathname } from "next/navigation"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { useState } from "react"
import { Sidebar, SidebarContent } from "@/components/layout/sidebar"
import { MobileNav } from "@/components/layout/mobile-nav"
import { Header } from "@/components/layout/header"
import { ChatWidget } from "@/components/ChatWidget"

// アプリ全体のシェル（サイドバー + ヘッダー + コンテンツ + モバイルナビ）
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  // ログイン画面・ウィジェット埋め込み画面はシェルなし
  if (pathname === "/login" || pathname === "/widget") {
    return <>{children}</>
  }

  return (
    <div className="flex min-h-screen">
      {/* デスクトップサイドバー */}
      <Sidebar />

      <div className="flex flex-1 flex-col">
        {/* ヘッダー（モバイルメニュー含む） */}
        <Sheet open={open} onOpenChange={setOpen}>
          <Header onMenuClick={() => setOpen(true)} />
          <SheetContent side="left" className="w-64 p-0">
            <SidebarContent onNavigate={() => setOpen(false)} />
          </SheetContent>
        </Sheet>

        {/*
          メインコンテンツ。
          下端の余白は「ボトムナビ＋右下のフローティングボタン2段（チャット/AI）」の高さ分を確保する。
          これが無いと、一番下までスクロールしても最終行・合計行・操作ボタンがボタンの下に隠れて押せない。
          モバイル: AIボタン上端 = bottom-36(144px) + h-14(56px) = 200px → pb-52(208px)
          デスクトップ: AIボタン上端 = bottom-24(96px) + h-14(56px) = 152px → pb-40(160px)
        */}
        <main className="flex-1 p-4 pb-52 md:p-6 md:pb-40">{children}</main>
      </div>

      {/* モバイルボトムナビ */}
      <MobileNav />

      {/* フローティングチャットウィジェット */}
      <ChatWidget />
    </div>
  )
}
