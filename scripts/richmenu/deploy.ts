/**
 * LINEリッチメニューを Messaging API で登録する。
 *
 *   npm run richmenu:deploy -- --dry-run            … 送信内容の確認だけ（APIは呼ばない）
 *   npm run richmenu:deploy -- --user <LINEユーザーID> … 作成して「そのユーザーだけ」に表示（テスト用。全員の既定・旧メニューには触れない）
 *   npm run richmenu:deploy                         … 作成して全ユーザーの既定メニューに設定し、旧メニューを削除（本番反映）
 *
 * アクセストークンは既存の環境変数 LINE_CHANNEL_ACCESS_TOKEN を使う（.env.local から読み込む）。
 * 画像は richmenu.png（`npm run richmenu:render` で生成）、領域とボタンの送信テキストは richmenu.config.json。
 */
import fs from "node:fs"
import path from "node:path"
import { config as loadEnv } from "dotenv"

loadEnv({ path: path.resolve(process.cwd(), ".env.local") })

const DIR = path.resolve(process.cwd(), "scripts/richmenu")
const API = "https://api.line.me/v2/bot"
/** 画像のアップロードは api-data.line.me（api.line.me ではない） */
const DATA_API = "https://api-data.line.me/v2/bot"

interface AreaConfig {
  label: string
  text: string
  bounds: { x: number; y: number; width: number; height: number }
}
interface MenuConfig {
  name: string
  chatBarText: string
  selected: boolean
  size: { width: number; height: number }
  areas: AreaConfig[]
}

function parseArgs(argv: string[]): { dryRun: boolean; user: string | null } {
  const userIdx = argv.indexOf("--user")
  return {
    dryRun: argv.includes("--dry-run"),
    user: userIdx >= 0 ? argv[userIdx + 1] ?? null : null,
  }
}

/** 定義の検証（領域が画像からはみ出していないか・6領域が重ならず全面を覆うか） */
function validate(cfg: MenuConfig, png: Buffer): void {
  if (png.length > 1024 * 1024) throw new Error(`画像が1MBを超えています（${png.length} bytes）`)
  // PNG の IHDR から幅・高さを読む
  const w = png.readUInt32BE(16)
  const h = png.readUInt32BE(20)
  if (w !== cfg.size.width || h !== cfg.size.height) {
    throw new Error(`画像サイズ ${w}×${h} が定義 ${cfg.size.width}×${cfg.size.height} と一致しません`)
  }
  if ([...cfg.chatBarText].length > 14) throw new Error("chatBarText は14文字以内にしてください")
  let area = 0
  for (const a of cfg.areas) {
    const { x, y, width, height } = a.bounds
    if (x < 0 || y < 0 || x + width > w || y + height > h) throw new Error(`領域「${a.label}」が画像の外にはみ出しています`)
    area += width * height
  }
  if (area !== w * h) console.warn(`⚠️ 領域の合計面積（${area}）が画像全体（${w * h}）と一致しません`)
}

async function call(token: string, method: string, url: string, body?: unknown, contentType = "application/json") {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": contentType } : {}) },
    body: body === undefined ? undefined : body instanceof Buffer ? new Uint8Array(body) : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text}`)
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

async function main(): Promise<void> {
  const { dryRun, user } = parseArgs(process.argv.slice(2))
  const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "richmenu.config.json"), "utf8")) as MenuConfig
  const png = fs.readFileSync(path.join(DIR, "richmenu.png"))
  validate(cfg, png)

  const richMenu = {
    size: cfg.size,
    selected: cfg.selected,
    name: cfg.name,
    chatBarText: cfg.chatBarText,
    areas: cfg.areas.map((a) => ({ bounds: a.bounds, action: { type: "message", label: a.label, text: a.text } })),
  }

  if (dryRun) {
    console.log("【dry-run】登録する定義:")
    console.log(JSON.stringify(richMenu, null, 2))
    console.log(`画像: richmenu.png（${(png.length / 1024).toFixed(0)} KB）`)
    return
  }

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN が設定されていません（.env.local）")

  // 1. 定義の検証（LINE側）→ 作成
  await call(token, "POST", `${API}/richmenu/validate`, richMenu)
  const created = await call(token, "POST", `${API}/richmenu`, richMenu)
  const richMenuId = String(created.richMenuId)
  console.log(`作成しました: ${richMenuId}`)

  // 2. 画像アップロード（api-data.line.me）
  await call(token, "POST", `${DATA_API}/richmenu/${richMenuId}/content`, png, "image/png")
  console.log("画像をアップロードしました")

  if (user) {
    // テスト：指定したユーザーだけに表示（既定メニュー・旧メニューは変更しない）
    await call(token, "POST", `${API}/user/${user}/richmenu/${richMenuId}`)
    console.log(`ユーザー ${user} にだけ表示しました（テスト）。元に戻すには: DELETE ${API}/user/${user}/richmenu`)
    return
  }

  // 3. 全ユーザーの既定メニューに設定
  await call(token, "POST", `${API}/user/all/richmenu/${richMenuId}`)
  console.log("全ユーザーの既定メニューに設定しました")

  // 4. 旧メニューを削除
  const list = await call(token, "GET", `${API}/richmenu/list`)
  const menus = (list.richmenus as { richMenuId: string; name: string }[] | undefined) ?? []
  for (const m of menus) {
    if (m.richMenuId === richMenuId) continue
    await call(token, "DELETE", `${API}/richmenu/${m.richMenuId}`)
    console.log(`旧メニューを削除しました: ${m.richMenuId}（${m.name}）`)
  }
}

main().catch((e) => {
  console.error("リッチメニューの登録に失敗しました:", e instanceof Error ? e.message : e)
  process.exit(1)
})
