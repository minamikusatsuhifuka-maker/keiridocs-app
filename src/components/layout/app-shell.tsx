"use client"

import { usePathname } from "next/navigation"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { useState } from "react"
import { Sidebar, SidebarContent } from "@/components/layout/sidebar"
import { MobileNav } from "@/components/layout/mobile-nav"
import { Header } from "@/components/layout/header"

// アプリ全体のシェル（サイドバー + ヘッダー + コンテンツ + モバイルナビ）
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  // ログイン画面はシェルなし
  if (pathname === "/login") {
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

        {/* メインコンテンツ（モバイル時はボトムナビ分のパディング） */}
        <main className="flex-1 p-4 pb-20 md:p-6 md:pb-6">{children}</main>
      </div>

      {/* モバイルボトムナビ */}
      <MobileNav />
    </div>
  )
}
