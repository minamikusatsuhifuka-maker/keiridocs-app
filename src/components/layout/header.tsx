"use client"

import { usePathname } from "next/navigation"
import { Menu } from "lucide-react"
import { Button } from "@/components/ui/button"

// パス → ページタイトルマッピング
const pageTitles: Record<string, string> = {
  "/": "ダッシュボード",
  "/documents": "書類一覧",
  "/documents/new": "書類登録",
  "/mail": "メール確認",
  "/settings": "設定",
}

// ページタイトルを取得
function getPageTitle(pathname: string): string {
  if (pageTitles[pathname]) return pageTitles[pathname]
  // /documents/[id] パターン
  if (pathname.startsWith("/documents/")) return "書類詳細"
  return "経理書類管理"
}

// ヘッダー（ページタイトル + モバイルメニューボタン）
export function Header({ onMenuClick }: { onMenuClick?: () => void }) {
  const pathname = usePathname()
  const title = getPageTitle(pathname)

  return (
    <header className="flex h-14 items-center gap-4 border-b bg-card px-4">
      {/* モバイル用メニューボタン */}
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onMenuClick}
      >
        <Menu className="h-5 w-5" />
        <span className="sr-only">メニューを開く</span>
      </Button>

      {/* ページタイトル */}
      <h2 className="text-lg font-semibold">{title}</h2>
    </header>
  )
}
