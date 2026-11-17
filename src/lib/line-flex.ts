/**
 * LINE Flex Message（カード）の組み立てを1箇所にまとめたモジュール。
 *
 * - 色はすべて下の FLEX_COLORS（名前付き定数）から使う。配色を変えるときはこのファイルだけを直す。
 *   値はUI指示書のカラートークンそのまま（文字色はコントラスト比4.5:1以上を満たす値。変更しないこと）。
 * - Flex ではフォントを指定できないため、size / weight / color だけで整える。
 * - すべての text は wrap:true（端末の文字サイズを大きくしても切れないように）。
 * - ボタンはカード内に置く（クイックリプライは色を指定できないため）。
 *
 * ■ LINEの上限（本モジュールで超えないようにしている値）
 *   - altText … 上限1,500文字 → ALT_TEXT_MAX（400文字）で切り詰める
 *   - bubble 1個のJSON … 上限30KB → FLEX_SIZE_LIMIT_BYTES を超えたら呼び出し側でテキストに切り替える
 *   - carousel … バブル12個・50KBまで（本アプリでは carousel を使わず、履歴は1バブルに直近5件まで）
 *   - postback.data … 300文字まで（本アプリのデータは短いキーのみ）
 */

/* ---------- カラートークン ---------- */

export const FLEX_COLORS = {
  /** ブラウン（濃）: ヘッダー帯・主ボタン */
  brownDark: "#8A6246",
  /** カード地 */
  cardBg: "#FFFCF7",
  /** カード枠 */
  cardBorder: "#E0CDB2",
  /** 内パネル地・枠 */
  panelBg: "#FAF2E6",
  panelBorder: "#EBDCC6",
  /** 区切り線 */
  separator: "#EBDCC6",
  /** 文字（主・副） */
  textMain: "#4A3728",
  textSub: "#86705C",
  /** 取り消し済みの支払先（取り消し線が使えないため色で区別） */
  textCancelled: "#8A7765",
  /** 副ボタン枠・文字 */
  secondaryBorder: "#CDB899",
  secondaryText: "#6B5A4A",
  /** ヘッダー文字 */
  headerText: "#FFFFFF",
  /** 支給額ブロック */
  payBg: "#E9EDD8",
  payText: "#41501F",
  /** 注意ブロック */
  cautionBg: "#F7E7CC",
  cautionText: "#5E3708",
  cautionStrong: "#74440A",
} as const

/** 状態バッジ（後から状態を増やせるよう、表示名と色をここで定義する） */
export const STATUS_BADGES = {
  registered: { label: "登録済み", bg: "#E4EACF", text: "#41501F" },
  cancelled: { label: "取り消し済み", bg: "#EDE4D6", text: "#6B5A4A" },
  awaiting_attachment: { label: "添付待ち", bg: "#F7E3C4", text: "#74440A" },
  category_pending: { label: "区分確認中", bg: "#E6EDFA", text: "#1E4175" },
  // 担当の確認待ち（上限超過・内容の確認など）。支給月がずれることがある
  reviewing: { label: "担当が確認中", bg: "#F7E3C4", text: "#74440A" },
} as const

export type ApplicationStatus = keyof typeof STATUS_BADGES

/* ---------- 上限 ---------- */

export const ALT_TEXT_MAX = 400
/** bubble 1個の上限30KBに対し余裕を持たせた値 */
export const FLEX_SIZE_LIMIT_BYTES = 25 * 1024

/* ---------- 型（LINE Flex の必要最小限） ---------- */

export type FlexComponent = Record<string, unknown>

export interface PostbackActionDef {
  type: "postback"
  label: string
  data: string
  displayText?: string
}

export interface MessageActionDef {
  type: "message"
  label: string
  text: string
}

export type ActionDef = PostbackActionDef | MessageActionDef

export interface QuickReplyItem {
  type: "action"
  action: ActionDef
}

export interface FlexMessage {
  type: "flex"
  altText: string
  contents: FlexComponent
  quickReply?: { items: QuickReplyItem[] }
}

/* ---------- 部品 ---------- */

