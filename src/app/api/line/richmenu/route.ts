import { NextResponse } from "next/server"
import { createClient as createAuthClient } from "@/lib/supabase/server"

/**
 * LINEリッチメニュー（トーク下部に常時出る6つのボタン）の登録・公開。
 *
 * GET  … 現在の登録状況（作成済みのメニュー・全員に公開しているか）
 * POST … action で操作する
 *   setup        リッチメニューを作成し、画像をアップロードする（まだ誰にも出ない）
 *   assign       指定した1人だけに表示する（本番公開前のテスト用）
 *   unassign     指定した1人への表示を取り消す
 *   publishAll   全員に表示する（＝本番公開）
 *   unpublishAll 全員への表示をやめる
 *   deleteAll    作成済みのリッチメニューをすべて削除する（作り直すとき）
 *
 * ■ 公開の順番
 * 作成（setup）しただけでは誰にも表示されない。
 * まず assign で担当のLINEだけに出して確認し、問題なければ publishAll する。
 * 画像を作り直したときは deleteAll → setup → assign の順。
 *
 * ■ ボタンが送るテキスト
 * webhook 側の APPLICATION_MENU_TRIGGERS / RICH_MENU_COMMANDS と一致させること。
 * 一致していないとボタンを押しても何も起きない。
 */

export const maxDuration = 60

const LINE_API = "https://api.line.me/v2/bot"
const LINE_DATA_API = "https://api-data.line.me/v2/bot"

/** リッチメニューの表示名（LINEの管理画面に出る。利用者には見えない） */
const RICH_MENU_NAME = "経費申請メニュー"

/** 画像サイズ。LINEの規定（2500×1686 または 2500×843） */
const WIDTH = 2500
const HEIGHT = 1686

/**
 * 6分割（3列×2行）の領域と、押したときに送るテキスト。
 * public/line/richmenu.jpg の見た目と一致させること。
 */
const AREAS = [
  { col: 0, row: 0, text: "申請" },
  { col: 1, row: 0, text: "電車代" },
  { col: 2, row: 0, text: "申請履歴" },
  { col: 0, row: 1, text: "設定" },
  { col: 1, row: 1, text: "使い方" },
  { col: 2, row: 1, text: "問い合わせ" },
]

function buildAreas() {
  const w = Math.floor(WIDTH / 3)
  const h = Math.floor(HEIGHT / 2)
  return AREAS.map((a) => ({
    bounds: { x: a.col * w, y: a.row * h, width: w, height: h },
    action: { type: "message", text: a.text },
  }))
}

function token(): string {
  const t = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!t) throw new Error("LINE_CHANNEL_ACCESS_TOKEN が設定されていません")
  return t
}

async function lineFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, ...(init.headers ?? {}) },
  })
}

/** LINEのエラー本文をそのまま伝える（原因が分からないと直せないため） */
async function lineError(res: Response, fallback: string): Promise<string> {
  const body = await res.text().catch(() => "")
  return `${fallback}（LINEの応答: ${res.status} ${body.slice(0, 300)}）`
}

