/**
 * 支給ルールの検証スクリプト。
 *
 *   npm run subsidy:verify
 *
 * 規程どおりに計算されるかを確認する。支給額は給与に直結し、
 * 誤りが出ると後からの是正が煩雑になるため、ルールを変えたら必ず実行する。
 *
 * テスト用のフレームワークは導入していないので、同じ書式で assert を並べる。
 */

import {
  BOOKS_CAP_PER_MONTH,
  TRAVEL_CAP_PER_COURSE,
  allowsBento,
  allowsMembership,
  availableItems,
  academyTermEnd,
  computeSubsidy,
  needsDetailReview,
  isWithinAcademyTerm,
  type CourseKind,
  type CourseRule,
  type ExpenseItem,
} from "../src/lib/subsidy-rules"
import { applyYear, deriveTransitTrips, hasUnknownYear } from "../src/lib/transit-history"

let passed = 0
const failures: string[] = []

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
    return
  }
  failures.push(`✗ ${label}\n    期待: ${e}\n    実際: ${a}`)
}

/** 支給額と超過額だけを取り出す（検証を読みやすくするため） */
function calc(p: {
  amount: number
  item: ExpenseItem
  courseKind?: CourseKind | null
  courseRule?: CourseRule | null
  priorTuitionCount?: number
  isRepeat?: boolean
  travelCapUsed?: number
  monthlyCapUsed?: number
}) {
  const r = computeSubsidy(p)
  return { 支給: r.subsidy, 超過: r.excess, 承認既定値: r.suggestedApproval }
}

/** 担当判断（未定）になるかどうかも含めて見る */
function calcWithDecision(p: {
  amount: number
  item: ExpenseItem
  courseKind?: CourseKind | null
  courseRule?: CourseRule | null
  priorTuitionCount?: number
}) {
  const r = computeSubsidy(p)
  return { 支給: r.subsidy, 担当判断: r.needsDecision }
}

/* ---------- 頂点への道：アチーブメントテクノロジーコース（ATC方式） ---------- */

check(
  "【院長の確認依頼】ATC 再受講料 ¥10,000 → 支給 ¥5,000",
  calc({ amount: 10000, item: "tuition", courseKind: "apex", courseRule: "atc", priorTuitionCount: 1 }),
  { 支給: 5000, 超過: 0, 承認既定値: 0 }
)

check(
  "ATC 初回の受講料 ¥330,000 → 全額",
  calc({ amount: 330000, item: "tuition", courseKind: "apex", courseRule: "atc", priorTuitionCount: 0 }),
  { 支給: 330000, 超過: 0, 承認既定値: 0 }
)

check(
  "ATC 再受講6回目 ¥10,000 → 半額（担当判断にならない）",
  calcWithDecision({ amount: 10000, item: "tuition", courseKind: "apex", courseRule: "atc", priorTuitionCount: 6 }),
  { 支給: 5000, 担当判断: false }
)

check(
  "ATC 再受講7回目 ¥10,000 → 規程が未定のため担当判断",
  calcWithDecision({ amount: 10000, item: "tuition", courseKind: "apex", courseRule: "atc", priorTuitionCount: 7 }),
  { 支給: 5000, 担当判断: true }
)

check(
  "会員割引後 ¥8,000 の再受講 → その額を基準に半額 ¥4,000",
  calc({ amount: 8000, item: "tuition", courseKind: "apex", courseRule: "atc", priorTuitionCount: 1 }),
  { 支給: 4000, 超過: 0, 承認既定値: 0 }
)

check(
  "アカデミー会費 ¥55,000 → 全額（受講料とは別枠・上限なし・再受講でも半額にしない）",
  calc({ amount: 55000, item: "membership", courseKind: "apex", courseRule: "atc", priorTuitionCount: 3 }),
  { 支給: 55000, 超過: 0, 承認既定値: 0 }
)

check("アカデミー会費は頂点への道で選べる", allowsMembership("apex"), true)
check("アカデミー会費はその他のアチーブメント講座では選べない", allowsMembership("ach_other"), false)
check("アカデミー会費はJPSAでは選べない", allowsMembership("jpsa"), false)

check(
  "ATC 再受講の交通費 ¥10,000 → 半額 ¥5,000（上限内）",
  calc({
    amount: 10000,
    item: "transport",
    courseKind: "apex",
    courseRule: "atc",
    priorTuitionCount: 1,
    isRepeat: true,
  }),
  { 支給: 5000, 超過: 0, 承認既定値: 0 }
)

