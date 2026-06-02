import { redirect } from "next/navigation"

// 設定ページは /mkadmin（管理画面）に移設済み。
// 旧URLにアクセスされた場合は /mkadmin へリダイレクトする。
export default function SettingsPage() {
  redirect("/mkadmin")
}
