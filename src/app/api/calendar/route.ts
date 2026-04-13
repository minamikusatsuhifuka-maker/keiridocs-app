// Google カレンダー連携 API
// 書類の支払期日を Google カレンダーにイベントとして自動登録する
import { NextRequest, NextResponse } from "next/server"
import { google } from "googleapis"
import { createClient } from "@/lib/supabase/server"
import type { Database } from "@/types/database"

type DocumentRow = Database["public"]["Tables"]["documents"]["Row"]

/** カレンダーID（プライマリ） */
const CALENDAR_ID = "primary"

/** カラーID 11 = 赤（Google カレンダー標準色） */
const RED_COLOR_ID = "11"

/** タイムゾーン */
const TIME_ZONE = "Asia/Tokyo"

/**
 * Google カレンダー用 OAuth2 クライアントを生成する。
 * GOOGLE_* 環境変数を優先し、未設定時は Gmail 連携の認証情報にフォールバックする。
 */
function getCalendarAuth() {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? process.env.GMAIL_CLIENT_ID
  const clientSecret =
    process.env.GOOGLE_CLIENT_SECRET ?? process.env.GMAIL_CLIENT_SECRET
  const refreshToken =
    process.env.GOOGLE_REFRESH_TOKEN ?? process.env.GMAIL_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    return null
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret)
  oauth2Client.setCredentials({ refresh_token: refreshToken })
  return oauth2Client
}

/** 設定状況を返す */
export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const auth = getCalendarAuth()
  return NextResponse.json({ configured: auth !== null })
}

/** 書類の支払期日を Google カレンダーに登録する */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  const auth = getCalendarAuth()
  if (!auth) {
    return NextResponse.json(
      {
        error:
          "Google カレンダー連携が未設定です。設定ページから連携を行ってください",
        configRequired: true,
      },
      { status: 412 }
    )
  }

  try {
    const body = (await request.json()) as {
      documentId?: unknown
    }

    if (typeof body.documentId !== "string" || !body.documentId) {
      return NextResponse.json({ error: "documentId が必要です" }, { status: 400 })
    }

    // 対象書類を取得
    const { data: fetchedDoc, error: fetchError } = await supabase
      .from("documents")
      .select("*")
      .eq("id", body.documentId)
      .single()

    if (fetchError || !fetchedDoc) {
      return NextResponse.json({ error: "書類が見つかりません" }, { status: 404 })
    }

    const document = fetchedDoc as DocumentRow

    if (!document.due_date) {
      return NextResponse.json(
        { error: "支払期日が設定されていません" },
        { status: 400 }
      )
    }

    // カレンダー登録済みの場合はスキップ
    if (document.calendar_event_id) {
      return NextResponse.json({
        data: { eventId: document.calendar_event_id, alreadyRegistered: true },
      })
    }

    const amountText =
      document.amount != null ? `¥${document.amount.toLocaleString()}` : ""
    const summary = `支払期日: ${document.vendor_name}${amountText ? ` ${amountText}` : ""}`

    const descriptionLines = [
      `種別: ${document.type}`,
      `勘定科目: ${document.account_title ?? "-"}`,
      "経理書類管理より自動登録",
    ]

    const calendar = google.calendar({ version: "v3", auth })
    const eventResponse = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary,
        description: descriptionLines.join("\n"),
        colorId: RED_COLOR_ID,
        start: {
          date: document.due_date,
          timeZone: TIME_ZONE,
        },
        end: {
          date: document.due_date,
          timeZone: TIME_ZONE,
        },
        reminders: {
          useDefault: false,
          overrides: [
            { method: "popup", minutes: 60 * 24 }, // 1日前
            { method: "popup", minutes: 60 * 24 * 3 }, // 3日前
          ],
        },
      },
    })

    const eventId = eventResponse.data.id
    if (!eventId) {
      return NextResponse.json(
        { error: "カレンダー登録に失敗しました" },
        { status: 500 }
      )
    }

    // 書類に eventId を保存
    const { error: updateError } = await supabase
      .from("documents")
      .update({ calendar_event_id: eventId })
      .eq("id", document.id)

    if (updateError) {
      console.error("calendar_event_id 更新エラー:", updateError)
    }

    return NextResponse.json({
      data: { eventId, htmlLink: eventResponse.data.htmlLink ?? null },
    })
  } catch (error) {
    console.error("カレンダー登録エラー:", error)
    const message =
      error instanceof Error ? error.message : "カレンダー登録に失敗しました"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
