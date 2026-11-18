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
  calcBreakdownLines,
  calcStoredSubsidy,
  computeSubsidy,
  needsDetailReview,
  isWithinAcademyTerm,
  type CourseKind,
  type CourseRule,
  type ExpenseItem,
} from "../src/lib/subsidy-rules"
import {
  applyYear,
  assignRegisteredTrips,
  deriveTransitTrips,
  hasUnknownYear,
} from "../src/lib/transit-history"
import { resolveTravelWindow } from "../src/lib/subsidy-assess"

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

/* ---------- ピークパフォーマンスコースの交通費（2026-11-18 の実機テスト） ----------
 *
 * 枠が空であれば、どちらも超過なしで半額支給になること。
 * 実機では過去のテスト申請で枠が 2,190円 消費されていたため
 * ①が支給0円・②が超過130円になっていた（枠の数え方の不具合）。
 */
{
  const half = { item: "transport" as const, courseKind: "ach_other" as const, courseRule: "half" as const }

  // ① 在来線 240+490+490+240 = 1,460円
  check("在来線 ¥1,460（半額・枠未使用）→ 支給 ¥730・超過なし", calc({ ...half, amount: 1460 }), {
    支給: 730,
    超過: 0,
    承認既定値: 0,
  })

  // ② 新幹線往復 13,970 × 2 = 27,940円
  check("新幹線往復 ¥27,940（半額・枠未使用）→ 支給 ¥13,970・超過なし", calc({ ...half, amount: 27940 }), {
    支給: 13970,
    超過: 0,
    承認既定値: 0,
  })

  // ①②を続けて申請した場合の合計（1,460 + 27,940 = 29,400円 ≦ 30,000円）
  check(
    "①のあとに②を申請しても上限内（合計 ¥29,400）",
    calc({ ...half, amount: 27940, travelCapUsed: 1460 }),
    { 支給: 13970, 超過: 0, 承認既定値: 0 }
  )
  check("①②の支給額の合計は ¥14,700", 730 + 13970, 14700)

  // 不具合の再現（修正前の値）。枠が誤って消費されていると こうなる
  check(
    "【不具合の再現】枠が2,190円消費されていると ②は超過130円になる",
    calc({ ...half, amount: 27940, travelCapUsed: 2190 }),
    { 支給: 13905, 超過: 130, 承認既定値: 65 }
  )
  check(
    "【不具合の再現】枠を使い切っていると ①は支給0円・超過1,460円になる",
    calc({ ...half, amount: 1460, travelCapUsed: 30000 }),
    { 支給: 0, 超過: 1460, 承認既定値: 730 }
  )
}

/* ---------- 新幹線と在来線を分けて申請しても1つの講座で累計する ----------
 *
 * 1回の移動が新幹線と在来線に分かれ、別々に申請されることがある。
 * 枠は「講座ごと 合計30,000円」なので、同じ講座の交通費・宿泊費は
 * 申請が分かれても累計し、超えた分は担当の承認に回す。
 */
{
  const half = {
    item: "transport" as const,
    courseKind: "ach_other" as const,
    courseRule: "half" as const,
  }

  // 在来線 → 新幹線（合計 29,400円。上限内）
  const local = calc({ ...half, amount: 1460 })
  check("① 在来線 ¥1,460 → 支給 ¥730", local, { 支給: 730, 超過: 0, 承認既定値: 0 })
  const shinkansen = calc({ ...half, amount: 27940, travelCapUsed: 1460 })
  check("② 新幹線往復 ¥27,940（在来線1,460円を累計）→ 支給 ¥13,970", shinkansen, {
    支給: 13970,
    超過: 0,
    承認既定値: 0,
  })
  check("①②の支給額の合計", local.支給 + shinkansen.支給, 14700)

  // 宿泊費も同じ枠（交通費＋宿泊費 合計30,000円）
  check(
    "宿泊費も同じ枠で累計する",
    calc({ ...half, item: "lodging", amount: 10000, travelCapUsed: 29400 }),
    // 残枠600円 → 支給300円、超過9,400円（承認すれば半額の4,700円）
    { 支給: 300, 超過: 9400, 承認既定値: 4700 }
  )

  // 超えた場合：上限までは自動で半額支給し、超過分は担当の承認
  const over = calc({ ...half, amount: 30000, travelCapUsed: 5000 })
  check("在来線5,000円のあと新幹線30,000円 → 残枠25,000円まで半額", over, {
    支給: 12500,
    超過: 5000,
    承認既定値: 2500, // 超過分も半額（半額支給の講座のため）
  })

  // 担当が超過分を承認したあとの保存済み明細からの支給額
  check(
    "超過分 ¥2,500 を承認すると支給額は ¥15,000（30,000円の半額）",
    calcStoredSubsidy({
      amount: 30000,
      subsidy_category: "achievement_repeat",
      expense_item: "transport",
      excess_amount: 5000,
      approved_excess: 2500,
    }),
    15000
  )
  check(
    "超過分を承認しない（0円）場合は上限分の半額だけ",
    calcStoredSubsidy({
      amount: 30000,
      subsidy_category: "achievement_repeat",
      expense_item: "transport",
      excess_amount: 5000,
      approved_excess: 0,
    }),
    12500
  )
  check(
    "未承認（NULL）は加算しない",
    calcStoredSubsidy({
      amount: 30000,
      subsidy_category: "achievement_repeat",
      expense_item: "transport",
      excess_amount: 5000,
      approved_excess: null,
    }),
    12500
  )

  // 枠を使い切ったあとの申請は全額が超過（承認すれば半額）
  check(
    "枠を使い切ったあとの在来線 ¥1,460 は全額が超過",
    calc({ ...half, amount: 1460, travelCapUsed: 30000 }),
    { 支給: 0, 超過: 1460, 承認既定値: 730 }
  )
}