/** 本文テキスト */
export function text(
  value: string,
  opts: { size?: string; weight?: "regular" | "bold"; color?: string; align?: string; flex?: number; margin?: string } = {}
): FlexComponent {
  return {
    type: "text",
    text: value || " ",
    wrap: true,
    size: opts.size ?? "sm",
    weight: opts.weight ?? "regular",
    color: opts.color ?? FLEX_COLORS.textMain,
    ...(opts.align ? { align: opts.align } : {}),
    ...(opts.flex !== undefined ? { flex: opts.flex } : {}),
    ...(opts.margin ? { margin: opts.margin } : {}),
  }
}

/** 補足文（副文字色） */
export function note(value: string, margin = "md"): FlexComponent {
  return text(value, { size: "xs", color: FLEX_COLORS.textSub, margin })
}

/** 情報行（ラベル ／ 値 bold、横並び） */
export function infoRow(label: string, value: string, opts: { valueColor?: string; sub?: string } = {}): FlexComponent {
  const valueBox: FlexComponent[] = [
    text(value, { weight: "bold", color: opts.valueColor ?? FLEX_COLORS.textMain, align: "end" }),
  ]
  if (opts.sub) valueBox.push(text(opts.sub, { size: "xxs", color: FLEX_COLORS.textSub, align: "end" }))
  return {
    type: "box",
    layout: "horizontal",
    spacing: "md",
    margin: "sm",
    contents: [
      text(label, { color: FLEX_COLORS.textSub, flex: 3 }),
      { type: "box", layout: "vertical", flex: 5, contents: valueBox },
    ],
  }
}

/** 区切り線 */
export function separator(margin = "md"): FlexComponent {
  return { type: "separator", color: FLEX_COLORS.separator, margin }
}

/** 情報ブロック（内パネル） */
export function panel(contents: FlexComponent[], margin = "md"): FlexComponent {
  return {
    type: "box",
    layout: "vertical",
    backgroundColor: FLEX_COLORS.panelBg,
    borderColor: FLEX_COLORS.panelBorder,
    borderWidth: "1px",
    cornerRadius: "12px",
    paddingAll: "12px",
    margin,
    contents,
  }
}

/** 支給額ブロック */
export function payBlock(label: string, amountText: string, sub?: string): FlexComponent {
  const contents: FlexComponent[] = [
    {
      type: "box",
      layout: "horizontal",
      contents: [
        text(label, { color: FLEX_COLORS.payText, weight: "bold", flex: 5 }),
        text(amountText, { color: FLEX_COLORS.payText, weight: "bold", size: "lg", align: "end", flex: 4 }),
      ],
    },
  ]
  if (sub) contents.push(text(sub, { size: "xs", color: FLEX_COLORS.payText, margin: "xs" }))
  return {
    type: "box",
    layout: "vertical",
    backgroundColor: FLEX_COLORS.payBg,
    cornerRadius: "12px",
    paddingAll: "12px",
    margin: "md",
    contents,
  }
}

/**
 * 注意ブロック。lines の各要素は文字列、または強調したい部分を含む span 配列。
 * 例: [["過去の申請記録から", {strong:"2回目以降"}, "として計算します。"]]
 */
export type CautionSpan = string | { strong: string }
export function cautionBlock(lines: (string | CautionSpan[])[]): FlexComponent {
  const contents = lines.map((line) => {
    if (typeof line === "string") return text(line, { color: FLEX_COLORS.cautionText })
    return {
      type: "text",
      wrap: true,
      size: "sm",
      color: FLEX_COLORS.cautionText,
      contents: line.map((s) =>
        typeof s === "string"
          ? { type: "span", text: s }
          : { type: "span", text: s.strong, weight: "bold", color: FLEX_COLORS.cautionStrong }
      ),
    }
  })
  return {
    type: "box",
    layout: "vertical",
    spacing: "xs",
    backgroundColor: FLEX_COLORS.cautionBg,
    cornerRadius: "12px",
    paddingAll: "12px",
    margin: "md",
    contents,
  }
}

/** 状態バッジ（右寄せ用に flex:0） */
export function statusBadge(status: ApplicationStatus): FlexComponent {
  const b = STATUS_BADGES[status]
  return {
    type: "box",
    layout: "vertical",
    flex: 0,
    backgroundColor: b.bg,
    cornerRadius: "10px",
    paddingStart: "8px",
    paddingEnd: "8px",
    paddingTop: "2px",
    paddingBottom: "2px",
    contents: [text(b.label, { size: "xxs", weight: "bold", color: b.text })],
  }
}

/** 主ボタン（ブラウン地・白文字） */
export function primaryButton(action: ActionDef): FlexComponent {
  return { type: "button", style: "primary", color: FLEX_COLORS.brownDark, height: "sm", action }
}

