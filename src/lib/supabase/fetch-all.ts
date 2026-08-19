// PostgREST の行数上限（Supabase 既定 max-rows=1000）を越えて全件取得するための共通ヘルパー。
//
// 背景（重要）:
//   supabase-js の `.select()` は件数を指定しなければ「全件」に見えるが、実際は
//   PostgREST 側の max-rows（Supabase 既定 1000）で暗黙に打ち切られる。エラーにもならない。
//   税理士提出リストの照合（documents / staff_receipts / petty_cash_transactions）は
//   この暗黙の打ち切りに当たると、DBに存在する書類が「要確認：DB未登録」に落ちる。
//   件数が 1000 を超えた時点から静かに壊れるため、全件走査が前提のクエリは必ず本ヘルパーを通す。
//
// 使い方:
//   const rows = await fetchAllRows<DocRow>((from, to) =>
//     supabase.from("documents").select("id, dropbox_path").order("id").range(from, to)
//   )
//
// 注意: ページ境界がずれないよう、呼び出し側で必ず安定した `.order(...)` を付けること。

/** 1ページあたりの取得件数（PostgREST の既定上限に合わせる） */
const PAGE_SIZE = 1000

/** 暴走防止の上限ページ数（1000件×200＝20万件まで） */
const MAX_PAGES = 200

/** range(from, to) を受け取ってPostgRESTクエリを実行する関数 */
type RangeQuery<T> = (
  from: number,
  to: number
) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>

/**
 * ページングしながら全件取得する。
 *
 * サーバ側の max-rows が PAGE_SIZE より小さい場合でも取りこぼさないよう、
 * 「空ページが返るまで」実際の返却件数だけカーソルを進める方式にしている。
 *
 * @param build range(from, to) を適用したクエリを返す関数
 * @throws クエリがエラーを返した場合（呼び出し側で握るかどうかを判断させる）
 */
export async function fetchAllRows<T>(build: RangeQuery<T>): Promise<T[]> {
  const all: T[] = []
  let from = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    if (rows.length === 0) break
    all.push(...rows)
    from += rows.length
  }

  return all
}