/* ---------- 交通費・宿泊費の枠を数える範囲（受講ごと・領収書の日付で束ねる） ----------
 *
 * 申請の順番は本人任せで管理できないため、提出日時ではなく
 * **領収書の日付**で受講ごとに束ねる。どの順で出しても同じ結果になること。
 */
{
  const C = "course-1"
  const row = (p: { item: string; date: string; course?: string; createdAt?: string }) => ({
    id: `${p.item}-${p.date}`,
    amount: 1000,
    expense_item: p.item,
    course_id: p.course ?? C,
    excess_amount: 0,
    staff_receipt_id: null,
    created_at: p.createdAt ?? `${p.date}T00:00:00Z`,
    transaction_date: p.date,
  })
  const win = (
    rows: ReturnType<typeof row>[],
    judgeDate: string | null,
    manual: string | null = null
  ) => resolveTravelWindow(rows, C, manual, judgeDate)

  check("受講料の実績が無ければ全期間を数える", win([], "2026-11-17"), {
    fromDate: null,
    toDate: null,
    manualAt: null,
    origin: "all",
  })

  // 受講料が1回（初受講）
  const one = [row({ item: "tuition", date: "2026-06-10" })]
  check("受講料の日付以降が同じ受講の枠", win(one, "2026-07-01"), {
    fromDate: "2026-06-10",
    toDate: null,
    manualAt: null,
    origin: "tuition",
  })
  check("受講料より前の領収書は別の枠（受講前の分）", win(one, "2026-05-01"), {
    fromDate: null,
    toDate: "2026-06-10",
    manualAt: null,
    origin: "all",
  })

  // 受講料が2回（再受講）→ 期間で区切る
  const two = [
    row({ item: "tuition", date: "2026-01-10" }),
    row({ item: "tuition", date: "2026-06-10" }),
  ]
  check("1回目の受講の範囲は 1/10〜6/10", win(two, "2026-03-01"), {
    fromDate: "2026-01-10",
    toDate: "2026-06-10",
    manualAt: null,
    origin: "tuition",
  })
  check("2回目の受講の範囲は 6/10以降", win(two, "2026-07-01"), {
    fromDate: "2026-06-10",
    toDate: null,
    manualAt: null,
    origin: "tuition",
  })
  check("受講料と同じ日付の交通費は、その受講に入る", win(two, "2026-06-10"), {
    fromDate: "2026-06-10",
    toDate: null,
    manualAt: null,
    origin: "tuition",
  })

  // 申請の順番に依存しないこと（提出日時を入れ替えても同じ結果）
  const reordered = [
    row({ item: "tuition", date: "2026-06-10", createdAt: "2026-07-20T00:00:00Z" }),
    row({ item: "transport", date: "2026-06-12", createdAt: "2026-06-13T00:00:00Z" }),
  ]
  check(
    "受講料を後から申請しても、6/12の交通費は同じ受講の枠に入る",
    win(reordered, "2026-06-15"),
    { fromDate: "2026-06-10", toDate: null, manualAt: null, origin: "tuition" }
  )

  check(
    "別の講座の受講料は範囲に影響しない",
    win([row({ item: "tuition", date: "2026-06-10", course: "course-2" })], "2026-07-01"),
    { fromDate: null, toDate: null, manualAt: null, origin: "all" }
  )

  // 領収書の日付が読めていない場合は束ねない（全期間＝安全側）
  check("今回の日付が読めなければ束ねない", win(two, null), {
    fromDate: null,
    toDate: null,
    manualAt: null,
    origin: "all",
  })

  // 手動の数え直しは日付の束ねと併用する
  check(
    "手動の数え直しは範囲と併用する",
    win(two, "2026-07-01", "2026-07-15T00:00:00Z"),
    {
      fromDate: "2026-06-10",
      toDate: null,
      manualAt: "2026-07-15T00:00:00Z",
      origin: "tuition",
    }
  )
  check("講座に紐づかない申請は束ねない", resolveTravelWindow([], null, null, "2026-11-17"), {
    fromDate: null,
    toDate: null,
    manualAt: null,
    origin: "all",
  })
}

