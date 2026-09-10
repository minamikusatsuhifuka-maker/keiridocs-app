// PDFのテキストレイヤー抽出
//
// 【なぜ必要か】
// Gemini に PDF をそのまま渡すと、日本語フォントが「非埋め込みのCIDフォント」
// （例: HeiseiKakuGo-W5 + 90ms-RKSJ-H。PDFlib製の請求書に多い）で作られている場合、
// 日本語が一切読み取れない状態になる。ToUnicode CMap も持たないため文字情報が復元できず、
// モデルは「日本語が何も書かれていない書類」を見た状態になり、
// 取引先名や品目を"それらしい文字列"で埋めてしまう（実在しない会社名が登録される）。
//
// pdfjs は標準CMap（90ms-RKSJ-H / Adobe-Japan1-UCS2 等）を同梱しており、
// フォントが埋め込まれていなくても文字コードを正しく復元できる。
// そこでサーバー側で先にテキストを抜き出し、AIに「正確な文字情報」として渡す。
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

/** テキストレイヤーが「日本語書類として意味のある量」とみなす最小CJK文字数 */
const MEANINGFUL_CJK_COUNT = 20

/** 1ファイルあたりに読むページ数の上限（極端に長いPDF対策） */
const MAX_PAGES = 20

/** プロンプトに載せるテキストの最大長 */
const MAX_TEXT_LENGTH = 20000

/** PDFテキスト抽出の結果 */
export interface PdfTextResult {
  /** 抽出したテキスト（抽出できなければ空文字） */
  text: string
  /** ページ数（取得できなければ0） */
  pageCount: number
  /** CJK（ひらがな・カタカナ・漢字）の文字数 */
  cjkCount: number
  /** 日本語書類の照合に使える量のテキストが取れたか */
  hasMeaningfulText: boolean
}

const EMPTY_RESULT: PdfTextResult = {
  text: "",
  pageCount: 0,
  cjkCount: 0,
  hasMeaningfulText: false,
}

/**
 * pdfjs が同梱する標準CMap／標準フォントのディレクトリを解決する。
 *
 * 日本語の非埋め込みCIDフォント（90ms-RKSJ-H 等）は標準CMapが無いと文字コードを復元できず、
 * 「日本語が1文字も取れないPDF」になってしまう。見つからない場合は必ずログに残す。
 */
function resolvePdfjsAssetDirs(): { cMapUrl?: string; standardFontDataUrl?: string } {
  const roots: string[] = []
  try {
    // Next のバンドルに巻き込まれないよう、実行時に node_modules から解決する
    // （next.config.ts の serverExternalPackages / outputFileTracingIncludes と対で機能する）
    const req = createRequire(path.join(process.cwd(), "index.js"))
    roots.push(path.dirname(req.resolve("pdfjs-dist/package.json")))
  } catch {
    // require解決に失敗しても下のフォールバックを試す
  }
  roots.push(path.join(process.cwd(), "node_modules", "pdfjs-dist"))

  for (const root of roots) {
    const cmapDir = path.join(root, "cmaps")
    if (fs.existsSync(cmapDir)) {
      const fontDir = path.join(root, "standard_fonts")
      return {
        cMapUrl: cmapDir + path.sep,
        standardFontDataUrl: fs.existsSync(fontDir) ? fontDir + path.sep : undefined,
      }
    }
  }

  console.error(
    "pdfjs の標準CMap（node_modules/pdfjs-dist/cmaps）が見つかりません。" +
      "日本語PDFの文字が復元できず、AIが取引先名を推測してしまう恐れがあります。" +
      "next.config.ts の outputFileTracingIncludes を確認してください。"
  )
  return {}
}

/** CJK（ひらがな・カタカナ・漢字）の文字数を数える */
function countCjk(text: string): number {
  return (text.match(/[぀-ヿ㐀-䶿一-鿿]/g) ?? []).length
}

/**
 * PDFのテキストレイヤーを抽出する。
 * スキャン画像だけのPDF（テキストレイヤー無し）や解析失敗時は空の結果を返す。
 * 失敗しても呼び出し側の処理は続行できるよう、例外は投げない。
 */
export async function extractPdfText(buffer: Buffer): Promise<PdfTextResult> {
  try {
    // pdfjs は ESM（legacy build がNode向け）。動的importでサーバー実行時のみ読み込む
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const { cMapUrl, standardFontDataUrl } = resolvePdfjsAssetDirs()

    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      cMapUrl,
      cMapPacked: true,
      standardFontDataUrl,
      // サーバー環境のフォントに依存させない（CMapでの文字コード復元だけを使う）
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
    }).promise

    const pageCount = doc.numPages
    const lines: string[] = []
    for (let i = 1; i <= Math.min(pageCount, MAX_PAGES); i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      let pageText = ""
      for (const item of content.items) {
        if (typeof item === "object" && item !== null && "str" in item) {
          const it = item as { str: string; hasEOL?: boolean }
          pageText += it.str + (it.hasEOL ? "\n" : "")
        }
      }
      if (pageText.trim()) {
        lines.push(pageCount > 1 ? `--- ${i}ページ ---\n${pageText}` : pageText)
      }
    }
    await doc.destroy()

    let text = lines.join("\n")
    if (text.length > MAX_TEXT_LENGTH) text = text.slice(0, MAX_TEXT_LENGTH)

    const cjkCount = countCjk(text)
    return {
      text,
      pageCount,
      cjkCount,
      hasMeaningfulText: cjkCount >= MEANINGFUL_CJK_COUNT,
    }
  } catch (error) {
    console.error("PDFテキスト抽出に失敗:", error)
    return EMPTY_RESULT
  }
}

/**
 * 照合用に文字列を正規化する。
 * 全半角・空白・記号の揺れを吸収し、比較できる形にそろえる。
 */
export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\s　]/g, "")
    .replace(/[()（）「」『』【】［］[\]{}・,，.。:：;；\-‐－—ー_/\\|"'`~^*&#@!?]/g, "")
    .toLowerCase()
}

/** 法人格・支店表記を取り除いて社名の主要部を取り出す */
function coreVendorName(vendor: string): string {
  return normalizeForMatch(vendor)
    .replace(/株式会社|合同会社|有限会社|合資会社|合名会社|医療法人|一般社団法人|一般財団法人|公益社団法人|公益財団法人|特定非営利活動法人|税理士法人|司法書士法人|社会保険労務士法人|㈱|㈲/g, "")
    .replace(/(支店|支社|営業所|出張所|本社|本店|事業所)$/g, "")
}

/**
 * AIが返した取引先名が、書類の実テキストに裏づけられているかを判定する。
 * 判定できない（テキストが無い・社名が短すぎる）場合は null を返す。
 *
 * @returns true=テキストに存在 / false=存在しない（推測の可能性） / null=判定不能
 */
export function isVendorSupportedByText(vendor: string, sourceText: string): boolean | null {
  if (!vendor.trim() || !sourceText.trim()) return null

  const haystack = normalizeForMatch(sourceText)
  if (haystack.length < 10) return null

  const full = normalizeForMatch(vendor)
  if (full.length >= 2 && haystack.includes(full)) return true

  const core = coreVendorName(vendor)
  if (core.length < 2) return null
  if (haystack.includes(core)) return true

  // 「〇〇株式会社 △△店」のように付帯表記が付く場合があるため、
  // 主要部の先頭側（最長4文字まで短縮）でも照合する
  for (let len = core.length - 1; len >= 4; len--) {
    if (haystack.includes(core.slice(0, len))) return true
  }

  return false
}
