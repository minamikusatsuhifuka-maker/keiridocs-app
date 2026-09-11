"use client"

import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ChevronLeft, ChevronRight } from "lucide-react"

/**
 * 一覧のページ送り。
 *
 * 一覧の上下どちらにも置ける。下部中央に配置することで、画面右下の
 * フローティングボタン（チャット・AI）と重ならないようにしている。
 */
interface PaginationProps {
  /** 現在ページ（0始まり） */
  page: number
  /** 総ページ数 */
  totalPages: number
  /** 総件数 */
  totalCount: number
  /** 1ページあたりの件数 */
  pageSize: number
  onPageChange: (page: number) => void
  /**
   * 簡易表示（一覧の上部用）。「前へ / 2 / 4 ページ / 次へ」だけを出す。
   */
  compact?: boolean
  /**
   * ←→キーでのページ送りを有効にする。
   * 1画面に複数置く場合、キー操作が二重に走らないよう1つだけ true にすること。
   */
  enableKeyboard?: boolean
  className?: string
}

/** 現在ページの前後2ページ分だけ番号ボタンを出す（ページ数が多くても横に伸びないように） */
function pageWindow(page: number, totalPages: number): number[] {
  const start = Math.max(0, Math.min(page - 2, totalPages - 5))
  const end = Math.min(totalPages, start + 5)
  const pages: number[] = []
  for (let i = start; i < end; i++) pages.push(i)
  return pages
}

/** 入力中・モーダル表示中はキーボードのページ送りを効かせない */
function shouldIgnoreKey(target: EventTarget | null): boolean {
  if (typeof document !== "undefined" && document.querySelector("[role='dialog']")) return true
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName)
}

export function Pagination({
  page,
  totalPages,
  totalCount,
  pageSize,
  onPageChange,
  compact = false,
  enableKeyboard = false,
  className,
}: PaginationProps) {
  const isFirst = page <= 0
  const isLast = page >= totalPages - 1

  // ←→キーでのページ送り
  useEffect(() => {
    if (!enableKeyboard) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (shouldIgnoreKey(e.target)) return
      if (e.key === "ArrowLeft" && page > 0) {
        e.preventDefault()
        onPageChange(page - 1)
      } else if (e.key === "ArrowRight" && page < totalPages - 1) {
        e.preventDefault()
        onPageChange(page + 1)
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [enableKeyboard, page, totalPages, onPageChange])

  if (totalPages <= 1) return null

  const firstItem = page * pageSize + 1
  const lastItem = Math.min((page + 1) * pageSize, totalCount)

  if (compact) {
    return (
      <nav
        aria-label="ページ送り（上部）"
        className={cn("flex items-center justify-center gap-3", className)}
      >
        <Button
          variant="outline"
          size="sm"
          disabled={isFirst}
          onClick={() => onPageChange(page - 1)}
          aria-label="前のページ"
        >
          <ChevronLeft className="size-4" />
          前へ
        </Button>
        <span className="text-sm tabular-nums text-muted-foreground">
          {page + 1} / {totalPages} ページ
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={isLast}
          onClick={() => onPageChange(page + 1)}
          aria-label="次のページ"
        >
          次へ
          <ChevronRight className="size-4" />
        </Button>
      </nav>
    )
  }

  return (
    <nav aria-label="ページ送り" className={cn("flex flex-col items-center gap-3", className)}>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <Button
          variant="outline"
          disabled={isFirst}
          onClick={() => onPageChange(page - 1)}
          className="min-w-[88px]"
          aria-label="前のページ"
        >
          <ChevronLeft className="size-4" />
          前へ
        </Button>

        {/* ページ番号（現在ページの前後のみ） */}
        <div className="flex items-center gap-1">
          {pageWindow(page, totalPages).map((i) => (
            <Button
              key={i}
              variant={page === i ? "default" : "outline"}
              onClick={() => onPageChange(i)}
              className="min-w-[44px] tabular-nums"
              aria-label={`${i + 1}ページ目`}
              aria-current={page === i ? "page" : undefined}
            >
              {i + 1}
            </Button>
          ))}
        </div>

        <Button
          variant="outline"
          disabled={isLast}
          onClick={() => onPageChange(page + 1)}
          className="min-w-[88px]"
          aria-label="次のページ"
        >
          次へ
          <ChevronRight className="size-4" />
        </Button>
      </div>

      <p className="text-center text-sm tabular-nums text-muted-foreground">
        {page + 1} / {totalPages} ページ（全 {totalCount} 件中 {firstItem}〜{lastItem} 件）
      </p>
    </nav>
  )
}