/* ---------- 確認画面に出す計算内訳 ---------- */
{
  // 上限も控除もない申請では何も出さない（画面を無駄に長くしない）
  check(
    "通常業務の交通費は内訳を出さない",
    calcBreakdownLines(
      { subsidy: 1520, excess: 0, cap: null, rate: 1, capUsed: 0, holdReason: null },
      1520,
      "commute"
    ),
    []
  )

  // 講座名つきで累計を出す（本人がどの講座の枠か分かるように）
  check(
    "講座名つきで累計と残枠を出す（累計0円でも出す）",
    calcBreakdownLines(
      {
        subsidy: 730,
        excess: 0,
        cap: 30000,
        rate: 0.5,
        capUsed: 0,
        holdReason: null,
        capWindowOrigin: "tuition",
        capWindowFrom: "2026-06-10",
        capWindowTo: null,
      },
      1460,
      "transport",
      "ピークパフォーマンスコース"
    ),
    [
      "上限：ピークパフォーマンスコースの交通費・宿泊費 累計 ¥30,000",
      "数える範囲：今回の受講分（2026-06-10の受講料以降）",
      "これまでの累計：¥0",
      "残りの枠：¥30,000",
      "今回の立替額：¥1,460",
      "うち上限の対象：¥1,460",
      "支給率：50％（半額支給の講座）",
      "支給額：¥730",
    ]
  )

  // 在来線のあとに新幹線を出した場合（累計が見える）
  check(
    "累計があるときは残枠と合わせて出す",
    calcBreakdownLines(
      {
        subsidy: 13970,
        excess: 0,
        cap: 30000,
        rate: 0.5,
        capUsed: 1460,
        holdReason: null,
        capWindowOrigin: "tuition",
        capWindowFrom: "2026-06-10",
        capWindowTo: "2026-12-01",
      },
      27940,
      "transport",
      "ピークパフォーマンスコース"
    ),
    [
      "上限：ピークパフォーマンスコースの交通費・宿泊費 累計 ¥30,000",
      "数える範囲：今回の受講分（2026-06-10の受講料以降／2026-12-01の受講料より前）",
      "これまでの累計：¥1,460",
      "残りの枠：¥28,540",
      "今回の立替額：¥27,940",
      "うち上限の対象：¥27,940",
      "支給率：50％（半額支給の講座）",
      "支給額：¥13,970",
    ]
  )

  // 超過したときは担当の確認に回ることを出す
  check(
    "超過分は担当が確認することを出す",
    calcBreakdownLines(
      {
        subsidy: 12500,
        excess: 5000,
        cap: 30000,
        rate: 0.5,
        capUsed: 5000,
        holdReason: "excess",
        capWindowOrigin: "tuition",
        capWindowFrom: "2026-06-10",
      },
      30000,
      "transport",
      "ピークパフォーマンスコース"
    ).slice(-1),
    ["上限を超えた分：¥5,000（担当が確認します）"]
  )

  // 講座名が分からないときも累計の意味が分かるようにする
  check(
    "講座名が無い場合は「この講座の」と出す",
    calcBreakdownLines(
      { subsidy: 730, excess: 0, cap: 30000, rate: 0.5, capUsed: 0, holdReason: null },
      1460,
      "transport"
    )[0],
    "上限：この講座の交通費・宿泊費 累計 ¥30,000"
  )

  // 定期券区間の控除も理由を出す
  check(
    "定期券区間を含む場合は控除の理由を出す",
    calcBreakdownLines(
      { subsidy: 1000, excess: 0, cap: 30000, rate: 1, capUsed: 0, holdReason: "pass" },
      1000,
      "transport"
    ).slice(-1),
    ["定期券区間の運賃が含まれている可能性があるため、担当が差し引く額を確認します。"]
  )

  check(
    "書籍代は「今月」の上限として出す",
    calcBreakdownLines(
      { subsidy: 5000, excess: 1000, cap: 5000, rate: 1, capUsed: 0, holdReason: "excess" },
      6000,
      "books"
    )[0],
    "上限：今月 ¥5,000"
  )
}

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