/**
 * 副ボタン。button の secondary は色を指定できないため、枠付きの box にアクションを持たせて
 * 指定色（枠 #CDB899 / 文字 #6B5A4A）で描く。
 */
export function secondaryButton(action: ActionDef): FlexComponent {
  return {
    type: "box",
    layout: "vertical",
    borderColor: FLEX_COLORS.secondaryBorder,
    borderWidth: "1px",
    cornerRadius: "8px",
    paddingAll: "9px",
    action,
    contents: [text(action.label, { color: FLEX_COLORS.secondaryText, weight: "bold", align: "center" })],
  }
}

/** ボタン群（縦並び, spacing sm） */
export function buttons(items: FlexComponent[]): FlexComponent {
  return { type: "box", layout: "vertical", spacing: "sm", margin: "lg", contents: items }
}

/** postback アクション（displayText は押した人の発言としてトークに残る） */
export function postback(label: string, data: string, displayText: string = label): PostbackActionDef {
  return { type: "postback", label: label.slice(0, 40), data, displayText }
}

/** message アクション（押すとそのテキストが送信される） */
export function messageAction(label: string, textValue: string = label): MessageActionDef {
  return { type: "message", label: label.slice(0, 40), text: textValue }
}

/** クイックリプライ（ラベルは20文字・最大13個） */
export function quickReply(actions: ActionDef[]): { items: QuickReplyItem[] } {
  return {
    items: actions.slice(0, 13).map((a) => ({ type: "action", action: { ...a, label: a.label.slice(0, 20) } })),
  }
}

/** 共通テンプレートの bubble（header＝ブラウン帯、body＝カード地＋枠） */
export function cardBubble(header: string, body: FlexComponent[]): FlexComponent {
  return {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: FLEX_COLORS.brownDark,
      paddingAll: "12px",
      contents: [text(header, { color: FLEX_COLORS.headerText, weight: "bold", size: "sm" })],
    },
    body: {
      type: "box",
      layout: "vertical",
      backgroundColor: FLEX_COLORS.cardBg,
      borderColor: FLEX_COLORS.cardBorder,
      borderWidth: "1px",
      paddingAll: "13px",
      contents: body,
    },
    styles: { body: { backgroundColor: FLEX_COLORS.cardBg } },
  }
}

/** altText を上限内に整える（改行は通知で崩れるため空白に） */
export function toAltText(value: string): string {
  const t = value.replace(/\s*\n\s*/g, " ").trim()
  return t.length > ALT_TEXT_MAX ? `${t.slice(0, ALT_TEXT_MAX - 1)}…` : t
}

/** Flex メッセージを作る */
export function flexMessage(altText: string, contents: FlexComponent, qr?: ActionDef[]): FlexMessage {
  const msg: FlexMessage = { type: "flex", altText: toAltText(altText), contents }
  if (qr && qr.length > 0) msg.quickReply = quickReply(qr)
  return msg
}

/** JSONサイズ（バイト）。上限チェック用 */
export function flexSizeBytes(msg: FlexMessage): number {
  return Buffer.byteLength(JSON.stringify(msg.contents), "utf8")
}

/* ---------- 表示用ヘルパー ---------- */

/** ¥1,234 */
export function yen(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "不明"
  return `¥${Math.round(amount).toLocaleString("ja-JP")}`
}

/* ================================================================
 * 画面別カード
 * ================================================================ */

/** ① 氏名の確認 */
export function nameConfirmCard(params: { name: string; okData: string; retryData: string }): FlexMessage {
  return flexMessage(
    `${params.name}さんとして登録してよいかの確認`,
    cardBubble("お名前の確認", [
      text(`${params.name}さんとして登録します。よろしいですか？`, { size: "md", weight: "bold" }),
      buttons([
        primaryButton(postback("はい、これで登録する", params.okData)),
        secondaryButton(postback("入力し直す", params.retryData)),
      ]),
    ])
  )
}

