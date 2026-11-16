/**
 * Flexカードの見本JSONを書き出し、LINEの上限に収まっているかを確認する。
 *   npm run flex:preview
 *
 * 出力: scripts/flex-preview/*.json（contents 部分）
 *  → LINE Flex Message Simulator（https://developers.line.biz/flex-simulator/）の「View as JSON」に貼ると表示を確認できる。
 * 例示の氏名は「南 ひふ子」（実在スタッフ名は使わない）。
 */
import fs from "node:fs"
import path from "node:path"
import {
  ALT_TEXT_MAX,
  applicationConfirmCard,
  attendanceJudgeCard,
  flexSizeBytes,
  FLEX_SIZE_LIMIT_BYTES,
  historyCard,
  nameConfirmCard,
  nameReviewCard,
  postback,
  receiptReceivedCard,
  settingsCard,
  stationReviewCard,
  trainConfirmCard,
  type FlexMessage,
} from "../src/lib/line-flex"

const OUT = path.resolve(process.cwd(), "scripts/flex-preview")
fs.mkdirSync(OUT, { recursive: true })

const cat = [postback("アチーブメント関連", "action=t1&rid=x&g=ach"), postback("それ以外", "action=t1&rid=x&g=other")]

const samples: Record<string, FlexMessage> = {
  "01_name_confirm": nameConfirmCard({ name: "南 ひふ子", okData: "action=nmok&sid=x", retryData: "action=nmre" }),
  "01b_name_review": nameReviewCard({ name: "南 ひふ子", okData: "a", changeData: "b" }),
  "01c_station_review": stationReviewCard({ station: "南草津駅（滋賀県）", okData: "a", changeData: "b" }),
  "02_settings": settingsCard({
    name: "南 ひふ子",
    homeStation: "南草津駅（滋賀県）",
    commuterPass: "あり（南草津 ⇄ 京都）",
    stationData: "a",
    passData: "b",
    nameData: "c",
  }),
  "03_receipt_single": receiptReceivedCard({
    items: [{ store: "ホテル京都駅前", amount: 18000, date: "2026-11-14" }],
    staffFamilyName: "南",
    categoryActions: cat,
  }),
  "03b_receipt_multi": receiptReceivedCard({
    items: [
      { store: "ホテル京都駅前", amount: 18000, date: "2026-11-14" },
      { store: "○○書店", amount: 1500, date: "2026-11-10" },
      { store: "JR西日本", amount: 1520, date: "2026-11-10" },
    ],
    staffFamilyName: "南",
    categoryActions: cat,
  }),
  "04_attendance_judge": attendanceJudgeCard({
    courseName: "頂点への道 2026年11月期",
    isRepeat: true,
    showFirstButton: true,
    proceedData: "a",
    firstData: "b",
  }),
  "05_confirm": applicationConfirmCard({
    applicant: "南 ひふ子",
    course: "頂点への道 2026年11月期",
    category: "宿泊費",
    breakdown: [{ label: "支払先", amount: 18000, sub: "ホテル京都駅前" }],
    receiptTotal: 18000,
    subsidy: 9000,
    subsidyRateLabel: "半額支給",
    targetMonth: "2026年11月分",
    okData: "a",
    fixData: "b",
  }),
  "06_confirm_over_limit": applicationConfirmCard({
    applicant: "南 ひふ子",
    category: "宿泊費",
    receiptTotal: 42000,
    subsidy: 30000,
    subsidyRateLabel: "全額支給（上限 ¥30,000）",
    targetMonth: "2026年11月分",
    overLimit: { category: "宿泊費", exceeded: 12000 },
    okData: "a",
    fixData: "b",
  }),
  "07_history": historyCard({
    staffFamilyName: "南",
    items: [
      { date: "11/14", status: "registered", store: "ホテル京都駅前", category: "宿泊費", amount: 18000, subsidy: 9000 },
      { date: "11/12", status: "category_pending", store: "JR西日本", category: "区分を選ぶ前の領収書", amount: 1520, subsidy: null },
      { date: "11/10", status: "awaiting_attachment", store: "○○検定協会", category: "受験料", amount: 6600, subsidy: 6600 },
      { date: "11/08", status: "cancelled", store: "○○書店", category: "書籍代", amount: 1500, subsidy: 1500 },
      { date: "11/02", status: "registered", store: "電車：京都駅→梅田（往復）", category: "交通費", amount: 1160, subsidy: 1160 },
    ],
    footer: "登録済みの分は 2026年11月分 として提出されます。",
  }),
  "08_train_confirm": trainConfirmCard({
    fromStation: "京都駅",
    fromIsPassEnd: true,
    toStation: "大阪駅",
    oneWay: 580,
    trip: "round",
    total: 1160,
    passNote: "南草津 〜 京都 は定期券の区間のため、支給の対象外として計算しました。",
    estimateNote: "運賃は自動計算です。実際と違う場合は「修正する」を押してください。",
    okData: "a",
    fixData: "b",
  }),
}

let failed = false
for (const [name, msg] of Object.entries(samples)) {
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(msg.contents, null, 2))
  const size = flexSizeBytes(msg)
  const ok = size <= FLEX_SIZE_LIMIT_BYTES && msg.altText.length <= ALT_TEXT_MAX
  if (!ok) failed = true
  console.log(
    `${ok ? "OK " : "NG "} ${name.padEnd(24)} ${String(size).padStart(6)} bytes  altText(${msg.altText.length}字): ${msg.altText}`
  )
}
console.log(`\n書き出し先: ${OUT}`)
if (failed) process.exit(1)
