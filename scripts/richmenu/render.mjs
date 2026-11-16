/**
 * リッチメニュー画像（richmenu.png・2500×1686）を richmenu.html から生成する。
 *   npm run richmenu:render
 * Playwright（Chromium）で deviceScaleFactor: 1 のスクリーンショットを撮る。
 * LINEの上限（1MB）を超えた場合はエラーにする。
 */
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"
import fs from "node:fs"

const dir = path.dirname(fileURLToPath(import.meta.url))
const htmlPath = path.join(dir, "richmenu.html")
const outPath = path.join(dir, "richmenu.png")
const MAX_BYTES = 1024 * 1024

// Playwright はプロジェクトの依存に入れていない（画像を作り直すときだけ使う）。
// 未インストールの環境では `npx -y playwright@1 install chromium` 後に `npm i --no-save playwright` してから実行する。
let chromium
try {
  ;({ chromium } = createRequire(import.meta.url)("playwright"))
} catch {
  console.error("playwright が見つかりません。`npm i --no-save playwright && npx playwright install chromium` を実行してください。")
  process.exit(1)
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 2500, height: 1686 }, deviceScaleFactor: 1 })
  await page.goto(pathToFileURL(htmlPath).href)
  // 丸ゴシックの読み込みを待つ（読み込めないと代替フォントで撮れてしまうため確認する）
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  const fontOk = await page.evaluate(() => document.fonts.check("700 104px 'Zen Maru Gothic'", "申請履歴問い合わせ"))
  if (!fontOk) throw new Error("Zen Maru Gothic が読み込めませんでした（npm install 済みか確認してください）")
  await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: 2500, height: 1686 } })
} finally {
  await browser.close()
}

const size = fs.statSync(outPath).size
console.log(`生成しました: ${outPath}（${(size / 1024).toFixed(0)} KB）`)
if (size > MAX_BYTES) {
  console.error("LINEのリッチメニュー画像の上限（1MB）を超えています。")
  process.exit(1)
}
