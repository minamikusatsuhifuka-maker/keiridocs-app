import { isPayEasyComplete, type PayEasyEntry } from "@/lib/gemini-shared"

/**
 * Pay-easy（ペイジー）納付の読み出しと状態判定。
 *
 * 納付に必要な番号は書類の解析結果（documents.ocr_raw.payeasy）に入っている。
 * DBの列は増やしていない（マイグレーション無しで運用できるようにするため）。
 *
 * ■ 納付書は2枚
 * 「税金分」と「手数料分」があり、銀行の画面では1回ずつ分けて操作する。
 * そのため、納付済みの記録も**1組ずつ**持つ（paid_at）。
 *
 * ■ 2枚の紐づけ
 * どちらの組にも同じ「申告番号」が入るため、別々のファイルで取り込まれても
 * 同じ納付として扱える（declaration_number）。
 */

export type { PayEasyEntry }
export { isPayEasyComplete }

/** 書類の解析結果から Pay-easy の組を読み出す（無ければ空配列） */
export function readPayEasy(ocrRaw: unknown): PayEasyEntry[] {
  if (!ocrRaw || typeof ocrRaw !== "object") return []
  const list = (ocrRaw as Record<string, unknown>).payeasy
  if (!Array.isArray(list)) return []

  const entries: PayEasyEntry[] = []
  for (const row of list) {
    if (!row || typeof row !== "object") continue
    const r = row as Record<string, unknown>
    const str = (v: unknown) => (typeof v === "string" ? v : "")
    entries.push({
      kind: str(r.kind) || "納付",
      institution_code: str(r.institution_code),
      customer_number: str(r.customer_number),
      confirmation_number: str(r.confirmation_number),
      amount: typeof r.amount === "number" ? r.amount : null,
      due_date: typeof r.due_date === "string" ? r.due_date : null,
      declaration_number: typeof r.declaration_number === "string" ? r.declaration_number : null,
      note: typeof r.note === "string" ? r.note : null,
      manual: r.manual === true,
      paid_at: typeof r.paid_at === "string" ? r.paid_at : null,
    })
  }
  return entries
}

/** Pay-easy で納付する書類か */
export function isPayEasyDocument(ocrRaw: unknown): boolean {
  return readPayEasy(ocrRaw).length > 0
}

/** 納付の状況 */
export type PayEasyState =
  /** Pay-easy の書類ではない */
  | { status: "none" }
  /** 番号が揃っていて未納付 */
  | { status: "unpaid"; total: number; paid: number }
  /** 2枚のうち一部だけ納付済み */
  | { status: "partial"; total: number; paid: number }
  /** すべて納付済み */
  | { status: "paid"; total: number; paid: number }
  /** 納付書のようだが番号が足りない（担当の対応が要る） */
  | { status: "incomplete"; total: number; missing: string[] }

/**
 * 書類の納付状況を判定する。
 *
 * 番号が足りない組が1つでもあれば incomplete を優先する。
 * 揃っていない番号で納付しようとして詰まるより、先に知らせたほうがよいため。
 */
export function payEasyState(ocrRaw: unknown): PayEasyState {
  const entries = readPayEasy(ocrRaw)
  if (entries.length === 0) return { status: "none" }

  const missing = entries.filter((e) => !isPayEasyComplete(e)).map((e) => e.kind)
  if (missing.length > 0) return { status: "incomplete", total: entries.length, missing }

  const paid = entries.filter((e) => !!e.paid_at).length
  if (paid === 0) return { status: "unpaid", total: entries.length, paid }
  if (paid < entries.length) return { status: "partial", total: entries.length, paid }
  return { status: "paid", total: entries.length, paid }
}

/** 一覧のバッジに出す文言（Pay-easy の書類でなければ null） */
export function payEasyBadgeLabel(ocrRaw: unknown): string | null {
  const s = payEasyState(ocrRaw)
  switch (s.status) {
    case "unpaid":
      return "💳 Pay-easy"
    case "partial":
      return `💳 Pay-easy ${s.paid}/${s.total}`
    case "paid":
      return "✓ 納付済み"
    case "incomplete":
      return "💳 要確認"
    default:
      return null
  }
}

/**
 * 納付の期限（最も早いもの）。期限アラートに使う。
 * すべて納付済みなら null（もう知らせる必要がない）。
 */
export function payEasyDueDate(ocrRaw: unknown): string | null {
  const entries = readPayEasy(ocrRaw).filter((e) => !e.paid_at && e.due_date)
  if (entries.length === 0) return null
  return entries.map((e) => e.due_date as string).sort()[0]
}

/**
 * 納付済みの印を付け外しした新しい ocr_raw を返す。
 *
 * 解析結果の他の項目はそのまま残す（上書きで消さない）。
 *
 * @param index 何組目か（0 から数える）
 * @param paid  true で納付済み、false で未納付に戻す
 */
export function withPayEasyPaid(ocrRaw: unknown, index: number, paid: boolean): unknown {
  const base = (ocrRaw && typeof ocrRaw === "object" ? ocrRaw : {}) as Record<string, unknown>
  const entries = readPayEasy(ocrRaw)
  if (index < 0 || index >= entries.length) return ocrRaw
  const next = entries.map((e, i) =>
    i === index ? { ...e, paid_at: paid ? new Date().toISOString() : null } : e
  )
  return { ...base, payeasy: next }
}

/**
 * 手で入力した番号で置き換えた新しい ocr_raw を返す。
 *
 * 読み取れなかったときに担当が入力する。納付済みの印は引き継ぐ。
 */
