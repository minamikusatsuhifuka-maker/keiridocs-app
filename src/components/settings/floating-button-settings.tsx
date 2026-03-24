"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { MessageCircle, GripVertical } from "lucide-react"

// フローティングボタンの位置設定コンポーネント
export function FloatingButtonSettings() {
  const [buttonColor, setButtonColor] = useState("#d4a860")
  const [isDragging, setIsDragging] = useState(false)
  const [buttonPos, setButtonPos] = useState({ x: 10, y: 10 }) // right/bottomからの距離(%)
  const previewRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)

  // マウス座標からプレビュー内の相対位置(%)を計算
  const calcPosition = useCallback((clientX: number, clientY: number) => {
    if (!previewRef.current) return null
    const rect = previewRef.current.getBoundingClientRect()
    const relX = clientX - rect.left
    const relY = clientY - rect.top
    // プレビュー内の相対位置をパーセントで計算
    const xPercent = Math.max(5, Math.min(90, (relX / rect.width) * 100))
    const yPercent = Math.max(5, Math.min(90, (relY / rect.height) * 100))
    // right/bottomからの距離に変換
    return { x: 100 - xPercent, y: 100 - yPercent }
  }, [])

  // ドキュメントレベルのイベントリスナーで滑らかなドラッグを実現
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const pos = calcPosition(e.clientX, e.clientY)
      if (pos) setButtonPos(pos)
    }

    const handleMouseUp = () => {
      if (!isDraggingRef.current) return
      isDraggingRef.current = false
      setIsDragging(false)
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (!isDraggingRef.current) return
      e.preventDefault()
      const touch = e.touches[0]
      const pos = calcPosition(touch.clientX, touch.clientY)
      if (pos) setButtonPos(pos)
    }

    const handleTouchEnd = () => {
      if (!isDraggingRef.current) return
      isDraggingRef.current = false
      setIsDragging(false)
    }

    document.addEventListener("mousemove", handleMouseMove)
    document.addEventListener("mouseup", handleMouseUp)
    document.addEventListener("touchmove", handleTouchMove, { passive: false })
    document.addEventListener("touchend", handleTouchEnd)

    return () => {
      document.removeEventListener("mousemove", handleMouseMove)
      document.removeEventListener("mouseup", handleMouseUp)
      document.removeEventListener("touchmove", handleTouchMove)
      document.removeEventListener("touchend", handleTouchEnd)
    }
  }, [calcPosition])

  // マウスドラッグ開始
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingRef.current = true
    setIsDragging(true)
  }, [])

  // タッチドラッグ開始
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault()
    isDraggingRef.current = true
    setIsDragging(true)
  }, [])

  return (
    <Card>
      <CardHeader>
        <CardTitle>フローティングボタン設定</CardTitle>
        <CardDescription>
          チャットウィジェットのフローティングボタンの表示位置と色を設定します。
          プレビュー内のボタンをドラッグして位置を調整できます。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* カラー設定 */}
        <div className="flex items-center gap-4">
          <Label htmlFor="button-color">ボタンカラー</Label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              id="button-color"
              value={buttonColor}
              onChange={(e) => setButtonColor(e.target.value)}
              className="h-8 w-8 cursor-pointer rounded border"
            />
            <Input
              value={buttonColor}
              onChange={(e) => setButtonColor(e.target.value)}
              className="w-28 font-mono text-sm"
              maxLength={7}
            />
          </div>
        </div>

        {/* 位置表示 */}
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span>位置: 右から {Math.round(buttonPos.x)}% / 下から {Math.round(buttonPos.y)}%</span>
        </div>

        {/* プレビュー */}
        <div className="space-y-2">
          <Label>プレビュー（ドラッグで位置調整）</Label>
          <div
            ref={previewRef}
            className="relative h-64 w-full overflow-hidden rounded-lg border-2 border-dashed border-muted-foreground/25 bg-muted/30 select-none"
          >
            {/* 模擬ページコンテンツ */}
            <div className="p-4 opacity-30">
              <div className="mb-2 h-4 w-3/4 rounded bg-muted-foreground/20" />
              <div className="mb-2 h-3 w-1/2 rounded bg-muted-foreground/15" />
              <div className="mb-4 h-3 w-2/3 rounded bg-muted-foreground/15" />
              <div className="mb-2 h-16 w-full rounded bg-muted-foreground/10" />
              <div className="mb-2 h-3 w-5/6 rounded bg-muted-foreground/15" />
              <div className="h-3 w-1/3 rounded bg-muted-foreground/15" />
            </div>

            {/* フローティングボタン */}
            <div
              className={`absolute flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-transform duration-150 ${
                isDragging
                  ? "cursor-grabbing scale-110 shadow-xl"
                  : "cursor-grab"
              }`}
              style={{
                right: `${buttonPos.x}%`,
                bottom: `${buttonPos.y}%`,
                backgroundColor: buttonColor,
                transformOrigin: "center center",
              }}
              onMouseDown={handleMouseDown}
              onTouchStart={handleTouchStart}
            >
              {/* ホバーエフェクトはアイコンのみに適用（ボタン位置ずれ防止） */}
              <MessageCircle className="h-5 w-5 text-white transition-transform duration-200 hover:scale-110" />
              {/* ドラッグヒント */}
              {!isDragging && (
                <div className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-white shadow">
                  <GripVertical className="h-3 w-3 text-muted-foreground" />
                </div>
              )}
            </div>

            {/* ドラッグ中のオーバーレイ（ドラッグ範囲を広げる） */}
            {isDragging && (
              <div className="absolute inset-0 cursor-grabbing" />
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
