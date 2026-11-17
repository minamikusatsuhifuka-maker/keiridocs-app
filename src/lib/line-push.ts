/**
 * LINEのプッシュ送信（返信トークンを使わず任意のタイミングで送る）。
 *
 * 担当が上限超過を承認したときなど、スタッフの操作とは別のタイミングで
 * 通知するために使う。送信できなくても本体の処理は止めない（通知は補助）。
 */

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push"

/**
 * スタッフへテキストを送る。
 *
 * @returns 送信できたか（失敗しても例外は投げない）
 */
export async function pushLineText(lineUserId: string | null | undefined, text: string): Promise<boolean> {
  if (!lineUserId) return false

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) {
    console.warn("[line-push] LINE_CHANNEL_ACCESS_TOKEN が設定されていないため通知を送れません")
    return false
  }

  try {
    const res = await fetch(LINE_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to: lineUserId, messages: [{ type: "text", text }] }),
    })
    if (!res.ok) {
      console.error("[line-push] 送信失敗:", res.status, await res.text().catch(() => ""))
      return false
    }
    return true
  } catch (e) {
    console.error("[line-push] 送信エラー:", e)
    return false
  }
}
