import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"
import { hasPendingNameChange, parseLineProfile } from "@/lib/line-staff-profile"

/** サービスロールキーでRLSをバイパスするSupabaseクライアント */
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createSupabaseClient<Database>(url, serviceKey)
}

/** 認証チェック（通常クライアントで行う） */
async function checkAuth() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

// スタッフ一覧取得（全カラム取得でline_user_idを確実に含む）
export async function GET() {
  const user = await checkAuth()
  if (!user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const service = createServiceClient()
    const { data, error } = await service
      .from("staff_members")
      .select("*")
      .order("created_at", { ascending: true })

    if (error) {
      console.error("LINEスタッフ一覧取得エラー:", error.message, error.details, error.hint)
      throw error
    }

    return NextResponse.json({ data })
  } catch (error) {
    console.error("LINEスタッフ一覧取得エラー:", error)
    return NextResponse.json(
      { error: "スタッフ一覧の取得に失敗しました" },
      { status: 500 }
    )
  }
}

// 新規スタッフ追加（サービスロールでRLSバイパス）
export async function POST(request: NextRequest) {
  const user = await checkAuth()
  if (!user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as { name?: string; legal_name?: string | null }
    const name = body.name?.trim()
    // 給与・行政上の氏名（旧姓で勤務している場合のみ）。同じなら保存しない
    const legalName = body.legal_name?.trim() || null

    if (!name) {
      return NextResponse.json({ error: "名前は必須です" }, { status: 400 })
    }

    const service = createServiceClient()
    let { data, error } = await service
      .from("staff_members")
      .insert(legalName ? { name, legal_name: legalName } : { name })
      .select("*")
      .single()

    // 046 未適用の環境では legal_name が無いので、氏名だけで登録し直す
    if (error && legalName && /legal_name|PGRST204|42703/.test(`${error.message} ${error.code}`)) {
      console.warn("legal_name 未適用のため氏名のみで登録します:", error.message)
      const retry = await service.from("staff_members").insert({ name }).select("*").single()
      data = retry.data
      error = retry.error
    }

    if (error) {
      console.error("スタッフ追加エラー:", error.message, error.details, error.hint, error.code)
      throw error
    }

    console.log("スタッフ追加成功:", data)
    return NextResponse.json({ data })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error("スタッフ追加エラー:", msg)
    return NextResponse.json(
      { error: `スタッフの追加に失敗しました: ${msg}` },
      { status: 500 }
    )
  }
}

// スタッフ更新（名前・line_user_id）
export async function PUT(request: NextRequest) {
  const user = await checkAuth()
  if (!user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as {
      id?: string
      name?: string
      legal_name?: string | null
      line_user_id?: string | null
      home_station?: string | null
      home_station_pref?: string | null
    }

    if (!body.id) {
      return NextResponse.json({ error: "IDは必須です" }, { status: 400 })
    }

    const updates: Record<string, unknown> = {}
    if (body.name !== undefined) {
      const name = body.name?.trim()
      if (!name) {
        return NextResponse.json({ error: "名前は必須です" }, { status: 400 })
      }
      updates.name = name
    }
    // 給与・行政上の氏名。結婚などで戸籍の氏名が変わっても旧姓で勤務する場合に入れる。
    // 仕事上の氏名（name）と同じなら保存しない（併記が増えて画面が読みにくくなる）。
    if (body.legal_name !== undefined) {
      const legal = body.legal_name?.trim() || ""
      updates.legal_name = legal || null
    }
    if (body.line_user_id !== undefined) {
      updates.line_user_id = body.line_user_id
    }
    // 自宅最寄り駅（領収書なし交通費の電車運賃AI推定に使用）。空文字はNULLとして保存
    if (body.home_station !== undefined) {
      updates.home_station = body.home_station?.trim() || null
    }
    if (body.home_station_pref !== undefined) {
      updates.home_station_pref = body.home_station_pref?.trim() || null
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "更新する項目がありません" }, { status: 400 })
    }

    const service = createServiceClient()

    // 氏名を変更した場合は、LINEからの「お名前の変更依頼」を対応済みにする。
    // line_user_id（LINEの紐づけ）と過去の申請（staff_member_id で紐づく）は変わらないため、改姓しても履歴は壊れない。
    if (updates.name !== undefined) {
      const { data: cur, error: curError } = await service
        .from("staff_members")
        .select("line_profile")
        .eq("id", body.id)
        .maybeSingle()
      if (!curError && cur) {
        const profile = parseLineProfile((cur as { line_profile?: unknown }).line_profile)
        if (hasPendingNameChange(profile)) {
          const now = new Date().toISOString()
          profile.name_change_requests = (profile.name_change_requests ?? []).map((r) =>
            r.resolved_at ? r : { ...r, resolved_at: now }
          )
          updates.line_profile = profile
        }
      }
    }

    const { data, error } = await service
      .from("staff_members")
      .update(updates)
      .eq("id", body.id)
      .select("*")
      .single()

    if (error) {
      console.error("スタッフ更新エラー:", error.message, error.details, error.hint, error.code)
      // 自宅最寄り駅カラム未適用（migration033未実行）の場合は分かりやすく案内
      const isMissingColumn =
        error.code === "PGRST204" ||
        error.code === "42703" ||
        /home_station|legal_name/.test(error.message || "")
      if (isMissingColumn) {
        const missingLegalName = /legal_name/.test(error.message || "")
        return NextResponse.json(
          {
            error: missingLegalName
              ? "給与・行政上の氏名カラムが未適用です。migration 046_staff_legal_name.sql を実行してください。"
              : "自宅最寄り駅カラムが未適用です。migration 033_staff_home_station.sql を実行してください。",
          },
          { status: 400 }
        )
      }
      throw error
    }

    return NextResponse.json({ data })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error("スタッフ更新エラー:", msg)
    return NextResponse.json(
      { error: `スタッフの更新に失敗しました: ${msg}` },
      { status: 500 }
    )
  }
}

