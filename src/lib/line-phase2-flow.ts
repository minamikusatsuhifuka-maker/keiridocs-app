/**
 * LINE申請フロー（フェーズ2の費用区分）の組み立て。
 *
 * 画面の文言と選択肢をここに集め、webhook 側は送信とDB更新だけを行う。
 * 支給額の計算は subsidy-rules / subsidy-assess に任せ、ここでは一切行わない。
 *
 * ■ 流れ
 *   1. 何の費用か            講座・研修 ／ それ以外
 *   2a. 講座・研修 → 講座を選ぶ（講座マスタ。無ければ名称を入力 → 担当が割り当て）
 *   2b. それ以外   → 内訳を選ぶ（書籍代／診療費／検定・試験／交通費／その他）
 *   3. 内訳を選ぶ（講座の分類で出し分け。弁当代・アカデミー会費は対象講座のみ）
 *   4. 確認（初回／再受講の判定・上限・支給額を表示）→ OK で確定
 *
 * ■ スタッフに見せる言葉
 *   「担当」と書く（「院長」とは書かない）。
 *   上限を超えても申請は止めず、担当が確認する旨を伝える。
 */

import {
  EXPENSE_ITEM_LABELS,
  availableItems,
  type CourseKind,
  type CourseRule,
  type ExpenseItem,
} from "@/lib/subsidy-rules"

/** 講座マスタの1件（選択肢に使う最小限） */
export interface CourseChoice {
  id: string
  name: string
  kind: CourseKind
  rule: CourseRule
}

/**
 * 第1階層の選択肢。
 *
 * 以前は「講座・研修」「それ以外」の2つで、検定・試験が「それ以外」に
 * 埋もれ、アチーブメントの講座と他社の研修も同じ入口だった。
 * 申請するときの頭の中の分け方に合わせて4つに分ける。
 */
export const PHASE2_GROUPS = [
  {
    key: "ach",
    label: "アチーブメントの講座",
    help: "ATC、頂点への道、ダイナミックコースなど",
  },
  {
    key: "training",
    label: "その他の研修・セミナー",
    help: "アチーブメント以外の研修、JPSAなど",
  },
  {
    key: "exam",
    label: "検定・試験",
    help: "受験料。合格通知・修了通知の写真で全額",
  },
  {
    key: "expense",
    label: "その他の経費",
    help: "書籍代、診療費、通常業務の交通費、買い物",
  },
] as const

export type Phase2Group = (typeof PHASE2_GROUPS)[number]["key"]

/** その講座がどの第1階層に入るか */
export function groupOfCourseKind(kind: CourseKind): Phase2Group {
  if (kind === "exam") return "exam"
  if (kind === "non_ach" || kind === "jpsa") return "training"
  return "ach"
}

/** 「講座が一覧に無い」を選んだときの印。講座IDの代わりに使う */
export const COURSE_NOT_LISTED = "__none__"

/**
 * 「それ以外」の内訳。
 *
 * exam（受験料）は合格通知・修了通知の写真が必要なため、選んだあとに確認を挟む。
 * commute は通常業務の交通費（上限なし・全額）。
 */
export const OTHER_ITEMS: { item: ExpenseItem; label: string; help: string }[] = [
  { item: "books", label: "書籍代", help: "1か月あたり5,000円まで（20日締め）" },
  { item: "medical", label: "診療費", help: "1か月あたり5,000円まで（20日締め）・書籍代とは別枠" },
  { item: "commute", label: "交通費（通常業務）", help: "研修以外の交通費" },
  { item: "other", label: "その他（買い物など）", help: "内容を1行入力していただきます" },
]

/** 第1階層の案内文 */
export function groupPrompt(header: string): string {
  return (
    `${header}\n` +
    "何の費用ですか？\n\n" +
    PHASE2_GROUPS.map((g) => `・${g.label} … ${g.help}`).join("\n")
  )
}

