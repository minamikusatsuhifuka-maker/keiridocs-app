// 過去に取引実績のある取引先名かを判定する
//
// 社名がロゴ画像にしか印字されていない請求書（テキストレイヤーに社名が出てこない）は、
// AIの読み取りが正しくても「書類の文字と一致しない」と判定されてしまう。
// 定期的に届く取引先で毎回警告が出るのを防ぐため、過去の登録実績を裏づけとして使う。

/** documents テーブルを引くのに必要な最小限のクライアント形状 */
interface MinimalSupabase {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => {
          limit: (n: number) => Promise<{ data: unknown[] | null }>
        }
      }
    }
  }
}

/**
 * 「その取引先名で過去に登録された書類があるか」を判定する関数を作る。
 * analyzeDocument の isKnownVendor オプションに渡して使う。
 */
export function createKnownVendorChecker(
  supabase: unknown,
  userId: string
): (vendorName: string) => Promise<boolean> {
  return async (vendorName: string) => {
    const name = vendorName.trim()
    if (!name) return false
    try {
      const client = supabase as MinimalSupabase
      const { data } = await client
        .from("documents")
        .select("id")
        .eq("user_id", userId)
        .eq("vendor_name", name)
        .limit(1)
      return Array.isArray(data) && data.length > 0
    } catch (err) {
      console.error("既知取引先の判定に失敗:", err)
      // 判定できない場合は「未知」として扱い、警告は出したままにする（安全側）
      return false
    }
  }
}