// スタッフのトグル系更新（PATCH）。次のいずれかのbodyを受け付ける:
//  - { id, is_test: boolean }                … テストスタッフ切替（保存先分離・集計/通知から除外）
//  - { id, seminar_repeat_claimed: boolean }  … セミナー2回目以降（ON→初回ATC非表示 / OFF→再表示）
// 会計履歴（petty_cash_transactions）は書き換えず、staff_members のフラグだけを切り替える。
export async function PATCH(request: NextRequest) {
  const user = await checkAuth()
  if (!user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as {
      id?: string
      seminar_repeat_claimed?: boolean
      is_test?: boolean
      retired?: boolean
      /** 既受講の登録（アプリ導入前に受講した回数）。count=null で登録を取り消す */
      priorCourse?: { courseId?: string; count?: number | null }
    }
    if (!body.id) {
      return NextResponse.json({ error: "IDは必須です" }, { status: 400 })
    }

    const service = createServiceClient()

    // 既受講の登録（アプリ導入前・旧LINEでの受講回数）。
    // 登録しないと既受講者が「初受講＝全額支給」と判定され過大支給になるため、
    // 未登録のままATCの受講料が申請されたら要対応に上がる仕組みと対になっている。
    if (body.priorCourse) {
      const courseId = body.priorCourse.courseId
      if (!courseId) {
        return NextResponse.json({ error: "講座が指定されていません" }, { status: 400 })
      }
      const raw = body.priorCourse.count
      const count = raw === null || raw === undefined ? null : Math.max(0, Math.floor(raw))
      if (count !== null && count > 99) {
        return NextResponse.json({ error: "回数は0〜99で指定してください" }, { status: 400 })
      }

      const { data: member, error: readError } = await service
        .from("staff_members")
        .select("line_profile")
        .eq("id", body.id)
        .single()
      if (readError || !member) {
        return NextResponse.json({ error: "スタッフが見つかりません" }, { status: 404 })
      }

      const profile = parseLineProfile(member.line_profile)
      const others = (profile.prior_courses ?? []).filter((p) => p.course_id !== courseId)
      const next =
        count === null
          ? others
          : [
              ...others,
              {
                course_id: courseId,
                count,
                updated_at: new Date().toISOString(),
                updated_by: user.email ?? undefined,
              },
            ]

      const { data, error } = await service
        .from("staff_members")
        // Json 型へ渡すため、構造化した値を一度プレーンなJSONに落とす
        .update({ line_profile: JSON.parse(JSON.stringify({ ...profile, prior_courses: next })) })
        .eq("id", body.id)
        .select("*")
        .single()
      if (error) {
        console.error("既受講登録エラー:", error.message, error.code)
        throw error
      }
      return NextResponse.json({ data })
    }

    // 退職の切替（論理削除）。退職者は一覧から隠し、LINEからの申請も受け付けないが、
    // 過去の申請記録は残す（削除すると領収書レコードがCASCADEで消えてしまうため）。
    if (typeof body.retired === "boolean") {
      const { data, error } = await service
        .from("staff_members")
        .update({ retired_at: body.retired ? new Date().toISOString() : null })
        .eq("id", body.id)
        .select("*")
        .single()
      if (error) {
        const isMissingColumn =
          error.code === "PGRST204" || error.code === "42703" || /retired_at/.test(error.message || "")
        if (isMissingColumn) {
          return NextResponse.json(
            { error: "retired_at カラムが未適用です。migration 043_staff_retired.sql を実行してください。" },
            { status: 400 }
          )
        }
        console.error("退職切替エラー:", error.message, error.code)
        throw error
      }
      return NextResponse.json({ data })
    }

    // テストスタッフ切替（ON/OFF）
    if (typeof body.is_test === "boolean") {
      const { data, error } = await service
        .from("staff_members")
        .update({ is_test: body.is_test })
        .eq("id", body.id)
        .select("*")
        .single()
      if (error) {
        console.error("テストスタッフ切替エラー:", error.message, error.code)
        const isMissingColumn =
          error.code === "PGRST204" || error.code === "42703" || /is_test/.test(error.message || "")
        if (isMissingColumn) {
          return NextResponse.json(
            { error: "is_test カラムが未適用です。migration 035_staff_is_test.sql を実行してください。" },
            { status: 400 }
          )
        }
        throw error
      }
      return NextResponse.json({ data })
    }

    if (typeof body.seminar_repeat_claimed !== "boolean") {
      return NextResponse.json({ error: "seminar_repeat_claimed（真偽値）は必須です" }, { status: 400 })
    }
    const claimed = body.seminar_repeat_claimed

    // ON要求かつ既に申請済みなら、元の申請日時を保持（上書きしない・冪等）
    if (claimed) {
      const { data: current, error: readError } = await service
        .from("staff_members")
        .select("seminar_repeat_claimed_at")
        .eq("id", body.id)
        .single()
      if (!readError) {
        const existing = (current as { seminar_repeat_claimed_at?: string | null } | null)?.seminar_repeat_claimed_at
        if (existing) {
          return NextResponse.json({ data: current })
        }
      }
    }

    const newValue = claimed ? new Date().toISOString() : null
    const { data, error } = await service
      .from("staff_members")
      .update({ seminar_repeat_claimed_at: newValue })
      .eq("id", body.id)
      .select("*")
      .single()

    if (error) {
      console.error("セミナー2回目以降状態更新エラー:", error.message, error.details, error.hint, error.code)
      // 列未適用（migration未実行）の場合は分かりやすく案内
      const isMissingColumn =
        error.code === "PGRST204" || error.code === "42703" || /seminar_repeat_claimed_at/.test(error.message || "")
      if (isMissingColumn) {
        return NextResponse.json(
          { error: "seminar_repeat_claimed_at カラムが未適用です。migration 032_seminar_repeat_claimed.sql を実行してください。" },
          { status: 400 }
        )
      }
      throw error
    }

    return NextResponse.json({ data })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error("セミナー2回目以降状態更新エラー:", msg)
    return NextResponse.json(
      { error: `セミナー2回目以降状態の更新に失敗しました: ${msg}` },
      { status: 500 }
    )
  }
}

