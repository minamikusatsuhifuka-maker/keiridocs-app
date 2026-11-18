/**
 * 交通系ICカードの利用履歴の読み取り結果を扱う。
 *
 * LINEの処理から切り離して、金額に関わる判定だけを置く
 * （チャージ・物販の除外、年の扱い）。検証スクリプトから直接テストできる。
 */

/** 利用履歴から読み取った移動1件 */
export interface TransitTrip {
  /** 利用日（YYYY-MM-DD） */
  date: string
  /** 区間（例「南草津 → 京都」）または事業者名 */
  route: string
  /** 運賃（円） */
  fare: number
}

/** チャージ・残高・物販を取り除く語（合計に混ぜると支給額が過大になる） */
const NON_TRIP_WORDS = /チャージ|入金|積増|オートチャージ|残高|繰越|物販|現金併用|販売|購入|定期/

/**
 * AI解析の payments から「移動」だけを取り出す。
 *
 * プロンプト側でもチャージ等を除外しているが、読み違いが残ることがあるため
 * ここでも語句で弾く。二重に守る（過大支給は取り返せないため）。
 */
export function deriveTransitTrips(ocr: { payments?: unknown }): TransitTrip[] {
  const rows = Array.isArray(ocr.payments) ? ocr.payments : []
  const trips: TransitTrip[] = []
  for (const r of rows as Record<string, unknown>[]) {
    const fare = typeof r.amount === "number" ? r.amount : Number(r.amount)
    if (!Number.isFinite(fare) || fare <= 0) continue
    const route = String(r.vendor_name ?? "").trim()
    const note = String(r.description ?? "").trim()
    if (!route) continue
    if (NON_TRIP_WORDS.test(route) || NON_TRIP_WORDS.test(note)) continue
    // 年が読めなかったものは "0000-MM-DD" で来る。推測で補わず、あとで本人に確認する
    const rawDate = String(r.issue_date ?? "")
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) continue
    trips.push({ date: rawDate, route: route.slice(0, 40), fare: Math.round(fare) })
  }
  // 新しい日付が上に来るようにする（直近の移動を申請することが多いため）
  return trips.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 20)
}

/** 年が読み取れなかった移動が含まれるか（"0000-MM-DD"） */
export function hasUnknownYear(trips: TransitTrip[]): boolean {
  return trips.some((t) => t.date.startsWith("0000-"))
}

/** 年を当てはめる（"0000-MM-DD" → "YYYY-MM-DD"） */
export function applyYear(trips: TransitTrip[], year: number): TransitTrip[] {
  return trips.map((t) =>
    t.date.startsWith("0000-") ? { ...t, date: `${year}${t.date.slice(4)}` } : t
  )
}

/**
 * すでに申請済みの移動の番号を、**件数で**割り当てる。
 *
 * 同じ日に同じ区間・同じ運賃の移動が複数あることは普通にある
 * （往復を2回した、同じ区間を1日に2度通ったなど）。
 * 「内容が一致したら申請済み」と判定すると、1件申請しただけで
 * 残りの同じ内容の移動まで選べなくなってしまう。
 *
 * そこで、登録済みの**件数**だけを申請済みに割り当てる。
 * 3件あって1件登録済みなら、残り2件は選べる。
 *
 * @param trips          読み取った移動（表示順）
 * @param registeredKeys 登録済みの記録の内容キー（重複を含む配列）
 * @param submitted      元の画像側に残っている申請済みの番号（確実な情報なので優先する）
 * @param keyOf          移動から内容キーを作る関数
 * @returns 申請済みとして扱う移動の番号
 */
export function assignRegisteredTrips(
  trips: TransitTrip[],
  registeredKeys: string[],
  submitted: number[],
  keyOf: (trip: TransitTrip) => string
): Set<number> {
  const result = new Set<number>(submitted.filter((i) => i >= 0 && i < trips.length))

  // 残り件数を数える
  const remaining = new Map<string, number>()
  for (const k of registeredKeys) remaining.set(k, (remaining.get(k) ?? 0) + 1)

  // 番号で分かっている分は、その内容の枠を先に使ったものとして差し引く
  for (const i of result) {
    const k = keyOf(trips[i])
    const left = remaining.get(k) ?? 0
    if (left > 0) remaining.set(k, left - 1)
  }

  // 残った件数を、まだ申請済みになっていない移動に先頭から割り当てる
  trips.forEach((t, i) => {
    if (result.has(i)) return
    const k = keyOf(t)
    const left = remaining.get(k) ?? 0
    if (left > 0) {
      result.add(i)
      remaining.set(k, left - 1)
    }
  })

  return result
}
