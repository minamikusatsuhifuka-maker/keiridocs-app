import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { uploadFile } from "@/lib/dropbox"
import { getExpenseDetail, calcSubsidy } from "@/lib/subsidy"
import {
  createServiceClient,
  settleStaffReceipt,
  isSeminarRepeatClaimed,
  markSeminarRepeatClaimed,
  type SettlementMethod,
} from "@/lib/staff-refund-core"
import { findImageHashDuplicate } from "@/lib/staff-receipt-dedup"
import type { Json } from "@/types/database"

/**
 * POST /api/petty-cash/staff-refund/approve
 *
 * スタッフ返金（資料アップロード）の承認確定。
 * 解析結果テーブルの「支払い1件＝1行」を、行ごとに staff_receipts ＋ settleStaffReceipt で
 * 別レコードとして登録する（LINE申請・手動登録と同一のデータ経路・同一の支給額ロジック）。
 *
 * multipart/form-data:
 *  - files: File[]                  … 領収書ファイル（analyze で見たもの）
 *  - staff_member_id: string
 *  - transaction_date: string       … 提出日（YYYY-MM-DD。staff_receipts.created_at＝税理士20日締めに使用）
 *  - settlement_method: string      … petty_cash / payroll / storage_only
 *  - rows: string(JSON)             … [{ fileIndex, store, amount, date, detailKey }]
 *      date は支払年月日（その領収証自身の領収日）→ staff_receipts.date / ai_raw.issue_date
 *  - force: "1"                     … 二重承認ガードの警告を承知のうえで登録する
 *
 * 二重承認ガード:
 *  アップロードされたファイルのSHA-256が既存 staff_receipts と一致する場合は 409 を返して
 *  登録を止める（同じ資料を二度承認してしまう事故を防ぐ）。同一リクエスト内で1ファイルを
 *  複数行に分ける「分割兄弟」は同じファイルを共有するのが正しい姿なので対象外。
 *  意図した再登録は force=1 で通せる。
 *
 * 1ファイルから複数行が登録される場合（複数領収証の分割）は、全行が同一ファイル
 * （同一 dropbox_path）を共有し、ai_raw.split_group でグループ化する。
 *
 * 原子性: staff_receipts は一括INSERT（1ステートメント）で先に作成し、精算確定が途中で
 * 失敗した場合は 作成済みの取引・残高・領収書をすべて巻き戻す（部分登録状態を残さない）。
 */

/** 承認1行分（クライアントから受け取る形） */
interface ApproveRow {
  fileIndex: number
  store: string
  amount: number
  date: string
  detailKey: string
  note?: string
}

/** LINE申請・手動登録と同じDropboxパス規約（提出日フォルダ）。テストスタッフはテストフォルダへ分離。 */
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
 * 提出日（YYYY-MM-DD）をJST正午の timestamptz 文字列に変換する（手動登録と同一）。
 * 税理士側の created_at.slice(0,10) と会計士側の toJstDate のどちらでも提出日と一致する。
 */
function submitDateToCreatedAt(submitDate: string): string {
  return `${submitDate}T12:00:00+09:00`
}