/** 初回設定：登録済みの氏名の確認（既存スタッフ向け） */
export function nameReviewCard(params: { name: string; okData: string; changeData: string }): FlexMessage {
  return flexMessage(
    `お名前の確認：${params.name}さん`,
    cardBubble("お名前の確認", [
      text("最初に1回だけ、登録内容の確認をお願いします。", { color: FLEX_COLORS.textSub, size: "xs" }),
      panel([infoRow("お名前", params.name)]),
      note("お名前が違う場合は「変更を申請する」を押してください。変更は担当が行います。"),
      buttons([
        primaryButton(postback("このお名前で合っている", params.okData)),
        secondaryButton(postback("変更を申請する", params.changeData)),
      ]),
    ])
  )
}

/** 初回設定：登録済みの最寄り駅の確認 */
export function stationReviewCard(params: { station: string; okData: string; changeData: string }): FlexMessage {
  return flexMessage(
    `自宅の最寄り駅の確認：${params.station}`,
    cardBubble("自宅の最寄り駅の確認", [
      panel([infoRow("最寄り駅", params.station)]),
      note("電車代の計算の出発駅に使います。"),
      buttons([
        primaryButton(postback("この駅で合っている", params.okData)),
        secondaryButton(postback("変更する", params.changeData)),
      ]),
    ])
  )
}

/** ② 設定 */
export function settingsCard(params: {
  name: string
  homeStation: string
  commuteMethod: string
  commuterPass: string
  stationData: string
  commuteData: string
  passData: string
  nameData: string
  /** アカデミー会員のサービス開始日の表示（未登録は「未登録」） */
  academy: string
  academyData: string
  pendingNameChange?: boolean
  /** 通勤手段が電車・その他のときだけ定期券の行とボタンを出す */
  showPass?: boolean
}): FlexMessage {
  const rows: FlexComponent[] = [
    infoRow("お名前", params.name),
    infoRow("最寄り駅", params.homeStation),
    infoRow("通勤手段", params.commuteMethod),
  ]
  if (params.showPass !== false) {
    rows.push(infoRow("定期券", params.commuterPass))
  }
  rows.push(infoRow("アカデミー会員", params.academy))

  const body: FlexComponent[] = [
    text("現在の登録", { size: "xs", weight: "bold", color: FLEX_COLORS.textSub }),
    panel(rows, "sm"),
    note(
      "最寄り駅・通勤手段・定期券はご自身で変更できます。お名前の変更は担当が行います。\n" +
        "通勤手段や最寄り駅が変わったときは、すぐにここから変更してください。"
    ),
  ]
  if (params.pendingNameChange) {
    body.push(cautionBlock(["お名前の変更を担当に依頼済みです。"]))
  }

  const actions = [
    primaryButton(postback("最寄り駅を変更する", params.stationData)),
    primaryButton(postback("通勤手段を変更する", params.commuteData)),
  ]
  if (params.showPass !== false) {
    actions.push(primaryButton(postback("定期券を変更する", params.passData)))
  }
  actions.push(primaryButton(postback("アカデミー会員の登録", params.academyData)))
  actions.push(secondaryButton(postback("お名前の変更を申請する", params.nameData)))
  body.push(buttons(actions))

  return flexMessage(
    `設定：${params.name}さん／最寄り駅 ${params.homeStation}／通勤手段 ${params.commuteMethod}`,
    cardBubble("設定", body)
  )
}

/** ③ 領収書の読み取り結果と区分選択（区分の選択肢はクイックリプライ） */
export function receiptReceivedCard(params: {
  items: { store: string; amount: number | null; date: string | null }[]
  staffFamilyName: string
  categoryActions: ActionDef[]
  extraNote?: string
}): FlexMessage {
  const { items } = params
  const count = items.length
  const body: FlexComponent[] = []
  if (count === 1) {
    const r = items[0]
    body.push(
      panel(
        [infoRow("支払先", r.store || "不明"), infoRow("金額", yen(r.amount)), infoRow("日付", r.date || "不明")],
        "none"
      )
    )
  } else {
    const rows: FlexComponent[] = []
    items.forEach((r, i) => {
      if (i > 0) rows.push(separator("sm"))
      rows.push(infoRow(`${i + 1}件目`, `${r.store || "不明"}  ${yen(r.amount)}`, { sub: r.date || "日付不明" }))
    })
    const total = items.reduce((s, r) => s + (r.amount ?? 0), 0)
    rows.push(separator("sm"))
    rows.push(infoRow("合計", yen(total)))
    body.push(panel(rows, "none"))
    body.push(note(`選んだ区分は${count}件すべてに適用されます。区分が違う領収書は別々に送ってください。`))
  }
  body.push(note(`${params.staffFamilyName}さんとして申請します。`))
  if (params.extraNote) body.push(note(params.extraNote, "sm"))
  body.push(separator("lg"))
  body.push(text("何の費用ですか？", { size: "md", weight: "bold", margin: "lg" }))
  body.push(note("下のボタンから選んでください。", "xs"))

  const first = items[0]
  const alt =
    count === 1
      ? `${first.store || "領収書"} ${yen(first.amount)} を受け取りました。区分を選んでください`
      : `領収書を${count}件（合計 ${yen(items.reduce((s, r) => s + (r.amount ?? 0), 0))}）受け取りました。区分を選んでください`
  return flexMessage(alt, cardBubble(`領収書を${count}件 受け取りました`, body), params.categoryActions)
}