/* ---------- 頂点への道：他の3コース（常に半額） ---------- */

check(
  "ダイナミックコース 受講料 ¥100,000 → 半額 ¥50,000（初回でも半額）",
  calcWithDecision({ amount: 100000, item: "tuition", courseKind: "apex", courseRule: "half" }),
  { 支給: 50000, 担当判断: false }
)

check(
  "ダイナミックアドバンスコース 受講料 ¥10,000 → 半額 ¥5,000",
  calc({ amount: 10000, item: "tuition", courseKind: "apex", courseRule: "half" }),
  { 支給: 5000, 超過: 0, 承認既定値: 0 }
)

check(
  "ピークパフォーマンスコース 交通費¥20,000＋宿泊費¥20,000 → 30,000で頭打ち→半額15,000",
  calc({ amount: 20000, item: "lodging", courseKind: "apex", courseRule: "half", travelCapUsed: 20000 }),
  { 支給: 5000, 超過: 10000, 承認既定値: 5000 }
)

check(
  "常に半額の講座でも弁当代は全額",
  calc({ amount: 1200, item: "bento", courseKind: "apex", courseRule: "half" }),
  { 支給: 1200, 超過: 0, 承認既定値: 0 }
)

check(
  "常に半額の講座でもアカデミー会費は全額",
  calc({ amount: 55000, item: "membership", courseKind: "apex", courseRule: "half" }),
  { 支給: 55000, 超過: 0, 承認既定値: 0 }
)

/* ---------- 支給率が未定の講座 ---------- */

check(
  "支給率 未定の講座は自動で確定させず担当判断",
  calcWithDecision({ amount: 100000, item: "tuition", courseKind: "apex", courseRule: "undecided" }),
  { 支給: 100000, 担当判断: true }
)

check(
  "常に全額の講座は担当判断にならない",
  calcWithDecision({ amount: 100000, item: "tuition", courseKind: "non_ach", courseRule: "full" }),
  { 支給: 100000, 担当判断: false }
)

check("頂点への道の内訳に弁当代とアカデミー会費が出る", availableItems("apex"), [
  "tuition",
  "transport",
  "lodging",
  "bento",
  "membership",
  "other",
])
check("JPSAの内訳は受講料・交通費・宿泊費とその他", availableItems("jpsa"), [
  "tuition",
  "transport",
  "lodging",
  "other",
])

/* ---------- 頂点への道・初回 ---------- */

check("初回・受講料 ¥50,000 → 全額", calc({ amount: 50000, item: "tuition", courseKind: "apex" }), {
  支給: 50000,
  超過: 0,
  承認既定値: 0,
})

check(
  "初回・交通費 ¥12,000（上限内）",
  calc({ amount: 12000, item: "transport", courseKind: "apex" }),
  { 支給: 12000, 超過: 0, 承認既定値: 0 }
)

check(
  "初回・宿泊費 ¥15,000（交通費12,000を支給済み。合計27,000で上限内）",
  calc({ amount: 15000, item: "lodging", courseKind: "apex", travelCapUsed: 12000 }),
  { 支給: 15000, 超過: 0, 承認既定値: 0 }
)

check(
  "初回・同じ講座に宿泊費 ¥8,000 を追加（27,000支給済み。残枠3,000・超過5,000）",
  calc({ amount: 8000, item: "lodging", courseKind: "apex", travelCapUsed: 27000 }),
  { 支給: 3000, 超過: 5000, 承認既定値: 5000 }
)

check("初回・弁当代 ¥1,200 → 全額（上限の対象外）", calc({ amount: 1200, item: "bento", courseKind: "apex" }), {
  支給: 1200,
  超過: 0,
  承認既定値: 0,
})

/* ---------- 頂点への道・2回目以降 ---------- */

check(
  "2回目以降・受講料 ¥50,000 → 半額",
  calc({ amount: 50000, item: "tuition", courseKind: "apex", isRepeat: true }),
  { 支給: 25000, 超過: 0, 承認既定値: 0 }
)

check(
  "2回目以降・交通費¥20,000＋宿泊費¥20,000＝¥40,000 → 30,000で頭打ち→半額15,000",
  calc({
    amount: 20000,
    item: "lodging",
    courseKind: "apex",
    isRepeat: true,
    travelCapUsed: 20000,
  }),
  // 交通費20,000が「立替額」として先に計上されている状態。残枠10,000に半額を適用
  { 支給: 5000, 超過: 10000, 承認既定値: 5000 }
)