// スタッフ削除
export async function DELETE(request: NextRequest) {
  const user = await checkAuth()
  if (!user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get("id")

    if (!id) {
      return NextResponse.json({ error: "IDは必須です" }, { status: 400 })
    }

    const service = createServiceClient()

    // 過去の申請があるスタッフは削除できない。
    // staff_receipts は ON DELETE CASCADE なので削除すると領収書レコードが全件消え、
    // petty_cash_transactions は ON DELETE SET NULL なので支給取引の氏名が失われる。
    // どちらも税理士提出リストの裏づけが壊れるため、退職者は「退職」で外すこと。
    const [{ count: receiptCount }, { count: txCount }] = await Promise.all([
      service
        .from("staff_receipts")
        .select("id", { count: "exact", head: true })
        .eq("staff_member_id", id),
      service
        .from("petty_cash_transactions")
        .select("id", { count: "exact", head: true })
        .eq("staff_member_id", id),
    ])

    const total = (receiptCount ?? 0) + (txCount ?? 0)
    if (total > 0) {
      const { data: member } = await service
        .from("staff_members")
        .select("name")
        .eq("id", id)
        .single()
      return NextResponse.json(
        {
          error:
            `「${member?.name ?? "このスタッフ"}」には過去の申請が ${total} 件あるため削除できません。` +
            `削除すると領収書の記録が消え、税理士提出リストの裏づけが失われます。` +
            `退職された場合は「退職」に切り替えてください（記録は残り、一覧からは隠れます）。`,
        },
        { status: 409 }
      )
    }

    const { error } = await service
      .from("staff_members")
      .delete()
      .eq("id", id)

    if (error) {
      console.error("スタッフ削除エラー:", error.message, error.details, error.hint, error.code)
      throw error
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error("スタッフ削除エラー:", msg)
    return NextResponse.json(
      { error: `スタッフの削除に失敗しました: ${msg}` },
      { status: 500 }
    )
  }
}