/** ④ 初回／2回目以降の自動判定（フェーズ2の講座区分で使う。ボタンの出し分けは showFirstButton） */
export function attendanceJudgeCard(params: {
  courseName: string
  isRepeat: boolean
  showFirstButton: boolean
  proceedData: string
  firstData: string
}): FlexMessage {
  const lines: (string | CautionSpan[])[] = params.isRepeat
    ? [
        ["過去の申請記録から", { strong: "2回目以降" }, "として計算します。"],
        ["受講料・交通費・宿泊費はいずれも", { strong: "半額支給" }, "です。"],
      ]
    : [["過去の申請記録から", { strong: "初回" }, "として計算します。"]]
  const body: FlexComponent[] = [cautionBlock(lines)]
  if (params.isRepeat && params.showFirstButton) {
    body.push(note("違っていれば「初回です」を押してください。担当が確認します。"))
  }
  const btns: FlexComponent[] = [primaryButton(postback("このまま進む", params.proceedData))]
  if (params.isRepeat && params.showFirstButton) btns.push(secondaryButton(postback("初回です", params.firstData)))
  body.push(buttons(btns))
  return flexMessage(
    `${params.courseName}：${params.isRepeat ? "2回目以降（半額支給）" : "初回"}として計算します`,
    cardBubble(params.courseName, body)
  )
}

/** ⑤⑥ 申請内容の確認（超過時は overLimit を渡すと注意ブロックを足す） */
export function applicationConfirmCard(params: {
  applicant: string
  course?: string
  category: string
  /** 何に使ったか（「その他」の立替で本人が入力した内容）。空なら行を出さない */
  purpose?: string
  breakdown?: { label: string; amount: number | null; sub?: string }[]
  receiptTotal: number
  /** 合計の見出し（既定は「領収書の金額」。IC履歴の一括申請では「交通費の合計」） */
  totalLabel?: string
  subsidy: number
  subsidyRateLabel: string
  targetMonth: string
  overLimit?: { category: string; exceeded: number }
  okData: string
  fixData: string
}): FlexMessage {
  const rows: FlexComponent[] = [infoRow("申請者", params.applicant)]
  if (params.course) rows.push(infoRow("講座", params.course))
  rows.push(infoRow("区分", params.category))
  if (params.purpose) rows.push(infoRow("内容", params.purpose))
  const body: FlexComponent[] = [panel(rows, "none")]
  if (params.breakdown && params.breakdown.length > 0) {
    const bd: FlexComponent[] = [text("内訳", { size: "xs", weight: "bold", color: FLEX_COLORS.textSub })]
    for (const b of params.breakdown) bd.push(infoRow(b.label, yen(b.amount), { sub: b.sub }))
    body.push(panel(bd))
  }
  body.push(separator())
  body.push(infoRow(params.totalLabel ?? "領収書の金額", yen(params.receiptTotal)))
  body.push(
    payBlock(params.overLimit ? "支給額（上限分）" : "支給額", yen(params.subsidy), params.subsidyRateLabel)
  )
  if (params.overLimit) {
    body.push(cautionBlock([`上限を超えた ${yen(params.overLimit.exceeded)} については、担当が確認のうえご連絡します。`]))
  }
  body.push(infoRow("対象月", params.targetMonth))
  body.push(
    buttons([
      primaryButton(postback("この内容で申請する", params.okData)),
      secondaryButton(postback("修正する", params.fixData)),
    ])
  )
  return flexMessage(
    `${params.category} ${yen(params.receiptTotal)} の申請内容の確認（支給額 ${yen(params.subsidy)}）`,
    cardBubble("この内容で申請します", body)
  )
}

