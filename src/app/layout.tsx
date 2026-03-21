import type { Metadata } from "next"
import { Zen_Maru_Gothic } from "next/font/google"
import "./globals.css"
import { Toaster } from "@/components/ui/sonner"
import { AppShell } from "@/components/layout/app-shell"

const zenMaruGothic = Zen_Maru_Gothic({
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  display: "swap",
})

export const metadata: Metadata = {
  title: "経理書類管理",
  description: "経理書類管理アプリ",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="ja">
      <body className={`${zenMaruGothic.className} antialiased`}>
        <AppShell>{children}</AppShell>
        <Toaster />
      </body>
    </html>
  )
}
