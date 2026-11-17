import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"
import {
  hasPendingNameChange,
  parseLineProfile,
  travelCapResetAt,
  type TravelCapReset,
} from "@/lib/line-staff-profile"
import { fetchAllRows } from "@/lib/supabase/fetch-all"
import { isTravelItem, type ExpenseItem } from "@/lib/subsidy-rules"

/** サービスロールキーでRLSをバイパスするSupabaseクライアント */
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です")
  }
  return createSupabaseClient<Database>(url, serviceKey)
}

/**
 * その講座で枠（交通費＋宿泊費 合計30,000円）を使っている立替額の合計。
 *
 * 画面に「いま枠をいくら使っているか」を出すためと、数え直しの記録を残すために使う。
 * 数え直し済みならそれ以降の分だけを数える（assessSubsidy と同じ数え方にそろえる）。
 */
async function sumTravelCapUsed(
  service: ReturnType<typeof createServiceClient>,
  staffMemberId: string,
  courseId: string
): Promise<number> {
  const resetAt = await (async () => {
    const { data } = await service
      .from("staff_members")
      .select("line_profile")
      .eq("id", staffMemberId)
      .maybeSingle()
    return travelCapResetAt((data as { line_profile?: unknown } | null)?.line_profile, courseId)
  })()

  type Row = {
    amount: number | null
    excess_amount: number | null
    expense_item: string | null
    created_at: string | null
  }
  const rows = await fetchAllRows<Row>((from, to) =>
    service
      .from("petty_cash_transactions")
      .select("amount, excess_amount, expense_item, created_at")
      .eq("category", "staff_refund")
      .eq("staff_member_id", staffMemberId)
      .eq("course_id", courseId)
      .order("created_at", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: Row[] | null
        error: { message: string } | null
      }>
  )

  return rows
    .filter((r) => isTravelItem(r.expense_item as ExpenseItem))
    .filter((r) => !resetAt || !r.created_at || r.created_at > resetAt)
    .reduce((sum, r) => sum + Math.max(0, (r.amount ?? 0) - (r.excess_amount ?? 0)), 0)
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
    // 給与・行政上の氏名。院内と同じ場合も入力してもらう（必須）。
    // 任意にすると「空欄＝同じ」と「入力し忘れ」が区別できず、給与処理の取り違えにつながる。
    const legalName = body.legal_name?.trim() || null

    if (!name) {
      return NextResponse.json({ error: "院内で使っているお名前は必須です" }, { status: 400 })
    }
    if (!legalName) {
      return NextResponse.json(
        { error: "給与や手続きに使うお名前は必須です（院内と同じ場合も同じお名前を入力してください）" },
        { status: 400 }
      )
    }

    const service = createServiceClient()
    let { data, error } = await service
      .from("staff_members")
      .insert({ name, legal_name: legalName })
      .select("*")
      .single()

    // 046 未適用の環境では legal_name が無いので、氏名だけで登録し直す
    if (error && /legal_name|PGRST204|42703/.test(`${error.message} ${error.code}`)) {
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
    // 給与・行政上の氏名。院内と同じ場合も入力してもらう（必須）。
    // 任意にすると「空欄＝同じ」と「入力し忘れ」が区別できず、給与処理の取り違えにつながる。
    if (body.legal_name !== undefined) {
      const legal = body.legal_name?.trim() || ""
      if (!legal) {
        return NextResponse.json(
          { error: "給与や手続きに使うお名前は必須です（院内と同じ場合も同じお名前を入力してください）" },
          { status: 400 }
        )
      }
      updates.legal_name = legal
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
      /**
       * 交通費・宿泊費の枠（講座ごと30,000円）を数え直す。
       * undo=true でいちばん新しい数え直しを取り消す。
       */
      travelCapReset?: { courseId?: string; undo?: boolean }
      /** アカデミー会員のサービス開始日（YYYY-MM-DD。null で登録を取り消す） */
      academyStart?: string | null
      /** 一時休止（産休・育休・休職など）。true で停止、false で再開 */
      suspended?: boolean
      /** 休止の理由（画面に出すだけ。判定には使わない） */
      suspendReason?: string | null
      /** 担当か（スタッフからの問い合わせをこの人のLINEへ転送する） */
      receptionist?: boolean
    }
    if (!body.id) {
      return NextResponse.json({ error: "IDは必須です" }, { status: 400 })
    }

    const service = createServiceClient()

    // 担当。スタッフが「問い合わせ」で送った内容がこの人のLINEに届く
    if (typeof body.receptionist === "boolean") {
      const { data: member, error: readError } = await service
        .from("staff_members")
        .select("line_profile")
        .eq("id", body.id)
        .single()
      if (readError || !member) {
        return NextResponse.json({ error: "スタッフが見つかりません" }, { status: 404 })
      }
      const profile = parseLineProfile(member.line_profile)
      if (body.receptionist) profile.is_receptionist = true
      else delete profile.is_receptionist
      const { data, error } = await service
        .from("staff_members")
        .update({ line_profile: JSON.parse(JSON.stringify(profile)) })
        .eq("id", body.id)
        .select("*")
        .single()
      if (error) {
        console.error("担当の更新エラー:", error.message)
        return NextResponse.json({ error: "更新に失敗しました" }, { status: 500 })
      }
      return NextResponse.json({ data })
    }

    // 一時休止（産休・育休・休職など）。
    // 退職と違い在籍したまま申請だけを止める。再開すればそのまま使える。
    if (typeof body.suspended === "boolean") {
      const { data: member, error: readError } = await service
        .from("staff_members")
        .select("line_profile")
        .eq("id", body.id)
        .single()
      if (readError || !member) {
        return NextResponse.json({ error: "スタッフが見つかりません" }, { status: 404 })
      }
      const profile = parseLineProfile(member.line_profile)
      if (body.suspended) {
        profile.suspended = {
          at: new Date().toISOString(),
          reason: body.suspendReason?.trim() || undefined,
          by: user.email ?? "担当",
        }
      } else {
        delete profile.suspended
      }
      const { data, error } = await service
        .from("staff_members")
        .update({ line_profile: JSON.parse(JSON.stringify(profile)) })
        .eq("id", body.id)
        .select("*")
        .single()
      if (error) {
        console.error("休止状態の更新エラー:", error.message)
        return NextResponse.json({ error: "更新に失敗しました" }, { status: 500 })
      }
      return NextResponse.json({ data })
    }

    // アカデミー会員のサービス開始日。
    // 本人はLINEで1回登録するだけで、あとから変更できない（期限切れの申請を
    // 通せてしまうため）。間違いの修正はここで担当が行う。
    if (body.academyStart !== undefined) {
      const raw = (body.academyStart ?? "").trim()
      if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return NextResponse.json({ error: "日付は YYYY-MM-DD の形式で指定してください" }, { status: 400 })
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
      if (raw) {
        profile.academy = {
          start_date: raw,
          updated_at: new Date().toISOString(),
          updated_by: user.email ?? "担当",
        }
      } else {
        delete profile.academy
      }
      const { data, error } = await service
        .from("staff_members")
        .update({ line_profile: JSON.parse(JSON.stringify(profile)) })
        .eq("id", body.id)
        .select("*")
        .single()
      if (error) {
        console.error("アカデミー会員の更新エラー:", error.message)
        return NextResponse.json({ error: "更新に失敗しました" }, { status: 500 })
      }
      return NextResponse.json({ data })
    }

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

    /*
     * 交通費・宿泊費の枠（講座ごと30,000円）を数え直す。
     *
     * ■ なぜ必要か
     * 枠は「講座ごと」だが、講座マスタは同じ講座名を再受講でも使い回すため、
     * 数え直さないと1回目の受講で枠を使い切り、2回目以降の交通費が
     * 全額「上限超過・支給額0円」になってしまう。
     *
     * ■ 仕組み
     * 押した日時を記録し、それより後の申請だけを枠に数える。
     * 過去の明細は書き換えないので、確定済みの支給額は変わらない。
     */
    if (body.travelCapReset) {
      const courseId = body.travelCapReset.courseId
      if (!courseId) {
        return NextResponse.json({ error: "講座が指定されていません" }, { status: 400 })
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
      const existing = profile.travel_cap_resets ?? []

      let next: TravelCapReset[]
      if (body.travelCapReset.undo) {
        // いちばん新しい1件だけを取り消す（それ以前の数え直しは残す）
        const mine = existing.filter((r) => r.course_id === courseId).sort((a, b) => a.at.localeCompare(b.at))
        const latest = mine[mine.length - 1]
        if (!latest) {
          return NextResponse.json({ error: "数え直しの記録がありません" }, { status: 400 })
        }
        next = existing.filter((r) => !(r.course_id === courseId && r.at === latest.at))
      } else {
        // 記録用に、数え直す直前までに使っていた額を残す（判定には使わない）
        const used = await sumTravelCapUsed(service, body.id, courseId)
        next = [
          ...existing,
          {
            course_id: courseId,
            at: new Date().toISOString(),
            by: user.email ?? undefined,
            used_before: used,
          },
        ]
      }

      const { data, error } = await service
        .from("staff_members")
        .update({ line_profile: JSON.parse(JSON.stringify({ ...profile, travel_cap_resets: next })) })
        .eq("id", body.id)
        .select("*")
        .single()
      if (error) {
        console.error("枠の数え直しエラー:", error.message, error.code)
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
