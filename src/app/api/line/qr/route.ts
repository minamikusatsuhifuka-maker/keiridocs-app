import { NextResponse } from "next/server"
import QRCode from "qrcode"
import { createClient as createAuthClient } from "@/lib/supabase/server"

/**
 * LINE公式アカウントの友だち追加QR。
 *
 * GET /api/line/qr
 *
 * スタッフに配る案内用。アカウントのID（ベーシックID）はLINE側から取得し、
 * 友だち追加のURLを組み立ててQRにする。
 * IDを手で控えて貼り間違える事故を避けるため、毎回LINEに問い合わせる。
 *
 * QRはSVGで返す（印刷しても粗くならない）。
 */

export const maxDuration = 30

export async function GET() {
  const supabase = await createAuthClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) {
    return NextResponse.json(
      { error: "LINEのアクセストークンが設定されていません" },
      { status: 500 }
    )
  }

  try {
    const res = await fetch("https://api.line.me/v2/bot/info", {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      return NextResponse.json(
        { error: `LINEのアカウント情報を取得できませんでした（${res.status} ${body.slice(0, 200)}）` },
        { status: 502 }
      )
    }
    const info = (await res.json()) as {
      basicId?: string
      displayName?: string
      pictureUrl?: string
    }
    if (!info.basicId) {
      return NextResponse.json({ error: "アカウントのIDを取得できませんでした" }, { status: 502 })
    }

    // ベーシックIDは「@」付きで返る。友だち追加URLは「@」を除いた形
    const id = info.basicId.replace(/^@/, "")
    const addUrl = `https://line.me/R/ti/p/@${id}`

    // 印刷しても粗くならないようSVGで作る。
    // 誤り訂正は M（汚れや折り目に強く、サイズも大きくなりすぎない）
    const svg = await QRCode.toString(addUrl, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      width: 480,
    })

    return NextResponse.json({
      basicId: info.basicId,
      displayName: info.displayName ?? "",
      addUrl,
      svg,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "QRコードを作成できませんでした" },
      { status: 500 }
    )
  }
}
