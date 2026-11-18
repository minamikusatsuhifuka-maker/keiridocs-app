import { isReceptionist } from "@/lib/line-staff-profile"

/**
 * 担当へのLINE通知の宛先を1か所にまとめる。
 *
 * ■ 作る理由
 * ふだん確認するのは担当（河村さん）なので、担当に届かない通知は
 * 気づかれないまま残る。院長だけに送っていると確認もれにつながる。
 *
 * ■ 宛先
 * 運用のお知らせは、スタッフ一覧で「担当」をONにした方だけに届く。
 * 院長には届かない（同じ通知が二重に届くのを避けるため）。
 *
 * ただし**担当が1人も設定されていない場合だけ**院長に送る。
 * 誰にも届かないまま要対応や異常が放置されるのを防ぐための安全網。
 *
 * ■ 使い分け
 *   notifyAdmins       … 運用のお知らせ（要対応のまとめ、新規登録、異常）。担当だけ
 *   notifyOwnerOnly    … 設定・保守の話（バックアップの失敗など）。院長だけ
 */

/** Supabaseクライアント（型は呼び出し側に合わせて最小限だけ要求する） */
interface MinimalClient {
  from: (table: string) => {
    select: (cols: string) => {
      not: (
        col: string,
        op: string,
        val: null
      ) => PromiseLike<{
        data: { line_user_id: string | null; line_profile?: unknown }[] | null
        error: unknown
      }>
    }
  }
}

/** LINEへ1件送る（失敗しても例外にしない） */
async function push(to: string, text: string): Promise<boolean> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token || !to) return false
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** 担当のLINE IDを集める（取得できなければ空） */
export async function fetchReceptionistIds(supabase: MinimalClient): Promise<string[]> {
  try {
    const { data } = await supabase
      .from("staff_members")
      .select("line_user_id, line_profile")
      .not("line_user_id", "is", null)
    return (data ?? [])
      .filter((row) => isReceptionist(row.line_profile))
      .map((row) => row.line_user_id)
      .filter((v): v is string => !!v)
  } catch {
    return []
  }
}

/**
 * 運用のお知らせを送る（スタッフ一覧で「担当」をONにした方だけ）。
 *
 * 院長には送らない。担当が1人も設定されていないときだけ、
 * 通知が誰にも届かなくなるのを防ぐため院長に送る。
 *
 * @returns 送れた人数
 */
export async function notifyAdmins(supabase: MinimalClient, text: string): Promise<number> {
  const targets = new Set<string>(await fetchReceptionistIds(supabase))

  // 担当が未設定のときの安全網（要対応や異常が誰にも届かないのを防ぐ）
  if (targets.size === 0) {
    const ownerId = process.env.ADMIN_LINE_USER_ID
    if (ownerId) targets.add(ownerId)
  }

  let sent = 0
  for (const id of targets) {
    if (await push(id, text)) sent++
  }
  return sent
}

/** 設定・保守の話を院長だけに送る */
export async function notifyOwnerOnly(text: string): Promise<boolean> {
  const ownerId = process.env.ADMIN_LINE_USER_ID
  if (!ownerId) return false
  return push(ownerId, text)
}
