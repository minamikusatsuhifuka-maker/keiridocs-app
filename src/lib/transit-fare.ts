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

/**
 * 新幹線区間（片道）の「運賃（乗車券）＋普通車指定席の特急料金」をAI推定する。
 *
 * ■ 前提：普通車指定席（通常期）。グリーン車・自由席ではない。
 * ■ 重要：指定席特急料金は繁忙期／閑散期・列車種別（のぞみ／ひかり等）で変動するため、
 *   本関数の値はあくまで「提案値」。最終的な確定額はスタッフがLINEで内訳を確認・修正した後の値になる。
 * ■ 将来拡張：正確化が必要になったら、運賃・経路API（駅すぱあと／NAVITIME等・有料）へ
 *   差し替えられるよう、入出力（ShinkansenFareEstimate）はこのまま維持する。
 */
export interface ShinkansenFareEstimate {
  /** 片道の合計（運賃＋普通車指定席特急料金・円）。推定不能なら null */
  fare: number | null
  /** 内訳：乗車券の運賃（分かる場合のみ） */
  basicFare: number | null
  /** 内訳：普通車指定席の特急料金（分かる場合のみ） */
  limitedExpressFee: number | null
  confidence: "high" | "low"
}

/**
 * 新幹線の乗車駅→降車駅の片道料金（運賃＋普通車指定席特急料金）を概算する。
 * confidence が low、または fare が null の場合は、その区間を空欄にして手動入力にフォールバックすること
 * （1区間の失敗で申請全体を止めない）。
 */
export async function estimateShinkansenFare(params: {
  fromStation: string
  fromPref: string
  toStation: string
  toPref: string
}): Promise<ShinkansenFareEstimate> {
  const failed: ShinkansenFareEstimate = {
    fare: null,
    basicFare: null,
    limitedExpressFee: null,
    confidence: "low",
  }

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return failed

  const { fromStation, fromPref, toStation, toPref } = params
  if (!fromStation.trim() || !toStation.trim()) return failed

  try {
    const genAI = new GoogleGenerativeAI(apiKey)
    // Gemini 3.x は思考が既定ONで、小さな固定JSONが途中で切れることがあるため思考レベルを下げる。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generationConfig: any = {
      responseMimeType: "application/json",
      maxOutputTokens: 4096,
      thinkingConfig: LOW_THINKING_CONFIG,
    }
    const model = genAI.getGenerativeModel({ model: DEFAULT_GEMINI_MODEL, generationConfig })

    const prompt = `日本の新幹線の料金を概算してください。
乗車駅: ${fromStation}（${fromPref}）
降車駅: ${toStation}（${toPref}）

「片道」「おとな」「普通車指定席」「通常期」を前提に、乗車券の運賃と指定席特急料金を概算し、次のJSONのみで答えてください。余計な文字は一切含めないこと。
{"basic_fare": 数値, "limited_express_fee": 数値, "total": 数値, "confidence": "high" | "low"}

ルール:
- basic_fare は乗車券の運賃（円・片道）、limited_express_fee は普通車指定席の特急料金（円・片道）、total はその合計。
- グリーン車・自由席・立席ではなく、必ず「普通車指定席」で算定する。
- 新幹線が通っていない区間・駅が特定できない・料金に自信がない場合は total を null、confidence を "low" にする。
- 自信がある場合のみ confidence を "high" にする。`

    const result = await model.generateContent(prompt)
    const text = result.response.text()
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim()
    const parsed = JSON.parse(cleaned) as Record<string, unknown>

    const num = (v: unknown): number | null => {
      if (typeof v !== "number" || !isFinite(v) || v <= 0) return null
      // JRの料金は10円単位
      return Math.round(v / 10) * 10
    }
    const basicFare = num(parsed.basic_fare)
    const limitedExpressFee = num(parsed.limited_express_fee)
    // total が無ければ内訳から復元する（AIが total を落とすことがあるため）
    const total =
      num(parsed.total) ?? (basicFare != null && limitedExpressFee != null ? basicFare + limitedExpressFee : null)
    const confidence = parsed.confidence === "high" ? "high" : "low"

    if (total == null) return failed
    return { fare: total, basicFare, limitedExpressFee, confidence }
  } catch (e) {
    // 失敗時はその区間だけ手動入力にフォールバックさせる（推定は提案値に過ぎないため精算は止めない）
    console.warn("[transit-fare] 新幹線料金の推定に失敗（手動入力にフォールバック）:", e)
    return failed
  }
}
