import { GoogleGenerativeAI } from "@google/generative-ai"
import { DEFAULT_GEMINI_MODEL, LOW_THINKING_CONFIG } from "@/lib/gemini"

/**
 * 電車の片道普通運賃のAI推定（領収書なし交通費用）。
 *
 * ■ 重要：推定は常に「提案値」。最終的な確定額はスタッフがLINEで確認・修正した後の値になる。
 *   本関数の正確性に最終結果は依存しない（外れても確認で修正される）。
 * ■ 将来拡張：正確化が必要になったら、運賃・経路API（駅すぱあと／NAVITIME等・有料）に
 *   差し替えられるよう、入出力（FareEstimate）はこのまま維持する。Geminiは駅名・県の
 *   正規化に用い、運賃はAPIから取得する構成へ置き換え可能。
 */

export interface FareEstimate {
  /** 片道普通運賃（円・10円単位に丸め）。推定不能なら null */
  fare: number | null
  /** 推定の確信度。low の場合は呼び出し側で手動入力にフォールバックする */
  confidence: "high" | "low"
}

/**
 * 出発（自宅最寄り駅＋県）→ 到着（駅名＋県）の最短距離での片道普通運賃を概算する。
 * confidence が low、または fare が null の場合は推定を出さず手動入力にフォールバックすること。
 */
export async function estimateTrainFare(params: {
  fromStation: string
  fromPref: string
  toStation: string
  toPref: string
}): Promise<FareEstimate> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return { fare: null, confidence: "low" }

  const { fromStation, fromPref, toStation, toPref } = params
  if (!fromStation.trim() || !toStation.trim()) return { fare: null, confidence: "low" }

  try {
    const genAI = new GoogleGenerativeAI(apiKey)
    // Gemini 3.x は思考が既定ONで、小さな固定JSONが途中で切れることがあるため思考レベルを下げる。
    // （3.7 は MINIMAL 不可・temperature 等は非対応。型に thinkingConfig が無いため any で渡す）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generationConfig: any = {
      responseMimeType: "application/json",
      maxOutputTokens: 4096,
      thinkingConfig: LOW_THINKING_CONFIG,
    }
    const model = genAI.getGenerativeModel({ model: DEFAULT_GEMINI_MODEL, generationConfig })

    const prompt = `日本の鉄道運賃を概算してください。
出発駅: ${fromStation}（${fromPref}）
到着駅: ${toStation}（${toPref}）

最短距離での「片道」「普通運賃（おとな）」を概算し、次のJSONのみで答えてください。余計な文字は一切含めないこと。
{"fare": 数値, "confidence": "high" | "low"}

ルール:
- fare は円単位の整数（片道）。
- 駅が特定できない・経路が不明・運賃に自信がない場合は fare を null、confidence を "low" にする。
- 自信がある場合のみ confidence を "high" にする。`

    const result = await model.generateContent(prompt)
    const text = result.response.text()
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim()
    const parsed = JSON.parse(cleaned) as { fare?: unknown; confidence?: unknown }

    const rawFare = typeof parsed.fare === "number" ? parsed.fare : null
    const confidence = parsed.confidence === "high" ? "high" : "low"
    if (rawFare === null || !isFinite(rawFare) || rawFare <= 0) {
      return { fare: null, confidence: "low" }
    }
    // 普通運賃想定で10円単位に丸める（四捨五入）
    const fare = Math.round(rawFare / 10) * 10
    return { fare, confidence }
  } catch (e) {
    // 失敗時は手動入力にフォールバックさせる（推定は提案値に過ぎないため精算は止めない）
    console.warn("[transit-fare] 運賃推定に失敗（手動入力にフォールバック）:", e)
    return { fare: null, confidence: "low" }
  }
}
