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
  availableItems,
  computeSubsidy,
  type CourseKind,
  type ExpenseItem,
} from "../src/lib/subsidy-rules"

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
  isRepeat?: boolean
  travelCapUsed?: number
  monthlyCapUsed?: number
}) {
  const r = computeSubsidy(p)
  return { 支給: r.subsidy, 超過: r.excess, 承認既定値: r.suggestedApproval }
}

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
])

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
if (failures.length === 0) {
  console.log(`✅ 支給ルールの検証：${passed}件すべて規程どおりです`)
  process.exit(0)
}
console.log(`❌ 支給ルールの検証：${failures.length}件が規程と一致しません（成功 ${passed}件）\n`)
for (const f of failures) console.log(f + "\n")
process.exit(1)
