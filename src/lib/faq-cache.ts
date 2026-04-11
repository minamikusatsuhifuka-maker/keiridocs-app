interface FAQEntry {
  keywords: string[]
  answer: string
}

/** よくある質問のキャッシュデータ */
export const FAQ_CACHE: FAQEntry[] = [
  {
    keywords: ["診療時間", "営業時間", "何時", "開院", "閉院"],
    answer: `【診療時間】
月・火・水・金: 9:00〜12:30 / 14:30〜18:00
木・土: 9:00〜12:30
日・祝: 休診

※受付は終了30分前まで`,
  },
  {
    keywords: ["場所", "住所", "アクセス", "駐車場", "電車", "どこ"],
    answer: `【アクセス】
〒520-2134 滋賀県大津市南草津1丁目
JR南草津駅から徒歩3分

駐車場: あり（○台）`,
  },
  {
    keywords: ["電話", "電話番号", "tel", "連絡"],
    answer: `【お電話】
077-XXX-XXXX
受付時間内にお気軽にお電話ください。`,
  },
  {
    keywords: ["予約", "受診方法", "初診", "初めて"],
    answer: `【ご予約方法】
WEB予約（24時間受付）またはお電話にて承ります。
初診の方はWEB予約からご予約いただくとスムーズです。`,
  },
]

/**
 * キーワードマッチングでキャッシュ済み回答を検索
 * マッチした場合は回答文字列、なければnullを返す
 */
export function findCachedAnswer(input: string): string | null {
  const normalized = input.replace(/\s/g, "").toLowerCase()
  for (const entry of FAQ_CACHE) {
    if (entry.keywords.some((kw) => normalized.includes(kw))) {
      return entry.answer
    }
  }
  return null
}
