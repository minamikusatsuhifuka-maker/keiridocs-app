import { GoogleGenerativeAI } from "@google/generative-ai"
import { DEFAULT_GEMINI_MODEL, LOW_THINKING_CONFIG } from "@/lib/gemini"
import { estimateTrainFare } from "@/lib/transit-fare"
import { toStationName } from "@/lib/station-judge"

/**
 * 定期券区間の控除（二重払いの防止）— 判定ロジックはこのファイル1箇所に集約する。
 *
 * 院は通勤手当（定期代）を支給しているため、定期券の区間を交通費として重ねて支給しない。
 * 区間の重なりを完全自動で判定すると誤りが出るため、「定期券区間を通るか」はスタッフにボタン1タップで聞き、
 * 「通る」と答えた場合だけ本関数で次を決める。
 *
 *  1. 目的地が定期券区間内か（区間内なら支給0円で終了）
 *  2. 区間外なら、定期券区間のどちらの端（目的地に近い側）を出発駅として運賃を計算するか
 *
 * 判定は「AIの経路判定」→（自信がなければ）「両端からの運賃比較（安い方＝近い側）」の順で行う。
 * 区間内と判定した場合もスタッフが「区間の外です」で覆せるようにしてある（webhook 側）。
 * 新幹線を使う場合も、ここで決めた出発駅を在来線区間①の起点に使う。
 */

export interface PassSegment {
  from: string
  fromPref?: string
  to: string
  toPref?: string
}

export type PassDeductionResult =
  /** 目的地が定期券区間内 → 支給なし */
  | { kind: "inside" }
  /** 定期券区間の端を出発駅にする */
  | { kind: "from_end"; station: string; pref: string; method: "ai" | "fare" }
  /** 判定できなかった（呼び出し側は自宅最寄り駅のまま計算せず、手入力に回す） */
  | { kind: "unknown" }

/** 駅名の比較用（「○○駅」表記で比較） */
function sameStation(a: string, b: string): boolean {
  return toStationName(a.trim()) === toStationName(b.trim())
}

/** AIによる経路判定の結果 */
interface RouteJudge {
  inside: boolean | null
  exit: "from" | "to" | null
  confident: boolean
}

/** 定期券区間と目的地の位置関係をAIで判定する（失敗時は confident=false） */
async function judgeRouteByAi(pass: PassSegment, dest: { station: string; pref: string }): Promise<RouteJudge> {
  const failed: RouteJudge = { inside: null, exit: null, confident: false }
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return failed
  try {
    const genAI = new GoogleGenerativeAI(apiKey)
    // 既存の運賃推定と同じく思考レベルを下げて小さなJSONを返させる（モデルは既定のまま変更しない）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generationConfig: any = {
      responseMimeType: "application/json",
      maxOutputTokens: 4096,
      thinkingConfig: LOW_THINKING_CONFIG,
    }
    const model = genAI.getGenerativeModel({ model: DEFAULT_GEMINI_MODEL, generationConfig })
    const prompt = `日本の鉄道の経路について答えてください。
通勤定期券の区間: 「${pass.from}（${pass.fromPref || "県不明"}）」⇄「${pass.to}（${pass.toPref || "県不明"}）」
目的地の駅: 「${dest.station}（${dest.pref || "県不明"}）」

次のJSONのみで答えてください。余計な文字は一切含めないこと。
{"inside": true | false, "exit": "from" | "to", "confidence": "high" | "low"}

ルール:
- inside: 目的地の駅が定期券区間の経路上（両端の駅を含む、区間の途中駅）にあれば true。
- exit: 目的地へ向かうとき、定期券区間のどちらの端で定期券区間を出るか。区間の「${pass.from}」側なら "from"、「${pass.to}」側なら "to"。
- 経路が分からない・自信がない場合は confidence を "low" にする。`
    const result = await model.generateContent(prompt)
    const cleaned = result.response.text().replace(/```json\s*/g, "").replace(/```\s*/g, "").trim()
    const parsed = JSON.parse(cleaned) as Record<string, unknown>
    const inside = typeof parsed.inside === "boolean" ? parsed.inside : null
    const exit = parsed.exit === "from" || parsed.exit === "to" ? parsed.exit : null
    return { inside, exit, confident: parsed.confidence === "high" && inside !== null && exit !== null }
  } catch (e) {
    console.warn("[commuter-pass] 経路判定に失敗（運賃比較にフォールバック）:", e)
    return failed
  }
}

/**
 * 「定期券区間を通る」と答えたスタッフの出発駅を決める。
 * @param pass 登録済みの定期券区間
 * @param dest 目的地（会場の最寄り駅＋県）
 */
export async function decidePassDeparture(
  pass: PassSegment,
  dest: { station: string; pref: string }
): Promise<PassDeductionResult> {
  const fromEnd = { station: toStationName(pass.from), pref: pass.fromPref || "" }
  const toEnd = { station: toStationName(pass.to), pref: pass.toPref || "" }

  // 目的地が定期券区間の端そのもの → 区間内（支給なし）
  if (sameStation(dest.station, pass.from) || sameStation(dest.station, pass.to)) {
    return { kind: "inside" }
  }

  // 1. AIの経路判定（自信がある場合のみ採用）
  const ai = await judgeRouteByAi(pass, dest)
  if (ai.confident) {
    if (ai.inside) return { kind: "inside" }
    const end = ai.exit === "from" ? fromEnd : toEnd
    return { kind: "from_end", station: end.station, pref: end.pref, method: "ai" }
  }

  // 2. 両端からの運賃を比較し、安い方（＝目的地に近い側）を出発駅にする
  const [fareFrom, fareTo] = await Promise.all([
    estimateTrainFare({ fromStation: fromEnd.station, fromPref: fromEnd.pref, toStation: dest.station, toPref: dest.pref }),
    estimateTrainFare({ fromStation: toEnd.station, fromPref: toEnd.pref, toStation: dest.station, toPref: dest.pref }),
  ])
  const a = fareFrom.confidence === "high" ? fareFrom.fare : null
  const b = fareTo.confidence === "high" ? fareTo.fare : null
  if (a == null && b == null) return { kind: "unknown" }
  if (b == null || (a != null && a <= b)) {
    return { kind: "from_end", station: fromEnd.station, pref: fromEnd.pref, method: "fare" }
  }
  return { kind: "from_end", station: toEnd.station, pref: toEnd.pref, method: "fare" }
}

/** 確認画面に出す控除の説明（例「南草津 〜 京都 は定期券の区間のため、支給の対象外として計算しました。」） */
export function passDeductionNote(pass: PassSegment): string {
  const a = pass.from.replace(/駅$/, "")
  const b = pass.to.replace(/駅$/, "")
  return `${a} 〜 ${b} は定期券の区間のため、支給の対象外として計算しました。`
}
