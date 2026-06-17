import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"

/**
 * 指定メモから項目が0件になっていれば親メモ(payment_memos)も削除する（孤児メモを残さない）。
 * memoIds の重複は呼び出し側で除去しておくこと。
 * @param client service role の Supabase クライアント（RLSバイパス）
 * @param memoIds 影響を受けた親メモIDの配列
 */
export async function cleanupOrphanMemos(
  client: SupabaseClient<Database>,
  memoIds: string[]
) {
  for (const memoId of memoIds) {
    if (!memoId) continue
    const { count, error } = await client
      .from("payment_memo_items")
      .select("id", { count: "exact", head: true })
      .eq("memo_id", memoId)
    if (error) throw error
    if ((count ?? 0) === 0) {
      const { error: delError } = await client.from("payment_memos").delete().eq("id", memoId)
      if (delError) throw delError
    }
  }
}
