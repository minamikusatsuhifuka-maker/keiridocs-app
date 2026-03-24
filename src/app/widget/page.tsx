import { ChatWidget } from "@/components/ChatWidget"

// 外部サイト埋め込み用のチャットウィジェットページ
// iframe で読み込む: <iframe src="/widget" />
export default function WidgetPage() {
  return <ChatWidget embed />
}
