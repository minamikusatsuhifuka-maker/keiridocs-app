"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard,
  FilePlus,
  FileText,
  Mail,
  Settings,
  BarChart3,
  Download,
  Briefcase,
} from "lucide-react"
import { cn } from "@/lib/utils"

const navItems = [
  { href: "/", label: "ホーム", icon: LayoutDashboard },
  { href: "/documents/new", label: "登録", icon: FilePlus },
  { href: "/documents", label: "書類", icon: FileText },
  { href: "/analytics", label: "分析", icon: BarChart3 },
  { href: "/downloads", label: "自動取得", icon: Download },
  { href: "/accountant", label: "税理士", icon: Briefcase },
  { href: "/mail", label: "メール", icon: Mail },
  { href: "/settings", label: "設定", icon: Settings },
]

// パスがアクティブかどうかを判定
function isActive(href: string, pathname: string) {
  if (href === "/") return pathname === "/"
  if (href === "/documents/new") return pathname === "/documents/new"
  if (href === "/documents") return pathname === "/documents" || (pathname.startsWith("/documents/") && pathname !== "/documents/new")
  return pathname.startsWith(href)
}

// モバイル用ボトムナビゲーション
export function MobileNav() {
  const pathname = usePathname()

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t bg-card md:hidden">
      <div className="flex h-16 items-center justify-around">
        {navItems.map((item) => {
          const Icon = item.icon
          const active = isActive(item.href, pathname)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-col items-center gap-1 px-2 py-1 text-xs transition-colors",
                active
                  ? "text-primary"
                  : "text-muted-foreground"
              )}
            >
              <Icon className="h-5 w-5" />
              <span>{item.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