export async function GET() {
  const authSupabase = await createAuthClient()
  const {
    data: { user },
  } = await authSupabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  try {
    const listRes = await lineFetch(`${LINE_API}/richmenu/list`, { method: "GET" })
    if (!listRes.ok) {
      return NextResponse.json({ error: await lineError(listRes, "一覧を取得できませんでした") }, { status: 502 })
    }
    const list = (await listRes.json()) as { richmenus?: { richMenuId: string; name: string }[] }

    // 全員に公開しているメニュー（未設定なら404が返る）
    const defaultRes = await lineFetch(`${LINE_API}/user/all/richmenu`, { method: "GET" })
    const defaultId = defaultRes.ok
      ? ((await defaultRes.json()) as { richMenuId?: string }).richMenuId ?? null
      : null

    return NextResponse.json({
      menus: list.richmenus ?? [],
      defaultRichMenuId: defaultId,
      published: !!defaultId,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "取得できませんでした" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const authSupabase = await createAuthClient()
  const {
    data: { user },
  } = await authSupabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  try {
    const body = (await request.json()) as {
      action?: string
      richMenuId?: string
      lineUserId?: string
    }
    const action = body.action

    switch (action) {
      case "setup":
        return await handleSetup(request)
      case "assign": {
        if (!body.richMenuId || !body.lineUserId) {
          return NextResponse.json({ error: "メニューとLINEユーザーIDが必要です" }, { status: 400 })
        }
        const res = await lineFetch(
          `${LINE_API}/user/${encodeURIComponent(body.lineUserId)}/richmenu/${body.richMenuId}`,
          { method: "POST" }
        )
        if (!res.ok) {
          return NextResponse.json({ error: await lineError(res, "表示できませんでした") }, { status: 502 })
        }
        return NextResponse.json({ ok: true })
      }
      case "unassign": {
        if (!body.lineUserId) return NextResponse.json({ error: "LINEユーザーIDが必要です" }, { status: 400 })
        const res = await lineFetch(`${LINE_API}/user/${encodeURIComponent(body.lineUserId)}/richmenu`, {
          method: "DELETE",
        })
        if (!res.ok && res.status !== 404) {
          return NextResponse.json({ error: await lineError(res, "取り消せませんでした") }, { status: 502 })
        }
        return NextResponse.json({ ok: true })
      }
      case "publishAll": {
        if (!body.richMenuId) return NextResponse.json({ error: "メニューが必要です" }, { status: 400 })
        const res = await lineFetch(`${LINE_API}/user/all/richmenu/${body.richMenuId}`, { method: "POST" })
        if (!res.ok) {
          return NextResponse.json({ error: await lineError(res, "公開できませんでした") }, { status: 502 })
        }
        return NextResponse.json({ ok: true })
      }
      case "unpublishAll": {
        const res = await lineFetch(`${LINE_API}/user/all/richmenu`, { method: "DELETE" })
        if (!res.ok && res.status !== 404) {
          return NextResponse.json({ error: await lineError(res, "取り消せませんでした") }, { status: 502 })
        }
        return NextResponse.json({ ok: true })
      }
      case "deleteAll": {
        const listRes = await lineFetch(`${LINE_API}/richmenu/list`, { method: "GET" })
        if (!listRes.ok) {
          return NextResponse.json({ error: await lineError(listRes, "一覧を取得できませんでした") }, { status: 502 })
        }
        const list = (await listRes.json()) as { richmenus?: { richMenuId: string }[] }
        let deleted = 0
        for (const m of list.richmenus ?? []) {
          const res = await lineFetch(`${LINE_API}/richmenu/${m.richMenuId}`, { method: "DELETE" })
          if (res.ok) deleted++
        }
        return NextResponse.json({ ok: true, deleted })
      }
      default:
        return NextResponse.json({ error: "操作が指定されていません" }, { status: 400 })
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "処理できませんでした" }, { status: 500 })
  }
}

/** リッチメニューを作成し、画像をアップロードする */
async function handleSetup(request: Request): Promise<NextResponse> {
  // 1. メニューの定義を登録する
  const createRes = await lineFetch(`${LINE_API}/richmenu`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      size: { width: WIDTH, height: HEIGHT },
      selected: true, // トークを開いたときに開いた状態にする
      name: RICH_MENU_NAME,
      chatBarText: "メニュー",
      areas: buildAreas(),
    }),
  })
  if (!createRes.ok) {
    return NextResponse.json({ error: await lineError(createRes, "メニューを作成できませんでした") }, { status: 502 })
  }
  const { richMenuId } = (await createRes.json()) as { richMenuId: string }

  // 2. 画像を取得する（public/line/richmenu.jpg を自分自身のURLから読む）
  const origin = new URL(request.url).origin
  const imageRes = await fetch(`${origin}/line/richmenu.jpg`)
  if (!imageRes.ok) {
    return NextResponse.json(
      { error: "メニュー画像（/line/richmenu.jpg）を取得できませんでした" },
      { status: 500 }
    )
  }
  const image = await imageRes.arrayBuffer()

  // 3. 画像をアップロードする（アップロードだけ別ホスト api-data.line.me）
  const uploadRes = await lineFetch(`${LINE_DATA_API}/richmenu/${richMenuId}/content`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: image,
  })
  if (!uploadRes.ok) {
    // 画像が無いメニューが残ると紛らわしいので、失敗したら消しておく
    await lineFetch(`${LINE_API}/richmenu/${richMenuId}`, { method: "DELETE" }).catch(() => {})
    return NextResponse.json(
      { error: await lineError(uploadRes, "画像をアップロードできませんでした") },
      { status: 502 }
    )
  }

  return NextResponse.json({ ok: true, richMenuId })
}