/** ⑦ 申請履歴の1行 */
export interface HistoryItem {
  date: string
  status: ApplicationStatus
  store: string
  category: string
  amount: number | null
  subsidy: number | null
  /** いつのお給与に入るか（例「2026年11月分」）。確認中は理由を入れる */
  payoutNote?: string
}

/** ⑦ 申請履歴（直近4〜5件・1バブル） */
export function historyCard(params: { staffFamilyName: string; items: HistoryItem[]; footer: string | null }): FlexMessage {
  const items = params.items.slice(0, 5)
  const body: FlexComponent[] = []
  if (items.length === 0) {
    body.push(text("まだ申請はありません。", { color: FLEX_COLORS.textSub }))
  }
  items.forEach((it, i) => {
    if (i > 0) body.push(separator())
    const cancelled = it.status === "cancelled"
    body.push({
      type: "box",
      layout: "horizontal",
      margin: i > 0 ? "md" : "none",
      alignItems: "center",
      contents: [text(it.date, { size: "xs", color: FLEX_COLORS.textSub, flex: 1 }), statusBadge(it.status)],
    })
    body.push(
      text(it.store || "不明", {
        weight: "bold",
        color: cancelled ? FLEX_COLORS.textCancelled : FLEX_COLORS.textMain,
        margin: "xs",
      })
    )
    body.push(text(it.category, { size: "xs", color: FLEX_COLORS.textSub }))
    // 本人が「いつ入るか」を自分で確かめられるようにする
    if (it.payoutNote) {
      body.push(text(it.payoutNote, { size: "xs", color: FLEX_COLORS.textSub }))
    }
    body.push({
      type: "text",
      wrap: true,
      size: "sm",
      color: FLEX_COLORS.textMain,
      contents: [
        { type: "span", text: yen(it.amount) },
        ...(it.subsidy != null
          ? [
              { type: "span", text: " → 支給 " },
              { type: "span", text: yen(it.subsidy), weight: "bold", color: FLEX_COLORS.payText },
            ]
          : []),
      ],
    })
    if (it.status === "awaiting_attachment") {
      body.push(cautionBlock(["合格通知または修了通知の写真を送っていただくと確定します。"]))
    }
  })
  if (params.footer) {
    body.push(separator())
    body.push(note(params.footer))
  }
  const header = `${params.staffFamilyName}さんの申請（直近${items.length}件）`
  const registered = items.filter((i) => i.status === "registered").length
  return flexMessage(`${header}：登録済み ${registered}件`, cardBubble(header, body))
}

/** ⑧ 電車代の確認 */
export function trainConfirmCard(params: {
  fromStation: string
  fromIsPassEnd: boolean
  toStation: string
  shinkansenLegs?: { label: string; amount: number }[]
  oneWay: number
  trip: "one" | "round"
  total: number
  passNote?: string
  estimateNote?: string
  okData: string
  fixData: string
}): FlexMessage {
  const rows: FlexComponent[] = [
    infoRow("出発駅", params.fromStation, params.fromIsPassEnd ? { sub: "定期券区間の端" } : {}),
    infoRow("目的地", params.toStation),
  ]
  const body: FlexComponent[] = [panel(rows, "none")]
  if (params.shinkansenLegs && params.shinkansenLegs.length > 0) {
    const legs: FlexComponent[] = [text("片道の内訳", { size: "xs", weight: "bold", color: FLEX_COLORS.textSub })]
    for (const l of params.shinkansenLegs) legs.push(infoRow(l.label, yen(l.amount)))
    body.push(panel(legs))
  }
  body.push(infoRow("片道", yen(params.oneWay)))
  if (params.trip === "round") body.push(infoRow("往復", yen(params.total)))
  body.push(payBlock("支給額", yen(params.total), "交通費（全額支給）"))
  if (params.passNote) body.push(panel([text(params.passNote, { size: "xs" })]))
  if (params.estimateNote) body.push(note(params.estimateNote))
  body.push(
    buttons([
      primaryButton(postback("この内容で申請する", params.okData)),
      secondaryButton(postback("修正する", params.fixData)),
    ])
  )
  return flexMessage(
    `電車代 ${yen(params.total)}（${params.fromStation.replace(/駅$/, "")}→${params.toStation.replace(/駅$/, "")}）の申請内容の確認`,
    cardBubble("この内容で申請します", body)
  )
}