/* ---------- 申請済みの移動の割り当て（同じ内容が複数あっても止めない） ----------
 *
 * 同じ日に同じ区間・同じ運賃の移動が複数あることは普通にある。
 * 1件申請しただけで残りまで「申請済み」になると、続けて申請できなくなる。
 */
{
  const t = (date: string, route: string, fare: number) => ({ date, route, fare })
  const key = (x: { date: string; route: string; fare: number }) =>
    `${x.route}|${x.fare}|${x.date}`
  const trips = [
    t("2026-11-17", "京都 → 大津京", 240), // 0
    t("2026-11-17", "大津京 → 京都", 240), // 1
    t("2026-11-17", "京都 → 大津京", 240), // 2（0と同じ内容）
    t("2026-11-17", "大津京 → 京都", 240), // 3（1と同じ内容）
    t("2026-11-17", "京都 → 米原", 990), // 4
  ]
  const ids = (s: Set<number>) => [...s].sort((a, b) => a - b)

  check("何も申請していなければ全件選べる", ids(assignRegisteredTrips(trips, [], [], key)), [])

  // 1件だけ登録済み → 同じ内容の残り1件はまだ選べる
  check(
    "同じ内容が2件あり1件登録済みなら、申請済みは1件だけ",
    ids(assignRegisteredTrips(trips, [key(trips[0])], [], key)),
    [0]
  )
  check(
    "同じ内容が2件とも登録済みなら、2件とも申請済み",
    ids(assignRegisteredTrips(trips, [key(trips[0]), key(trips[2])], [], key)),
    [0, 2]
  )

  // 元の画像側の番号（確実な情報）を優先し、二重に数えない
  check(
    "番号で分かっている分は、その内容の枠を使ったものとして数える",
    ids(assignRegisteredTrips(trips, [key(trips[0])], [2], key)),
    [2]
  )
  check(
    "番号と件数が両方ある場合は合わせて割り当てる",
    ids(assignRegisteredTrips(trips, [key(trips[0]), key(trips[2])], [2], key)),
    [0, 2]
  )

  // 1件目の講座を申請したあと、2件目の講座を続けて申請できること
  const afterFirst = assignRegisteredTrips(trips, [key(trips[0]), key(trips[1])], [0, 1], key)
  check("1件目の申請後に残りが選べる", ids(afterFirst), [0, 1])
  check(
    "残りの移動（2・3・4番）は申請できる",
    [2, 3, 4].every((i) => !afterFirst.has(i)),
    true
  )

  // 登録済みが読めなかった場合は、番号の情報だけで進める
  check("登録済みが取れなくても番号の分は守る", ids(assignRegisteredTrips(trips, [], [1], key)), [1])

  check(
    "範囲外の番号は無視する",
    ids(assignRegisteredTrips(trips, [], [99, -1, 3], key)),
    [3]
  )
}

/* ---------- 結果 ---------- */

if (failures.length === 0) {
  console.log(`✅ 支給ルールの検証：${passed}件すべて規程どおりです`)
  process.exit(0)
}
console.log(`❌ 支給ルールの検証：${failures.length}件が規程と一致しません（成功 ${passed}件）\n`)
for (const f of failures) console.log(f + "\n")
process.exit(1)