export async function POST(req: NextRequest) {
  const authSupabase = await createAuthClient()
  const { data: { user }, error: authError } = await authSupabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const formData = await req.formData()
    const files = formData.getAll("files") as File[]
    const staffMemberId = formData.get("staff_member_id") as string
    const transactionDate =
      (formData.get("transaction_date") as string) || new Date().toISOString().slice(0, 10)
    // 二重承認ガードを承知のうえで登録する場合のみ true
    const force = formData.get("force") === "1"
    const rawSettlement = formData.get("settlement_method") as string | null
    const settlementMethod: SettlementMethod =
      rawSettlement === "payroll" || rawSettlement === "storage_only"
        ? rawSettlement
        : "petty_cash"

    // 行データ（支払い1件＝1行）
    let rows: ApproveRow[] = []
    try {
      const parsed = JSON.parse((formData.get("rows") as string) || "[]")
      if (Array.isArray(parsed)) rows = parsed as ApproveRow[]
    } catch {
      return NextResponse.json({ error: "行データ（rows）が不正です" }, { status: 400 })
    }

    if (!staffMemberId) {
      return NextResponse.json({ error: "スタッフが選択されていません" }, { status: 400 })
    }
    if (!files || files.length === 0) {
      return NextResponse.json({ error: "領収書ファイルがありません" }, { status: 400 })
    }
    if (rows.length === 0) {
      return NextResponse.json({ error: "登録する行がありません" }, { status: 400 })
    }

    // 行のバリデーション
    for (const [i, row] of rows.entries()) {
      if (!Number.isInteger(row.fileIndex) || row.fileIndex < 0 || row.fileIndex >= files.length) {
        return NextResponse.json({ error: `行${i + 1}: 対応するファイルが見つかりません` }, { status: 400 })
      }
      if (!Number.isFinite(row.amount) || row.amount <= 0) {
        return NextResponse.json({ error: `行${i + 1}: 金額を正しく入力してください` }, { status: 400 })
      }
      if (!row.date || !/^\d{4}-\d{2}-\d{2}$/.test(row.date.slice(0, 10))) {
        return NextResponse.json({ error: `行${i + 1}: 支払年月日を入力してください` }, { status: 400 })
      }
      if (!getExpenseDetail(row.detailKey)) {
        return NextResponse.json({ error: `行${i + 1}: 費用区分を選択してください` }, { status: 400 })
      }
    }

    // 登録者名（表示名）
    const { data: roleData } = await authSupabase
      .from("user_roles")
      .select("display_name")
      .eq("user_id", user.id)
      .maybeSingle()
    const registeredBy =
      (roleData?.display_name as string) ||
      (user.user_metadata?.full_name as string) ||
      user.email ||
      "不明"

    const service = createServiceClient()

    // スタッフ確認（is_test・名前）
    const { data: staffRow } = await service
      .from("staff_members")
      .select("id, name, is_test")
      .eq("id", staffMemberId)
      .single()
    if (!staffRow) {
      return NextResponse.json({ error: "対象スタッフが存在しません" }, { status: 404 })
    }
    const staff = staffRow as unknown as { id: string; name: string; is_test?: boolean | null }
    const isTest = !!staff.is_test

    // 初回ATC制御: セミナー2回目以降を登録済みなら「初回ATC」は選べない（LINE・手動登録と同一）
    if (
      rows.some((r) => r.detailKey === "ach_first") &&
      (await isSeminarRepeatClaimed(service, staffMemberId))
    ) {
      return NextResponse.json(
        {
          error:
            "このスタッフは既に「セミナー2回目以降」を登録済みのため、「初回ATC＋アカデミー会員費」は選べません。",
          code: "ach_first_blocked",
        },
        { status: 409 }
      )
    }

    const submitDate = transactionDate.slice(0, 10)

    // 行から参照されているファイルのみ・1ファイル1回だけ読み込んでハッシュを計算する
    const usedFileIndexes = Array.from(new Set(rows.map((r) => r.fileIndex))).sort((a, b) => a - b)
    const prepared: { idx: number; buffer: Buffer; imageHash: string; originalName: string }[] = []
    for (const idx of usedFileIndexes) {
      const file = files[idx]
      const buffer = Buffer.from(await file.arrayBuffer())
      if (buffer.length === 0) {
        return NextResponse.json({ error: `ファイル「${file.name}」のデータが空です` }, { status: 400 })
      }
      prepared.push({
        idx,
        buffer,
        imageHash: crypto.createHash("sha256").update(buffer).digest("hex"),
        originalName: file.name,
      })
    }

    // 二重承認ガード: 同じファイル（SHA-256一致）が既に登録済みなら止める。
    // アップロード前に判定するため、警告時はDropboxにも何も残らない。
    // 分割兄弟は同一リクエスト内で1ファイルを共有するだけなので、この判定には掛からない
    // （既存DBとの照合であり、リクエスト内の行同士は比較しない）。
    if (!force) {
      for (const p of prepared) {
        const dup = await findImageHashDuplicate(service, p.imageHash)
        if (dup) {
          return NextResponse.json(
            {
              error:
                `ファイル「${p.originalName}」は既に登録済みです` +
                `（${dup.store_name || "店名不明"}／${dup.amount != null ? `¥${dup.amount.toLocaleString("ja-JP")}` : "金額不明"}` +
                `／登録日 ${dup.created_at.slice(0, 10)}）。` +
                `同じ資料を二重に承認しようとしています。それでも登録する場合は「重複を承知で登録」を選んでください。`,
              code: "duplicate_file",
              duplicate: {
                fileName: p.originalName,
                storeName: dup.store_name,
                amount: dup.amount,
                date: dup.date,
                createdAt: dup.created_at,
              },
            },
            { status: 409 }
          )
        }
      }
    }

    // 各ファイルをDropboxへアップロード
    const uploadedByIndex = new Map<number, { path: string; fileName: string; imageHash: string }>()
    for (const p of prepared) {
      const safeName = p.originalName.replace(/[/\\:*?"<>|]/g, "_")
      const fileName = `${Date.now()}_${p.idx}_${safeName}`
      const path = getStaffReceiptPath(staff.name, submitDate, fileName, isTest)
      const uploaded = await uploadFile(path, p.buffer)
      uploadedByIndex.set(p.idx, { path: uploaded, fileName, imageHash: p.imageHash })
    }

    // ファイルごとの行数（2行以上のファイルは分割グループとして ai_raw に記録する）
    const rowCountByFile = new Map<number, number>()
    for (const r of rows) {
      rowCountByFile.set(r.fileIndex, (rowCountByFile.get(r.fileIndex) ?? 0) + 1)
    }
    const splitGroupByFile = new Map<number, string>()
    for (const [idx, count] of rowCountByFile) {
      if (count >= 2) splitGroupByFile.set(idx, crypto.randomUUID())
    }
    const splitIndexCounter = new Map<number, number>()

    // staff_receipts の行を組み立て（一括INSERTで原子的に作成する）
    const receiptRows = rows.map((row) => {
      const uploaded = uploadedByIndex.get(row.fileIndex)!
      const detail = getExpenseDetail(row.detailKey)!
      const paymentDate = row.date.slice(0, 10)
      const storeName = row.store.trim() || null
      const splitGroup = splitGroupByFile.get(row.fileIndex)
      const splitIndex = (splitIndexCounter.get(row.fileIndex) ?? 0) + 1
      splitIndexCounter.set(row.fileIndex, splitIndex)

      const aiRaw = {
        source: "admin_upload",
        issue_date: paymentDate, // 会計士CSVの「支払年月日」に使われる
        detail_key: detail.key, // 編集時の区分プリフィル用
        note: row.note?.trim() || "",
        store_name: storeName,
        ...(splitGroup
          ? {
              split_group: splitGroup,
              split_index: splitIndex,
              split_total: rowCountByFile.get(row.fileIndex) ?? 1,
            }
          : {}),
      } as unknown as Json

      return {
        staff_member_id: staffMemberId,
        file_name: uploaded.fileName,
        dropbox_path: uploaded.path, // 分割行は同一ファイルを共有（コピーしない）
        document_type: detail.fullLabel,
        date: paymentDate,
        amount: Math.round(row.amount),
        store_name: storeName,
        tax_category: null,
        account_title: null,
        ai_raw: aiRaw,
        created_at: submitDateToCreatedAt(submitDate),
        image_hash: uploaded.imageHash,
      }
    })

    // 一括INSERT（1ステートメント＝原子的）。image_hash 未適用環境ではフォールバック
    let insertedIds: string[] = []
    const withHash = await service.from("staff_receipts").insert(receiptRows).select("id")
    if (withHash.error) {
      const e = withHash.error
      const isMissingColumn =
        e.code === "PGRST204" || e.code === "42703" || /image_hash/.test(e.message || "")
      if (isMissingColumn) {
        console.warn("[staff-refund/approve] image_hash 未適用のためハッシュなしで保存（migration 030未実行）")
        const noHash = await service
          .from("staff_receipts")
          .insert(receiptRows.map(({ image_hash: _ignored, ...rest }) => rest))
          .select("id")
        if (noHash.error) throw noHash.error
        insertedIds = ((noHash.data ?? []) as { id: string }[]).map((r) => r.id)
      } else {
        throw e
      }
    } else {
      insertedIds = ((withHash.data ?? []) as { id: string }[]).map((r) => r.id)
    }
    if (insertedIds.length !== rows.length) {
      throw new Error("領収書レコードの作成件数が一致しません")
    }

    // 行ごとに精算確定（LINE・手動登録と同一の settleStaffReceipt）。
    // 途中で失敗したら、この処理で作成した取引・残高・領収書をすべて巻き戻す。
    const settled: { receiptId: string; amount: number }[] = []
    try {
      for (const [i, row] of rows.entries()) {
        const detail = getExpenseDetail(row.detailKey)!
        const result = await settleStaffReceipt({
          staffReceiptId: insertedIds[i],
          settlementMethod,
          subsidyCategory: detail.subsidyCategory,
          expenseDetail: detail.fullLabel,
          registeredBy,
          client: service,
        })
        if (result.status !== "ok") {
          throw new Error(`精算確定に失敗しました（${result.status}）`)
        }
        settled.push({ receiptId: insertedIds[i], amount: Math.round(row.amount) })
      }
    } catch (settleError) {
      // ロールバック: 取引削除 → 残高復元（小口のみ） → 領収書削除
      console.error("[staff-refund/approve] 精算失敗。ロールバックします:", settleError)
      try {
        if (settled.length > 0) {
          await service
            .from("petty_cash_transactions")
            .delete()
            .in("staff_receipt_id", settled.map((s) => s.receiptId))
            .eq("category", "staff_refund")
          if (settlementMethod === "petty_cash") {
            const refund = settled.reduce((sum, s) => sum + s.amount, 0)
            const { data: settingsRaw } = await service
              .from("petty_cash_settings")
              .select("*")
              .limit(1)
              .single()
            const settings = settingsRaw as unknown as { id: string; balance: number } | null
            if (settings) {
              await service
                .from("petty_cash_settings")
                .update({ balance: (settings.balance ?? 0) + refund, updated_at: new Date().toISOString() })
                .eq("id", settings.id)
            }
          }
        }
        await service.from("staff_receipts").delete().in("id", insertedIds)
      } catch (rollbackError) {
        console.error("[staff-refund/approve] ロールバック中にエラー:", rollbackError)
      }
      const msg = settleError instanceof Error ? settleError.message : "精算確定に失敗しました"
      return NextResponse.json(
        { error: `${msg}（登録はすべて取り消しました。もう一度お試しください）` },
        { status: 500 }
      )
    }

    // 「セミナー2回目以降」（弁当代含む）を登録したらフラグをセット（LINE・手動登録と同一）
    if (rows.some((r) => r.detailKey === "ach_repeat" || r.detailKey === "bento")) {
      await markSeminarRepeatClaimed(service, staffMemberId)
    }

    const totalAmount = rows.reduce((sum, r) => sum + Math.round(r.amount), 0)
    const totalSubsidy = rows.reduce(
      (sum, r) => sum + calcSubsidy(Math.round(r.amount), getExpenseDetail(r.detailKey)!.subsidyCategory),
      0
    )

    return NextResponse.json({
      success: true,
      count: rows.length,
      totalAmount,
      totalSubsidy,
      receiptIds: insertedIds,
    })
  } catch (e: unknown) {
    console.error("[staff-refund/approve]", e)
    const msg = e instanceof Error ? e.message : "unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
