import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { uploadFile } from "@/lib/dropbox"
import {
  createServiceClient,
  settleStaffReceipt,
  isSeminarRepeatClaimed,
  markSeminarRepeatClaimed,
} from "@/lib/staff-refund-core"
import { getExpenseDetail, STAFF_EXPENSE_DETAILS } from "@/lib/subsidy"
import { findContentDuplicate, findImageHashDuplicate } from "@/lib/staff-receipt-dedup"
import { parseAiRawObject } from "@/lib/staff-receipt-split"
import type { Json } from "@/types/database"

/**
 * スタッフ立替経費の手動登録（管理画面）。
 *
 * LINE申請と「同じデータ経路」に流すのが要点:
 *  - staff_receipts に登録し、既存の settleStaffReceipt で petty_cash_transactions（給与支給）に確定する。
 *  - 支給額は資料出力時に calcSubsidy（区分ベース）で計算される（LINEと完全に同一）。
 *  - 税理士提出リスト（スタッフ立替タブ）・会計士向け立替明細CSV・立替まとめに、LINE申請分と区別なく出る。
 *
 * 日付の対応:
 *  - 支払年月日 → staff_receipts.date ＋ ai_raw.issue_date（会計士CSVの「支払年月日」）
 *  - 提出日     → staff_receipts.created_at（税理士フォルダの20日締め月割り・立替まとめの申請日）
 */

/** 手動登録分を識別するためのタグ（一覧・編集・削除で対象を絞る） */
const MANUAL_TAG = "手動登録（管理画面）"