/** 講座選択の案内文。AIが読み取った講座名に近いものを先頭に出す旨も伝える */
export function coursePrompt(guessed: string | null): string {
  const lead = guessed
    ? `領収書から「${guessed}」と読み取りました。\n違う場合は正しい講座を選んでください。\n\n`
    : ""
  return (
    `${lead}どの講座ですか？\n\n` +
    "交通費・宿泊費の上限（合計30,000円）は講座ごとに見るため、\n" +
    "受講料・交通費・宿泊費・弁当代は同じ講座を選んでください。"
  )
}

/**
 * 講座名をAIの読み取り結果に近い順に並べる。
 *
 * クイックリプライは13個までのため、心当たりのある講座が埋もれないようにする。
 * 一致は「どちらかが相手を含む」だけを見る簡単な判定にとどめ、
 * 外れても本人が選び直せるようにする（自動で確定はしない）。
 */
export function sortCoursesByGuess(courses: CourseChoice[], guessed: string | null): CourseChoice[] {
  if (!guessed) return courses
  const norm = (v: string) => v.normalize("NFKC").replace(/[\s　]/g, "").toLowerCase()
  const g = norm(guessed)
  if (!g) return courses
  const score = (c: CourseChoice) => {
    const n = norm(c.name)
    if (!n) return 0
    if (n === g) return 3
    if (g.includes(n) || n.includes(g)) return 2
    return 0
  }
  return [...courses].sort((a, b) => score(b) - score(a))
}

/** 内訳選択の案内文（講座の分類で選べる内訳が変わる） */
export function itemPrompt(courseName: string, kind: CourseKind): string {
  const items = availableItems(kind)
  const lines = items.map((i) => `・${EXPENSE_ITEM_LABELS[i]}${itemHelp(i)}`)
  return `「${courseName}」の何の費用ですか？\n\n${lines.join("\n")}`
}

/** 内訳ごとの補足（規程のうちスタッフが知る必要のあることだけ） */
export function itemHelp(item: ExpenseItem): string {
  switch (item) {
    case "transport":
    case "lodging":
      return " … 交通費と宿泊費で合計30,000円まで"
    case "bento":
      return " … アチーブメントに事前申し込みした弁当のみ"
    case "membership":
      return " … 受講料とは分けて申請してください（全額支給）"
    default:
      return ""
  }
}

/** 検定・試験を選んだときの確認文 */
export function examAttachPrompt(): string {
  return (
    "合格通知または修了通知の写真は、この領収書と一緒に送っていただけましたか？\n\n" +
    "通知の写真があれば受験料を全額支給します。\n" +
    "まだの場合も申請はできます。担当が確認し、通知が届いてから確定します。"
  )
}

/** 講座名を手入力してもらうときの案内文 */
export function courseNamePrompt(): string {
  return (
    "講座名を送ってください。\n" +
    "（例）アチーブメントテクノロジーコース\n\n" +
    "一覧に無い講座は、担当が確認して登録します。\n" +
    "そのため支給額の確定が少し遅くなります。"
  )
}

/** 支給率の表示（確認カードの「支給額」の下に出す一言） */
export function rateLabel(rate: number, item: ExpenseItem): string {
  if (rate >= 1) return "全額支給"
  if (item === "tuition") return "再受講のため半額支給"
  return "半額支給"
}

/** 保留（担当の確認待ち）になったときに本人へ伝える一言 */
export function holdNotice(reason: string): string {
  switch (reason) {
    case "excess":
      return "上限を超えた分は、担当が確認のうえご連絡します。"
    case "course":
      return "講座の登録後に支給額が決まります。担当が確認します。"
    case "attach":
      return "合格通知・修了通知の写真が届いてから確定します。"
    case "history":
      return "受講回数の確認が必要です。担当が確認のうえ確定します。"
    case "undecided":
      return "この講座の支給率は決まっていないため、担当が確認のうえ確定します。"
    default:
      return "担当が確認のうえ確定します。"
  }
}
