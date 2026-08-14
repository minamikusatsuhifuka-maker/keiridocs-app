import { GoogleGenerativeAI } from "@google/generative-ai"
import { DEFAULT_GEMINI_MODEL, LOW_THINKING_CONFIG } from "@/lib/gemini"

/**
 * 駅名テキストから「駅名＋都道府県（＋代表路線）」をGeminiで判定する（自宅最寄り駅の自己登録用）。
 *
 * - 当院は滋賀県（草津）所在のため、県名指定が無い場合は近畿圏を優先しつつ、
 *   最終判断は呼び出し側の確認ステップでスタッフに委ねる。
 * - confidence=low または candidates 複数のときは、呼び出し側で候補提示／県名付き再入力に誘導する。
 * - 駅名は「○○駅」表記に正規化して返す（transit-fare.ts の出発駅と整合）。
 */

export interface StationCandidate {
  station: string
  pref: string
  line: string | null
}

export interface StationJudge {
  station: string | null
  pref: string | null
  line: string | null
  confidence: "high" | "low"
  candidates: StationCandidate[]
}

/** 駅名を「○○駅」表記に正規化（末尾に「駅」が無ければ付与） */
export function toStationName(raw: string): string {
  const t = raw.trim()
  if (!t) return t
  return t.endsWith("駅") ? t : `${t}駅`
}

const FALLBACK: StationJudge = {
  station: null,
  pref: null,
  line: null,
  confidence: "low",
  candidates: [],
}

export async function judgeStation(input: string): Promise<StationJudge> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey || !input.trim()) return FALLBACK

  try {
    const genAI = new GoogleGenerativeAI(apiKey)
    // Gemini 3.x は思考が既定ONで小さな固定JSONが切れることがあるため思考レベルを下げる
    // （3.7 は MINIMAL 不可・temperature 等は非対応のため指定しない）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generationConfig: any = {
      responseMimeType: "application/json",
      maxOutputTokens: 4096,
      thinkingConfig: LOW_THINKING_CONFIG,
    }
    const model = genAI.getGenerativeModel({ model: DEFAULT_GEMINI_MODEL, generationConfig })

    const prompt = `日本の鉄道駅を特定してください。
入力（スタッフが送信した最寄り駅。県名を含む場合あり）: ${input}

次のJSONのみで答えてください。余計な文字は一切含めないこと。
{"station":"駅名","pref":"都道府県","line":"代表路線 or null","confidence":"high"|"low","candidates":[{"station":"駅名","pref":"都道府県","line":"代表路線 or null"}]}

ルール:
- station は「○○駅」表記（末尾に「駅」を付ける）。pref は「滋賀県」「大阪府」等のフル表記。
- 一意に特定できる場合は confidence を "high"、candidates は空配列([])にする。
- 同名の駅が複数県にある等で特定できない場合は confidence を "low" にし、候補を candidates に最大5件入れる（station は実在駅のみ）。
- 県名の指定が無い場合は滋賀県（草津）に近い近畿圏を優先候補にしてよいが、確証が無ければ confidence は "low"。
- まったく判断できない場合は station を null、confidence を "low"、candidates を [] にする。`

    const result = await model.generateContent(prompt)
    const text = result.response.text()
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim()
    const parsed = JSON.parse(cleaned) as Record<string, unknown>

    const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")
    const strOrNull = (v: unknown): string | null => {
      const s = str(v)
      return s ? s : null
    }

    const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : []
    const candidates: StationCandidate[] = []
    for (const c of rawCandidates.slice(0, 5)) {
      if (c && typeof c === "object") {
        const o = c as Record<string, unknown>
        const station = str(o.station)
        const pref = str(o.pref)
        if (station && pref) {
          candidates.push({ station: toStationName(station), pref, line: strOrNull(o.line) })
        }
      }
    }

    const station = strOrNull(parsed.station)
    const pref = strOrNull(parsed.pref)
    const confidence = parsed.confidence === "high" ? "high" : "low"

    return {
      station: station ? toStationName(station) : null,
      pref,
      line: strOrNull(parsed.line),
      confidence,
      candidates,
    }
  } catch (e) {
    console.warn("[station-judge] 駅判定に失敗:", e)
    return FALLBACK
  }
}