/** LINE申請と同じDropboxパス規約（提出日フォルダ）。テストスタッフはテストフォルダへ分離。 */
function getStaffReceiptPath(
  staffName: string,
  submitDate: string,
  originalFileName: string,
  isTest: boolean
): string {
  const safeName = staffName.replace(/[/\\:*?"<>|]/g, "_")
  const base = isTest ? "/経理書類/テスト" : "/経理書類/スタッフ領収書"
  return `${base}/${safeName}/${submitDate}/${originalFileName}`
}

/**
 * 提出日（YYYY-MM-DD）をJST正午の timestamptz 文字列に変換する。
 * こうすると税理士側の created_at.slice(0,10)（生ISO先頭）でも、
 * 会計士側の toJstDate（JST変換）でも、どちらも提出日と一致する（境界ずれ回避）。
 */
function submitDateToCreatedAt(submitDate: string): string {
  return `${submitDate}T12:00:00+09:00`
}

/** data URL プレフィックス（data:...;base64,）があれば除去 */
function stripDataUrl(base64: string): string {
  const comma = base64.indexOf(",")
  return comma >= 0 && comma < 100 ? base64.slice(comma + 1) : base64
}

/** 拡張子推定（MIMEから。既定は .jpg） */
function extFromMime(mimeType: string): string {
  if (mimeType === "application/pdf") return ".pdf"
  if (mimeType === "image/png") return ".png"
  return ".jpg"
}

/** 認証チェック（通常クライアント）。表示名も返す。 */
async function checkAuth() {
  const supabase = await createAuthClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

/* ========== 一覧取得（編集・削除UI用） ========== */
export async function GET() {
  const user = await checkAuth()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  try {
    const service = createServiceClient()
    // 手動登録タグ＋LINE申請分の取引を取得（立替のみ）。
    // LINE申請分（registered_by「{名前}（LINE）」）も一覧に含め、区分などを個別修正できるようにする
    // （1ファイル複数領収証の分割登録で区分が異なる場合の後修正用）。
    const { data: txRaw, error: txError } = await service
      .from("petty_cash_transactions")
      .select(
        "id, staff_member_id, amount, expense_detail, subsidy_category, staff_receipt_id, transaction_date, created_at, registered_by"
      )
      .eq("category", "staff_refund")
      .or(`registered_by.eq."${MANUAL_TAG}",registered_by.like."*（LINE）"`)
      .order("created_at", { ascending: false })
    if (txError) throw txError
    const txRows = (txRaw ?? []) as {
      id: string
      staff_member_id: string | null
      amount: number | null
      expense_detail: string | null
      subsidy_category: string | null
      staff_receipt_id: string | null
      transaction_date: string | null
      created_at: string
      registered_by: string | null
    }[]

    // 参照する領収書・スタッフをまとめて取得
    const receiptIds = Array.from(
      new Set(txRows.map((t) => t.staff_receipt_id).filter((v): v is string => !!v))
    )
    const receiptMap = new Map<
      string,
      { store_name: string | null; date: string | null; created_at: string; dropbox_path: string | null; ai_raw: unknown }
    >()
    if (receiptIds.length > 0) {
      const { data: receipts } = await service
        .from("staff_receipts")
        .select("id, store_name, date, created_at, dropbox_path, ai_raw")
        .in("id", receiptIds)
      for (const r of (receipts ?? []) as {
        id: string
        store_name: string | null
        date: string | null
        created_at: string
        dropbox_path: string | null
        ai_raw: unknown
      }[]) {
        receiptMap.set(r.id, r)
      }
    }

    const { data: staffRaw } = await service.from("staff_members").select("id, name, is_test")
    const staffMap = new Map<string, { name: string; is_test: boolean }>()
    for (const s of (staffRaw ?? []) as { id: string; name: string; is_test?: boolean | null }[]) {
      staffMap.set(s.id, { name: s.name, is_test: !!s.is_test })
    }

    const rows = txRows.map((t) => {
      const r = t.staff_receipt_id ? receiptMap.get(t.staff_receipt_id) : undefined
      const staff = t.staff_member_id ? staffMap.get(t.staff_member_id) : undefined
      const aiRaw = parseAiRawObject(r?.ai_raw) ?? {}
      const submitDate = jstDate(r?.created_at) || (t.created_at ? jstDate(t.created_at) : "")
      // 区分キー: ai_raw.detail_key を優先し、無ければ expense_detail のフル名称から逆引き
      // （LINE申請分は detail_key を持たないため。編集ダイアログのプリフィルに使う）
      const detailKey =
        typeof aiRaw.detail_key === "string" && aiRaw.detail_key
          ? aiRaw.detail_key
          : STAFF_EXPENSE_DETAILS.find((d) => d.fullLabel === (t.expense_detail ?? ""))?.key ?? ""
      return {
        receiptId: t.staff_receipt_id,
        transactionId: t.id,
        staffMemberId: t.staff_member_id,
        staffName: staff?.name ?? "不明",
        isTest: staff?.is_test ?? false,
        storeName: r?.store_name ?? "",
        amount: typeof t.amount === "number" ? t.amount : 0,
        paymentDate: (r?.date ?? "").slice(0, 10),
        submitDate,
        detailKey,
        expenseDetail: t.expense_detail ?? "",
        subsidyCategory: t.subsidy_category ?? "other",
        note: typeof aiRaw.note === "string" ? aiRaw.note : "",
        hasFile: !!(r?.dropbox_path && r.dropbox_path.trim() !== ""),
        // 登録元（manual=手動登録 / line=LINE申請）
        source: t.registered_by === MANUAL_TAG ? "manual" : "line",
      }
    })

    return NextResponse.json({ data: rows })
  } catch (error) {
    console.error("[manual-entry] 一覧取得エラー:", error)
    return NextResponse.json({ error: "手動登録分の取得に失敗しました" }, { status: 500 })
  }
}

/** ISO日時をJSTの YYYY-MM-DD に変換 */
function jstDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ""
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
}

/* ========== 新規登録 ========== */
export async function POST(request: NextRequest) {
  const user = await checkAuth()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  try {
    const body = (await request.json()) as {
      staffMemberId?: string
      storeName?: string
      amount?: number
      paymentDate?: string
      detailKey?: string
      submitDate?: string
      note?: string
      file?: { base64?: string; mimeType?: string; fileName?: string } | null
      force?: boolean
    }

    const staffMemberId = body.staffMemberId?.trim()
    const storeName = body.storeName?.trim() || null
    const amount = typeof body.amount === "number" ? Math.round(body.amount) : NaN
    const paymentDate = (body.paymentDate || "").slice(0, 10)
    const submitDate = (body.submitDate || jstDate(new Date().toISOString())).slice(0, 10)
    const note = body.note?.trim() || null
    const detail = getExpenseDetail(body.detailKey)

    if (!staffMemberId) return NextResponse.json({ error: "対象スタッフは必須です" }, { status: 400 })
    if (!detail) return NextResponse.json({ error: "費用区分が不正です" }, { status: 400 })
    if (!Number.isFinite(amount) || amount <= 0)
      return NextResponse.json({ error: "金額を正しく入力してください" }, { status: 400 })
    if (!paymentDate) return NextResponse.json({ error: "支払年月日は必須です" }, { status: 400 })

    const service = createServiceClient()

    // スタッフ確認（is_test・名前）
    const { data: staffRow, error: staffError } = await service
      .from("staff_members")
      .select("id, name, is_test")
      .eq("id", staffMemberId)
      .single()
    if (staffError || !staffRow) {
      return NextResponse.json({ error: "対象スタッフが見つかりません" }, { status: 404 })
    }
    const staff = staffRow as { id: string; name: string; is_test?: boolean | null }
    const isTest = !!staff.is_test

    // 初回ATC制御: セミナー2回目以降を登録済みなら「初回ATC」は選べない（LINEと同一）
    if (detail.key === "ach_first" && (await isSeminarRepeatClaimed(service, staffMemberId))) {
      return NextResponse.json(
        {
          error:
            "このスタッフは既に「セミナー2回目以降」を登録済みのため、「初回ATC＋アカデミー会員費」は選べません。",
          code: "ach_first_blocked",
        },
        { status: 409 }
      )
    }

    // 重複検知（同一スタッフ・支払先＋金額＋支払年月日）。force で強制登録可
    if (!body.force) {
      const dup = await findContentDuplicate(service, {
        staffMemberId,
        storeName,
        amount,
        date: paymentDate,
      })
      if (dup) {
        return NextResponse.json(
          {
            error: "同じ内容（支払先＋金額＋日付）の立替が既に登録されています。",
            code: "duplicate",
            duplicate: { store_name: dup.store_name, amount: dup.amount, date: dup.date },
          },
          { status: 409 }
        )
      }
    }

    // ファイルがあればDropboxへ保存＋画像ハッシュ算出。無ければ空パス（領収書なし交通費等と同じ扱い）
    let dropboxPath = ""
    let imageHash: string | null = null
    let fileName = `${staff.name}_手動_${Date.now().toString().slice(-6)}`
    if (body.file?.base64 && body.file?.mimeType) {
      const base64Data = stripDataUrl(body.file.base64)
      const buffer = Buffer.from(base64Data, "base64")
      if (buffer.length === 0) {
        return NextResponse.json({ error: "ファイルデータが空です" }, { status: 400 })
      }
      imageHash = crypto.createHash("sha256").update(buffer).digest("hex")
      // 画像ハッシュ重複（全スタッフ照合）。force で強制登録可
      if (!body.force) {
        const imgDup = await findImageHashDuplicate(service, imageHash)
        if (imgDup) {
          return NextResponse.json(
            {
              error: "同じ画像の領収書が既に登録されています。",
              code: "duplicate",
              duplicate: { store_name: imgDup.store_name, amount: imgDup.amount, date: imgDup.date },
            },
            { status: 409 }
          )
        }
      }
      const ext = extFromMime(body.file.mimeType)
      fileName = `${staff.name}_手動_${Date.now().toString().slice(-6)}${ext}`
      const path = getStaffReceiptPath(staff.name, submitDate, fileName, isTest)
      dropboxPath = await uploadFile(path, buffer)
    }

    // staff_receipts 作成（created_at＝提出日／date＝支払年月日／ai_raw.issue_date＝支払年月日）
    const aiRaw = {
      source: "manual_admin",
      issue_date: paymentDate, // 会計士CSVの「支払年月日」に使われる
      detail_key: detail.key, // 編集時の区分プリフィル用
      note: note ?? "",
      store_name: storeName,
    } as unknown as Json

    const baseReceipt = {
      staff_member_id: staffMemberId,
      file_name: fileName,
      dropbox_path: dropboxPath, // 領収書なしは空文字（NOT NULL回避）
      document_type: detail.fullLabel,
      date: paymentDate,
      amount,
      store_name: storeName,
      tax_category: null,
      account_title: null,
      ai_raw: aiRaw,
      created_at: submitDateToCreatedAt(submitDate), // 提出日＝税理士20日締め・立替まとめの申請日
    }

    // image_hash は migration 030 で追加。未適用環境でもフォールバックで保存を止めない
    let receiptId: string | null = null
    const withHash = await service
      .from("staff_receipts")
      .insert(imageHash ? { ...baseReceipt, image_hash: imageHash } : baseReceipt)
      .select("id")
      .single()
    if (withHash.error) {
      const e = withHash.error
      const isMissingColumn =
        e.code === "PGRST204" || e.code === "42703" || /image_hash/.test(e.message || "")
      if (imageHash && isMissingColumn) {
        console.warn("[manual-entry] image_hash 未適用のためハッシュなしで保存（migration 030未実行）")
        const noHash = await service.from("staff_receipts").insert(baseReceipt).select("id").single()
        if (noHash.error) throw noHash.error
        receiptId = (noHash.data as { id: string }).id
      } else {
        throw e
      }
    } else {
      receiptId = (withHash.data as { id: string }).id
    }
    if (!receiptId) {
      return NextResponse.json({ error: "領収書の保存に失敗しました" }, { status: 500 })
    }

    // 給与支給で精算確定（区分＝detail.subsidyCategory・詳細＝detail.fullLabel）。LINEと同一経路
    const result = await settleStaffReceipt({
      staffReceiptId: receiptId,
      settlementMethod: "payroll",
      subsidyCategory: detail.subsidyCategory,
      expenseDetail: detail.fullLabel,
      registeredBy: MANUAL_TAG,
      client: service,
    })
    if (result.status !== "ok") {
      // 精算に失敗したら作成した領収書を巻き戻す（孤児を残さない）
      await service.from("staff_receipts").delete().eq("id", receiptId)
      return NextResponse.json(
        { error: `精算確定に失敗しました（${result.status}）` },
        { status: 500 }
      )
    }

    // 「セミナー2回目以降」（弁当代含む）を登録したらフラグをセット（LINEと同一）
    if (detail.key === "ach_repeat" || detail.key === "bento") {
      await markSeminarRepeatClaimed(service, staffMemberId)
    }

    return NextResponse.json({ ok: true, receiptId })
  } catch (error) {
    console.error("[manual-entry] 登録エラー:", error)
    return NextResponse.json({ error: "手動登録に失敗しました" }, { status: 500 })
  }
}

/* ========== 編集（金額・区分・支払先・提出日・支払年月日・摘要） ========== */
export async function PATCH(request: NextRequest) {
  const user = await checkAuth()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  try {
    const body = (await request.json()) as {
      receiptId?: string
      storeName?: string
      amount?: number
      paymentDate?: string
      detailKey?: string
      submitDate?: string
      note?: string
    }
    const receiptId = body.receiptId?.trim()
    if (!receiptId) return NextResponse.json({ error: "receiptId は必須です" }, { status: 400 })

    const service = createServiceClient()

    // 対象領収書＋精算取引を取得（手動登録分のみ許可）
    const { data: receiptRaw, error: receiptError } = await service
      .from("staff_receipts")
      .select("id, staff_member_id, store_name, amount, date, ai_raw, staff_members!inner(name)")
      .eq("id", receiptId)
      .single()
    if (receiptError || !receiptRaw) {
      return NextResponse.json({ error: "対象が見つかりません" }, { status: 404 })
    }
    const receipt = receiptRaw as Record<string, unknown> & { staff_members: { name: string } }
    const staffMemberId = receipt.staff_member_id as string
    const staffName = receipt.staff_members.name
    const prevAiRaw =
      receipt.ai_raw && typeof receipt.ai_raw === "object"
        ? (receipt.ai_raw as Record<string, unknown>)
        : {}

    const { data: txRaw } = await service
      .from("petty_cash_transactions")
      .select("id")
      .eq("staff_receipt_id", receiptId)
      .eq("category", "staff_refund")
      .limit(1)
    const txRow = (txRaw ?? [])[0] as { id: string } | undefined

    // 更新値（未指定は現状維持）
    const storeName =
      body.storeName !== undefined ? body.storeName.trim() || null : (receipt.store_name as string | null)
    const amount =
      body.amount !== undefined && Number.isFinite(body.amount)
        ? Math.round(body.amount as number)
        : (receipt.amount as number)
    const paymentDate =
      body.paymentDate !== undefined ? body.paymentDate.slice(0, 10) : ((receipt.date as string | null) || "").slice(0, 10)
    const detail = body.detailKey !== undefined ? getExpenseDetail(body.detailKey) : undefined
    const note = body.note !== undefined ? body.note.trim() : (prevAiRaw.note as string | undefined)

    if (body.amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
      return NextResponse.json({ error: "金額を正しく入力してください" }, { status: 400 })
    }
    if (body.detailKey !== undefined && !detail) {
      return NextResponse.json({ error: "費用区分が不正です" }, { status: 400 })
    }
    // 初回ATCへの変更はセミナー2回目登録済みだと不可（LINEと同一）
    if (detail?.key === "ach_first" && (await isSeminarRepeatClaimed(service, staffMemberId))) {
      return NextResponse.json(
        {
          error:
            "このスタッフは既に「セミナー2回目以降」を登録済みのため、「初回ATC＋アカデミー会員費」は選べません。",
          code: "ach_first_blocked",
        },
        { status: 409 }
      )
    }

    // staff_receipts 更新
    const newAiRaw = {
      ...prevAiRaw,
      issue_date: paymentDate,
      note: note ?? "",
      store_name: storeName,
      ...(detail ? { detail_key: detail.key } : {}),
    } as unknown as Json
    const receiptUpdate: Record<string, unknown> = {
      store_name: storeName,
      amount,
      date: paymentDate,
      ai_raw: newAiRaw,
    }
    if (detail) receiptUpdate.document_type = detail.fullLabel
    if (body.submitDate !== undefined) {
      receiptUpdate.created_at = submitDateToCreatedAt(body.submitDate.slice(0, 10))
    }
    const { error: updReceiptError } = await service
      .from("staff_receipts")
      .update(receiptUpdate)
      .eq("id", receiptId)
    if (updReceiptError) throw updReceiptError

    // petty_cash_transactions 更新（支給額は出力時に calcSubsidy で再計算されるので区分＋金額を更新すれば足りる）
    if (txRow) {
      const txUpdate: Record<string, unknown> = {
        amount,
        transaction_date: paymentDate,
        description: `${staffName}/${storeName || "不明"}`,
        note: `${staffName}/${storeName || "不明"}`,
      }
      if (detail) {
        txUpdate.subsidy_category = detail.subsidyCategory
        txUpdate.expense_detail = detail.fullLabel
      }
      const { error: updTxError } = await service
        .from("petty_cash_transactions")
        .update(txUpdate)
        .eq("id", txRow.id)
      if (updTxError) throw updTxError
    }

    // セミナー2回目以降（弁当代含む）に変更したらフラグをセット（LINEと同一・非破壊）
    if (detail && (detail.key === "ach_repeat" || detail.key === "bento")) {
      await markSeminarRepeatClaimed(service, staffMemberId)
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[manual-entry] 編集エラー:", error)
    return NextResponse.json({ error: "編集に失敗しました" }, { status: 500 })
  }
}

/* ========== 削除 ========== */
export async function DELETE(request: NextRequest) {
  const user = await checkAuth()
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 })

  try {
    const { searchParams } = new URL(request.url)
    const receiptId = searchParams.get("receiptId")
    if (!receiptId) return NextResponse.json({ error: "receiptId は必須です" }, { status: 400 })

    const service = createServiceClient()

    // 精算取引を先に削除（FKは ON DELETE SET NULL のため、先に領収書を消すと取引が孤児化して出力に残る）
    // 手動登録分は給与支給（payroll）で小口残高を動かさないため、残高の巻き戻しは不要。
    const { error: delTxError } = await service
      .from("petty_cash_transactions")
      .delete()
      .eq("staff_receipt_id", receiptId)
      .eq("category", "staff_refund")
    if (delTxError) throw delTxError

    const { error: delReceiptError } = await service
      .from("staff_receipts")
      .delete()
      .eq("id", receiptId)
    if (delReceiptError) throw delReceiptError

    // Dropbox上の実ファイルは既存のLINE削除と同じく残置する（会計履歴の証憑保全）。
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[manual-entry] 削除エラー:", error)
    return NextResponse.json({ error: "削除に失敗しました" }, { status: 500 })
  }
}