check(
  "2回目以降・交通費¥10,000（上限内）→ 半額5,000",
  calc({ amount: 10000, item: "transport", courseKind: "apex", isRepeat: true }),
  { 支給: 5000, 超過: 0, 承認既定値: 0 }
)

check(
  "2回目以降・弁当代 ¥1,200 → 全額（弁当代は半額にしない）",
  calc({ amount: 1200, item: "bento", courseKind: "apex", isRepeat: true }),
  { 支給: 1200, 超過: 0, 承認既定値: 0 }
)

/* ---------- その他のアチーブメント講座（常に全額） ---------- */

check(
  "その他講座・受講料 ¥40,000 → 全額（2回目以降でも半額にならない）",
  calc({ amount: 40000, item: "tuition", courseKind: "ach_other", isRepeat: true }),
  { 支給: 40000, 超過: 0, 承認既定値: 0 }
)

check(
  "その他講座・交通費¥20,000＋宿泊費¥20,000 → 30,000まで。超過10,000",
  calc({ amount: 20000, item: "lodging", courseKind: "ach_other", travelCapUsed: 20000 }),
  { 支給: 10000, 超過: 10000, 承認既定値: 10000 }
)

/* ---------- アチーブメント以外 ---------- */

check(
  "アチーブメント以外・宿泊費 ¥42,000 → 30,000まで。超過12,000",
  calc({ amount: 42000, item: "lodging", courseKind: "non_ach" }),
  { 支給: 30000, 超過: 12000, 承認既定値: 12000 }
)

check("アチーブメント以外は弁当代を選べない", allowsBento("non_ach"), false)
check("頂点への道は弁当代を選べる", allowsBento("apex"), true)
check("その他のアチーブメント講座も弁当代を選べる", allowsBento("ach_other"), true)
check("アチーブメント以外の内訳に弁当代が出ない", availableItems("non_ach"), [
  "tuition",
  "transport",
  "lodging",
  "other",
])

/* ---------- 「その他」はすべて担当の確認待ちにする ---------- */
check("講座を選んだ「その他」は確認待ち", needsDetailReview("other"), true)
check("講座に紐づかない「その他」も確認待ち", needsDetailReview("other"), true)
check("「その他」以外は確認待ちにしない", needsDetailReview("tuition"), false)

/* ---------- 書籍代・診療費（月上限・別枠） ---------- */

check("書籍代 ¥3,000（今月初回）", calc({ amount: 3000, item: "books" }), {
  支給: 3000,
  超過: 0,
  承認既定値: 0,
})

check(
  "書籍代 ¥3,000 を追加（3,000支給済み。残枠2,000・超過1,000）",
  calc({ amount: 3000, item: "books", monthlyCapUsed: 3000 }),
  { 支給: 2000, 超過: 1000, 承認既定値: 1000 }
)

check(
  "診療費 ¥5,000（書籍代と別枠なので満額）",
  calc({ amount: 5000, item: "medical", monthlyCapUsed: 0 }),
  { 支給: 5000, 超過: 0, 承認既定値: 0 }
)

check(
  "診療費 ¥6,000 → 5,000まで。超過1,000",
  calc({ amount: 6000, item: "medical" }),
  { 支給: 5000, 超過: 1000, 承認既定値: 1000 }
)

/* ---------- 上限のない区分 ---------- */

check("受験料 ¥11,000 → 全額", calc({ amount: 11000, item: "exam" }), {
  支給: 11000,
  超過: 0,
  承認既定値: 0,
})

check("通常業務の交通費 ¥1,520 → 全額（30,000上限の対象外）", calc({ amount: 1520, item: "commute" }), {
  支給: 1520,
  超過: 0,
  承認既定値: 0,
})

check(
  "研修に紐づかない交通費は上限なし（courseKind なし）",
  calc({ amount: 45000, item: "transport", courseKind: null }),
  { 支給: 45000, 超過: 0, 承認既定値: 0 }
)

/* ---------- 端数・境界 ---------- */

check(
  "2回目以降・受講料 ¥9,999 → 半額は切り捨て（4,999）",
  calc({ amount: 9999, item: "tuition", courseKind: "apex", isRepeat: true }),
  { 支給: 4999, 超過: 0, 承認既定値: 0 }
)

check(
  "上限ちょうど ¥30,000 は超過なし",
  calc({ amount: TRAVEL_CAP_PER_COURSE, item: "lodging", courseKind: "apex" }),
  { 支給: 30000, 超過: 0, 承認既定値: 0 }
)

