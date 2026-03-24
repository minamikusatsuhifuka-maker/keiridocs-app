"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { MessageCircle, X, Mic, Loader2, Send } from "lucide-react"
import { useVoiceInput } from "@/hooks/useVoiceInput"

interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
}

interface ChatWidgetProps {
  /** 埋め込みモード（常にチャットパネルを表示、フローティングボタン非表示） */
  embed?: boolean
}

/**
 * フローティングチャットウィジェット
 * マニュアル検索AIと音声入力に対応
 */
export function ChatWidget({ embed = false }: ChatWidgetProps) {
  const [isOpen, setIsOpen] = useState(embed)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputValue, setInputValue] = useState("")
  const [isSending, setIsSending] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const {
    isRecording,
    isProcessing,
    recordingSeconds,
    audioLevel,
    startRecording,
    stopAndTranscribe,
  } = useVoiceInput()

  // メッセージ追加時にスクロール
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // チャットオープン時にフォーカス
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  // メッセージ送信
  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isSending) return

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text.trim(),
    }

    setMessages((prev) => [...prev, userMessage])
    setInputValue("")
    setIsSending(true)

    try {
      const res = await fetch("/api/manuals/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text.trim() }),
      })

      const data = (await res.json()) as { answer?: string; error?: string }

      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: data.answer || data.error || "回答を取得できませんでした",
      }

      setMessages((prev) => [...prev, assistantMessage])
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: "通信エラーが発生しました。もう一度お試しください。",
        },
      ])
    } finally {
      setIsSending(false)
    }
  }, [isSending])

  // テキスト送信ハンドラ
  const handleSend = useCallback(() => {
    if (inputValue.trim()) {
      sendMessage(inputValue)
    }
  }, [inputValue, sendMessage])

  // 録音停止して即送信
  const handleStopAndSend = useCallback(async () => {
    const text = await stopAndTranscribe()
    if (text) {
      await sendMessage(text)
    }
  }, [stopAndTranscribe, sendMessage])

  // Enterキーで送信
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  // 録音時間のフォーマット
  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${String(s).padStart(2, "0")}`
  }

  // 埋め込みモード: チャットパネルのみ（フルサイズ）
  if (embed) {
    return (
      <div className="flex h-dvh w-full flex-col bg-background">
        {/* ヘッダー */}
        <div className="flex items-center bg-[#d4a860] px-4 py-3 text-white">
          <span className="text-sm font-bold">AIアシスタント</span>
        </div>

        {/* メッセージ一覧 */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div className="text-center text-sm text-muted-foreground mt-8">
              <p>マニュアルについて質問できます</p>
              <p className="mt-1 text-xs">例：「受付の手順は？」</p>
            </div>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-[#d4a860] text-white"
                    : "bg-muted text-foreground"
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}
          {isSending && (
            <div className="flex justify-start">
              <div className="rounded-2xl bg-muted px-3 py-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* 録音中バー */}
        {isRecording && (
          <div className="flex items-center gap-2 bg-red-50 px-4 py-2 text-sm text-red-600">
            <div
              className="h-2 w-2 rounded-full bg-red-500"
              style={{ transform: `scale(${1 + audioLevel * 0.5})` }}
            />
            <span>録音中 {formatTime(recordingSeconds)}</span>
          </div>
        )}

        {/* 書き起こし処理中バー */}
        {isProcessing && (
          <div className="flex items-center gap-2 bg-amber-50 px-4 py-2 text-sm text-amber-600">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>音声を書き起こし中...</span>
          </div>
        )}

        {/* 入力エリア */}
        <div className="flex items-center gap-2 border-t px-3 py-3">
          {!isRecording && (
            <button
              onClick={startRecording}
              disabled={isProcessing || isSending}
              className="flex-shrink-0 rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="音声入力"
            >
              <Mic className="h-5 w-5" />
            </button>
          )}

          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isRecording ? "録音中..." : "質問を入力..."}
            disabled={isRecording || isProcessing}
            className="flex-1 rounded-full border bg-muted/50 px-4 py-2 text-sm outline-none transition-colors focus:border-[#d4a860] disabled:cursor-not-allowed disabled:opacity-50"
          />

          <button
            onClick={isRecording ? handleStopAndSend : handleSend}
            disabled={isProcessing || (!isRecording && !inputValue.trim())}
            className={`flex-shrink-0 rounded-full p-2 transition-all duration-200 ${
              isRecording
                ? "animate-pulse bg-red-500 text-white hover:bg-red-600"
                : inputValue.trim()
                  ? "bg-green-600 text-white hover:bg-green-700"
                  : "cursor-not-allowed bg-gray-300 text-gray-400"
            }`}
            aria-label={isRecording ? "録音停止して送信" : "送信"}
          >
            <Send className="h-5 w-5" />
          </button>
        </div>
      </div>
    )
  }

  // 通常モード: フローティングボタン + チャットパネル
  return (
    <>
      {/* フローティングボタン（常に表示、チャットパネルが開いている場合は非表示） */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-20 right-4 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-[#d4a860] shadow-lg transition-transform duration-200 hover:scale-105 md:bottom-6 md:right-6"
          aria-label="チャットを開く"
        >
          <MessageCircle className="h-6 w-6 text-white" />
        </button>
      )}

      {/* チャットパネル */}
      {isOpen && (
        <div className="fixed inset-x-0 bottom-0 z-50 flex h-[80dvh] max-h-[500px] flex-col overflow-hidden border-t bg-background shadow-2xl sm:inset-x-auto sm:bottom-6 sm:right-6 sm:h-[500px] sm:w-[360px] sm:rounded-2xl sm:border">
          {/* ヘッダー */}
          <div className="flex items-center justify-between bg-[#d4a860] px-4 py-3 text-white">
            <span className="text-sm font-bold">AIアシスタント</span>
            <button
              onClick={() => setIsOpen(false)}
              className="rounded-full p-1 transition-colors hover:bg-white/20"
              aria-label="チャットを閉じる"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* メッセージ一覧 */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="text-center text-sm text-muted-foreground mt-8">
                <p>マニュアルについて質問できます</p>
                <p className="mt-1 text-xs">例：「受付の手順は？」</p>
              </div>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
                    msg.role === "user"
                      ? "bg-[#d4a860] text-white"
                      : "bg-muted text-foreground"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {isSending && (
              <div className="flex justify-start">
                <div className="rounded-2xl bg-muted px-3 py-2">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* 録音中バー */}
          {isRecording && (
            <div className="flex items-center gap-2 bg-red-50 px-4 py-2 text-sm text-red-600">
              <div
                className="h-2 w-2 rounded-full bg-red-500"
                style={{ transform: `scale(${1 + audioLevel * 0.5})` }}
              />
              <span>録音中 {formatTime(recordingSeconds)}</span>
            </div>
          )}

          {/* 書き起こし処理中バー */}
          {isProcessing && (
            <div className="flex items-center gap-2 bg-amber-50 px-4 py-2 text-sm text-amber-600">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>音声を書き起こし中...</span>
            </div>
          )}

          {/* 入力エリア */}
          <div className="flex items-center gap-2 border-t px-3 py-3">
            {/* マイクボタン - 録音中は非表示（送信ボタンで停止するため） */}
            {!isRecording && (
              <button
                onClick={startRecording}
                disabled={isProcessing || isSending}
                className="flex-shrink-0 rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="音声入力"
              >
                <Mic className="h-5 w-5" />
              </button>
            )}

            {/* テキスト入力 */}
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isRecording ? "録音中..." : "質問を入力..."}
              disabled={isRecording || isProcessing}
              className="flex-1 rounded-full border bg-muted/50 px-4 py-2 text-sm outline-none transition-colors focus:border-[#d4a860] disabled:cursor-not-allowed disabled:opacity-50"
            />

            {/* 送信ボタン - 録音中は赤い停止送信ボタンに変化 */}
            <button
              onClick={isRecording ? handleStopAndSend : handleSend}
              disabled={isProcessing || (!isRecording && !inputValue.trim())}
              className={`flex-shrink-0 rounded-full p-2 transition-all duration-200 ${
                isRecording
                  ? "animate-pulse bg-red-500 text-white hover:bg-red-600"
                  : inputValue.trim()
                    ? "bg-green-600 text-white hover:bg-green-700"
                    : "cursor-not-allowed bg-gray-300 text-gray-400"
              }`}
              aria-label={isRecording ? "録音停止して送信" : "送信"}
            >
              <Send className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
