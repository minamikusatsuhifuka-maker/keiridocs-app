"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { usePathname } from "next/navigation"
import { Sparkles, X, Send, Bot } from "lucide-react"

/** チャットメッセージの型 */
interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
}

/**
 * 経理・業務AIアシスタントウィジェット
 * - 画面右下に固定表示のチャットボタン
 * - Gemini AIで経理質問・勘定科目判断に回答
 * - 会話履歴をサーバーに送信して文脈を保持
 */
export function AiChatWidget() {
  const pathname = usePathname()
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputValue, setInputValue] = useState("")
  const [isSending, setIsSending] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // ログイン・ウィジェット埋め込み画面では表示しない
  const hidden = pathname === "/login" || pathname === "/widget"

  // メッセージ追加時にスクロール
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, isSending])

  // オープン時にフォーカス
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  // メッセージ送信
  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || isSending) return

      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: trimmed,
      }

      // 送信前の履歴（直近20件まで）をリクエストに含める
      const history = messages.slice(-20).map((m) => ({
        role: m.role,
        content: m.content,
      }))

      setMessages((prev) => [...prev, userMessage])
      setInputValue("")
      setIsSending(true)

      try {
        const res = await fetch("/api/ai-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed, history }),
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
    },
    [isSending, messages]
  )

  const handleSend = useCallback(() => {
    if (inputValue.trim()) {
      sendMessage(inputValue)
    }
  }, [inputValue, sendMessage])

  // Enterキーで送信（IME変換中は除外）
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  if (hidden) return null

  return (
    <>
      {/* フローティングボタン（Dusk Goldグラデーション） */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-36 right-4 z-[60] flex h-14 w-14 items-center justify-center rounded-full shadow-xl transition-transform duration-200 hover:scale-105 md:bottom-24 md:right-6"
          style={{
            background:
              "linear-gradient(135deg, #e8c888 0%, #d4a860 50%, #b8956a 100%)",
            boxShadow: "0 10px 25px -5px rgba(184, 149, 106, 0.5)",
          }}
          aria-label="AIアシスタントを開く"
        >
          <Sparkles className="h-6 w-6 text-white" />
        </button>
      )}

      {/* チャットパネル */}
      {isOpen && (
        <div
          className="fixed inset-x-0 bottom-0 z-[60] flex h-[80dvh] max-h-[500px] flex-col overflow-hidden border bg-white shadow-2xl sm:inset-x-auto sm:bottom-6 sm:right-6 sm:h-[480px] sm:w-[320px] sm:rounded-2xl"
          style={{ borderColor: "rgba(184, 149, 106, 0.3)" }}
        >
          {/* ヘッダー */}
          <div
            className="flex items-center justify-between px-4 py-3 text-white"
            style={{
              background:
                "linear-gradient(135deg, #e8c888 0%, #d4a860 50%, #b8956a 100%)",
            }}
          >
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5" />
              <span className="text-sm font-bold">経理AIアシスタント</span>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="rounded-full p-1 transition-colors hover:bg-white/20"
              aria-label="チャットを閉じる"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* メッセージ一覧 */}
          <div className="flex-1 space-y-3 overflow-y-auto bg-[#faf7f2] p-4">
            {messages.length === 0 && (
              <div className="mt-6 text-center text-sm text-gray-500">
                <Bot className="mx-auto mb-2 h-10 w-10 text-[#d4a860]" />
                <p className="font-medium text-gray-700">
                  経理・業務について質問できます
                </p>
                <p className="mt-2 text-xs leading-relaxed">
                  例：
                  <br />
                  「電気代の勘定科目は？」
                  <br />
                  「領収書の保管期間は？」
                </p>
              </div>
            )}

            {messages.map((msg) =>
              msg.role === "user" ? (
                // ユーザーメッセージ（右側、ゴールド背景）
                <div key={msg.id} className="flex justify-end">
                  <div
                    className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm px-3 py-2 text-sm text-white shadow-sm"
                    style={{
                      background:
                        "linear-gradient(135deg, #d4a860 0%, #b8956a 100%)",
                    }}
                  >
                    {msg.content}
                  </div>
                </div>
              ) : (
                // AIメッセージ（左側、アイコン付き）
                <div key={msg.id} className="flex justify-start gap-2">
                  <div
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full"
                    style={{
                      background:
                        "linear-gradient(135deg, #e8c888 0%, #d4a860 100%)",
                    }}
                  >
                    <Sparkles className="h-3.5 w-3.5 text-white" />
                  </div>
                  <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-tl-sm border border-[#e8d9bf] bg-white px-3 py-2 text-sm text-gray-800 shadow-sm">
                    {msg.content}
                  </div>
                </div>
              )
            )}

            {/* ローディング（ドットアニメーション） */}
            {isSending && (
              <div className="flex justify-start gap-2">
                <div
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full"
                  style={{
                    background:
                      "linear-gradient(135deg, #e8c888 0%, #d4a860 100%)",
                  }}
                >
                  <Sparkles className="h-3.5 w-3.5 text-white" />
                </div>
                <div className="flex items-center gap-1 rounded-2xl rounded-tl-sm border border-[#e8d9bf] bg-white px-4 py-3 shadow-sm">
                  <span className="h-2 w-2 animate-bounce rounded-full bg-[#d4a860] [animation-delay:-0.3s]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-[#d4a860] [animation-delay:-0.15s]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-[#d4a860]" />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* 入力エリア */}
          <div className="flex items-center gap-2 border-t border-[#e8d9bf] bg-white px-3 py-3">
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="質問を入力..."
              disabled={isSending}
              className="flex-1 rounded-full border border-[#e8d9bf] bg-[#faf7f2] px-4 py-2 text-sm outline-none transition-colors focus:border-[#d4a860] disabled:cursor-not-allowed disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={isSending || !inputValue.trim()}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-white shadow-md transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                background:
                  inputValue.trim() && !isSending
                    ? "linear-gradient(135deg, #e8c888 0%, #d4a860 50%, #b8956a 100%)"
                    : "#cbd5e1",
              }}
              aria-label="送信"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