check(
  "上限を使い切った後の申請は全額が超過",
  calc({ amount: 5000, item: "transport", courseKind: "apex", travelCapUsed: TRAVEL_CAP_PER_COURSE }),
  { 支給: 0, 超過: 5000, 承認既定値: 5000 }
)

check(
  "書籍代の上限ちょうど",
  calc({ amount: BOOKS_CAP_PER_MONTH, item: "books" }),
  { 支給: 5000, 超過: 0, 承認既定値: 0 }
)

/* ---------- 結果 ---------- */

console.log("")

/* ---------- アカデミー会員の有効期間（3年で6回） ---------- */
{
  const start = "2025-12-01"
  check("2025年12月1日開始 → 期限は2028年11月30日", academyTermEnd(start), "2028-11-30")
  check("開始日当日は期間内", isWithinAcademyTerm(start, "2025-12-01"), true)
  check("期限当日は期間内", isWithinAcademyTerm(start, "2028-11-30"), true)
  check("期限の翌日は期間外", isWithinAcademyTerm(start, "2028-12-01"), false)
  check("開始日の前日は期間外", isWithinAcademyTerm(start, "2025-11-30"), false)
  // 20日締めで申請が翌月になっても、領収書の日付が期間内なら期間内と判定する
  check("期限直前の領収書は期間内（申請が翌月でも可）", isWithinAcademyTerm(start, "2028-11-25"), true)
  check("日付が読めない場合は判定できない", isWithinAcademyTerm(start, null), null)
  check("うるう日開始でも期限を計算できる", academyTermEnd("2024-02-29"), "2027-02-28")
  check("未登録なら期限なし", academyTermEnd(null), null)
}



/* ---------- 交通系ICカードの利用履歴の読み取り ---------- */
{
  const ocr = {
    payments: [
      { vendor_name: "南草津 → 京都", amount: 420, issue_date: "2026-11-17", description: "鉄道" },
      { vendor_name: "京都 → 南草津", amount: 420, issue_date: "2026-11-17", description: "鉄道" },
      { vendor_name: "チャージ", amount: 5000, issue_date: "2026-11-17", description: "入金" },
      { vendor_name: "セブンイレブン", amount: 580, issue_date: "2026-11-16", description: "物販" },
      { vendor_name: "残高", amount: 3200, issue_date: "2026-11-16", description: "残高照会" },
      { vendor_name: "近江鉄道バス", amount: 230, issue_date: "2026-11-15", description: "バス" },
      { vendor_name: "定期券購入", amount: 18000, issue_date: "2026-11-01", description: "定期" },
    ],
  }
  const trips = deriveTransitTrips(ocr)
  check("チャージ・物販・残高・定期券を除いて移動だけを拾う", trips.length, 3)
  check(
    "移動の合計にチャージや物販が混ざらない",
    trips.reduce((s, t) => s + t.fare, 0),
    420 + 420 + 230
  )
  check("新しい日付が先頭に来る", trips[0].date, "2026-11-17")

  // 年が読み取れない履歴（"0000-MM-DD"）は推測で補わない
  const noYear = deriveTransitTrips({
    payments: [{ vendor_name: "南草津 → 草津", amount: 190, issue_date: "0000-11-15", description: "鉄道" }],
  })
  check("年が無い行も捨てずに残す", noYear.length, 1)
  check("年が無いことを判定できる", hasUnknownYear(noYear), true)
  check("年を当てはめられる", applyYear(noYear, 2026)[0].date, "2026-11-15")
  check("年が分かっている行は書き換えない", applyYear(trips, 2024)[0].date, "2026-11-17")

  // 金額が読めない行・区間が空の行は混ぜない
  const broken = deriveTransitTrips({
    payments: [
      { vendor_name: "", amount: 300, issue_date: "2026-11-10" },
      { vendor_name: "南草津 → 大津", amount: 0, issue_date: "2026-11-10" },
      { vendor_name: "南草津 → 大津", amount: null, issue_date: "2026-11-10" },
    ],
  })
  check("金額や区間が読めない行は除く", broken.length, 0)
}

if (failures.length === 0) {
  console.log(`✅ 支給ルールの検証：${passed}件すべて規程どおりです`)
  process.exit(0)
}
console.log(`❌ 支給ルールの検証：${failures.length}件が規程と一致しません（成功 ${passed}件）\n`)
for (const f of failures) console.log(f + "\n")
process.exit(1)