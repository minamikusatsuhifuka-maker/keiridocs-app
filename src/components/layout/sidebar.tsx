"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard,
  FilePlus,
  FileText,
  Mail,
  Settings,
  LogOut,
  BarChart3,
  Sparkles,
  Users,
  Download,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { useAuth } from "@/hooks/use-auth"
import { useRole } from "@/hooks/use-role"

const navItems = [
  { href: "/", label: "ダッシュボード", icon: LayoutDashboard },
  { href: "/documents/new", label: "書類登録", icon: FilePlus },
  { href: "/documents", label: "書類一覧", icon: FileText },
  { href: "/analytics", label: "分析", icon: BarChart3 },
  { href: "/analytics/ai-report", label: "AIレポート", icon: Sparkles },
  { href: "/downloads", label: "自動取得", icon: Download },
  { href: "/mail", label: "メール確認", icon: Mail },
  { href: "/settings", label: "設定", icon: Settings },
]

// admin専用ナビ項目
const adminNavItems = [
  { href: "/settings/users", label: "ユーザー管理", icon: Users },
]

// サイドバーナビリンク
function NavLink({
  href,
  label,
  icon: Icon,
  active,
  onClick,
}: {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  active: boolean
  onClick?: () => void
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </Link>
  )
}

// パスがアクティブかどうかを判定
function isActive(href: string, pathname: string) {
  if (href === "/") return pathname === "/"
  if (href === "/documents/new") return pathname === "/documents/new"
  if (href === "/documents") return pathname === "/documents" || (pathname.startsWith("/documents/") && pathname !== "/documents/new")
  if (href === "/analytics/ai-report") return pathname === "/analytics/ai-report"
  if (href === "/analytics") return pathname === "/analytics"
  return pathname.startsWith(href)
}

// デスクトップ用サイドバー
export function Sidebar() {
  const pathname = usePathname()
  const { user, signOut } = useAuth()
  const { isAdmin } = useRole()

  // ユーザー表示名（メールアドレスまたはメタデータから取得）
  const displayName =
    user?.user_metadata?.full_name ??
    user?.email ??
    ""

  return (
    <aside className="hidden w-64 flex-col border-r bg-card md:flex">
      {/* ブランド名 */}
      <div className="flex h-14 items-center border-b px-4">
        <h1 className="text-lg font-bold">経理書類管理</h1>
      </div>

      {/* ナビゲーション */}
      <nav className="flex flex-1 flex-col gap-1 p-4">
        {navItems.map((item) => (
          <NavLink
            key={item.href}
            {...item}
            active={isActive(item.href, pathname)}
          />
        ))}
        {isAdmin && adminNavItems.map((item) => (
          <NavLink
            key={item.href}
            {...item}
            active={isActive(item.href, pathname)}
          />
        ))}
      </nav>

      {/* ユーザー情報 + ログアウト */}
      <div className="border-t p-4">
        <div className="mb-2 truncate text-sm text-muted-foreground">
          {displayName}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-muted-foreground"
          onClick={signOut}
        >
          <LogOut className="h-4 w-4" />
          ログアウト
        </Button>
      </div>
    </aside>
  )
}

// モバイルシート用サイドバーコンテンツ
export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  const { user, signOut } = useAuth()
  const { isAdmin } = useRole()

  const displayName =
    user?.user_metadata?.full_name ??
    user?.email ??
    ""

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center border-b px-4">
        <h1 className="text-lg font-bold">経理書類管理</h1>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-4">
        {navItems.map((item) => (
          <NavLink
            key={item.href}
            {...item}
            active={isActive(item.href, pathname)}
            onClick={onNavigate}
          />
        ))}
        {isAdmin && adminNavItems.map((item) => (
          <NavLink
            key={item.href}
            {...item}
            active={isActive(item.href, pathname)}
            onClick={onNavigate}
          />
        ))}
      </nav>
      <div className="border-t p-4">
        <div className="mb-2 truncate text-sm text-muted-foreground">
          {displayName}
        </div>
        <Separator className="mb-2" />
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-muted-foreground"
          onClick={() => {
            onNavigate?.()
            signOut()
          }}
        >
          <LogOut className="h-4 w-4" />
          ログアウト
        </Button>
      </div>
    </div>
  )
}