export function withPayEasyEntries(ocrRaw: unknown, entries: PayEasyEntry[]): unknown {
  const base = (ocrRaw && typeof ocrRaw === "object" ? ocrRaw : {}) as Record<string, unknown>
  return {
    ...base,
    payeasy: entries.map((e) => ({
      ...e,
      // 数字以外が混ざると銀行の入力欄で弾かれるため、保存前にも落とす
      institution_code: onlyDigits(e.institution_code),
      customer_number: onlyDigits(e.customer_number),
      confirmation_number: onlyDigits(e.confirmation_number),
    })),
  }
}

/** 全角を半角に直して数字だけを取り出す */
export function onlyDigits(value: string): string {
  return (value ?? "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\D/g, "")
}

/**
 * 同じ納付（申告番号が同じ）の書類をまとめるためのキー。
 * 2枚が別々のファイルで取り込まれても、同じ納付として扱える。
 */
export function payEasyGroupKey(ocrRaw: unknown): string | null {
  const n = readPayEasy(ocrRaw)
    .map((e) => e.declaration_number)
    .find((v) => !!v)
  return n ?? null
}

/**
 * 分割登録のとき、その支払いに対応する Pay-easy の組だけを選ぶ。
 *
 * 1つのファイルに「税金分」と「手数料分」が並ぶ納付書は、分割登録で
 * 2件の書類になる。このとき両方に2組ずつ持たせてしまうと、
 * 片方の書類で納付済みにしても、もう片方は未納付のまま残り、
 * 一覧の表示が食い違う。
 *
 * 対応づけは次の順で試す。
 *   1. 金額の一致（いちばん確実）
 *   2. 払込内容・受入科目の文字が含まれる
 *   3. 並び順（1件目は1件目、2件目は2件目）
 *
 * どれにも当てはまらなければ空にする。間違った番号を見せるより、
 * 「読み取れていない」として担当に確認してもらうほうが安全なため。
 *
 * @param list  解析結果の payeasy（全組）
 * @param split その書類になる支払い（金額・摘要）
 * @param index 何件目の分割か（0 から数える）
 */
export function payEasyForSplit(
  list: unknown,
  split: { amount?: number | null; description?: string | null; vendor_name?: string | null },
  index: number
): PayEasyEntry[] {
  const entries = readPayEasy({ payeasy: list })
  if (entries.length === 0) return []
  // 分割していない（1組だけ）ならそのまま渡す
  if (entries.length === 1) return entries

  // 1. 金額の一致
  const byAmount = entries.filter(
    (e) => typeof split.amount === "number" && e.amount === split.amount
  )
  if (byAmount.length === 1) return byAmount

  // 2. 払込内容・受入科目の文字が含まれるか
  const text = `${split.description ?? ""} ${split.vendor_name ?? ""}`
  const byNote = entries.filter((e) => {
    const note = (e.note ?? "").trim()
    return note.length >= 2 && text.includes(note)
  })
  if (byNote.length === 1) return byNote

  // 3. 並び順
  return entries[index] ? [entries[index]] : []
}

/**
 * 再解析したときに、残しておくべき情報を引き継ぐ。
 *
 * 再解析は解析結果でまるごと上書きするため、そのままだと
 *  - 納付済みの記録（paid_at）が消える
 *  - 分割登録した書類に、2組とも戻ってしまう
 * という困ったことが起きる。
 *
 * 納付済みの記録は、番号が同じ組に引き継ぐ（番号が変わったなら別の納付）。
 *
 * @param previousRaw 元の解析結果（納付済みの記録と分割情報を持つ）
 * @param nextRaw     再解析した結果
 */
export function mergePayEasyOnReanalyze(previousRaw: unknown, nextRaw: unknown): unknown {
  const prev = (previousRaw && typeof previousRaw === "object" ? previousRaw : {}) as Record<
    string,
    unknown
  >
  const next = (nextRaw && typeof nextRaw === "object" ? nextRaw : {}) as Record<string, unknown>

  // 分割登録の情報は解析結果に含まれないため引き継ぐ
  const splitKeys = ["split_group", "split_index", "split_total", "split_payment"] as const
  const carried: Record<string, unknown> = {}
  for (const k of splitKeys) {
    if (prev[k] !== undefined) carried[k] = prev[k]
  }

  let entries = readPayEasy(next)

  // 分割登録の書類は、その支払いの分だけに絞る
  const split = prev.split_payment as
    | { amount?: number | null; description?: string | null; vendor_name?: string | null }
    | undefined
  if (split && entries.length >= 2) {
    const index = typeof prev.split_index === "number" ? prev.split_index - 1 : 0
    entries = payEasyForSplit(entries, split, index)
  }

  // 納付済みの記録を、同じ番号の組に引き継ぐ
  const paidKeys = new Set(
    readPayEasy(prev)
      .filter((e) => !!e.paid_at)
      .map(payEasyKey)
  )
  const prevByKey = new Map(readPayEasy(prev).map((e) => [payEasyKey(e), e]))
  entries = entries.map((e) =>
    paidKeys.has(payEasyKey(e)) ? { ...e, paid_at: prevByKey.get(payEasyKey(e))?.paid_at ?? null } : e
  )

  return { ...next, ...carried, payeasy: entries }
}

/** 同じ納付かを比べるためのキー（番号が同じなら同じ納付） */
function payEasyKey(e: PayEasyEntry): string {
  return `${e.institution_code}|${e.customer_number}|${e.confirmation_number}`
}
