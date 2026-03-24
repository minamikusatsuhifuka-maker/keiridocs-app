"use client"

import { useState, useRef, useCallback } from "react"
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

  // マウスドラッグ
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return
    const pos = calcPosition(e.clientX, e.clientY)
    if (pos) setButtonPos(pos)
  }, [isDragging, calcPosition])

  const handleMouseUp = useCallback(() => {
    if (!isDragging) return
    setIsDragging(false)
  }, [isDragging])

  // タッチドラッグ
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging) return
    const touch = e.touches[0]
    const pos = calcPosition(touch.clientX, touch.clientY)
    if (pos) setButtonPos(pos)
  }, [isDragging, calcPosition])

  const handleTouchEnd = useCallback(() => {
    if (!isDragging) return
    setIsDragging(false)
  }, [isDragging])

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
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
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
                  : "cursor-grab hover:scale-105"
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
              <MessageCircle className="h-5 w-5 text-white" />
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
