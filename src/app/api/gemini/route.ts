import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { analyzeDocument, applyAutoClassifyRules, DEFAULT_GEMINI_MODEL } from "@/lib/gemini"
import type { AutoClassifyRule } from "@/lib/gemini"

// Gemini AI解析 API
export async function POST(request: NextRequest) {
  // 認証チェック
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
  }

  try {
    const body = await request.json() as { base64: unknown; mimeType: unknown }

    const { base64, mimeType } = body

    if (typeof base64 !== "string" || typeof mimeType !== "string") {
      return NextResponse.json(
        { error: "base64とmimeTypeは必須です" },
        { status: 400 }
      )
    }

    // サポートされるMIMEタイプの検証
    const supportedTypes = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "application/pdf",
    ]
    if (!supportedTypes.includes(mimeType)) {
      return NextResponse.json(
        { error: "サポートされていないファイル形式です" },
        { status: 400 }
      )
    }

    // Base64サイズチェック（約10MB上限）
    const sizeInBytes = (base64.length * 3) / 4
    const maxSize = 10 * 1024 * 1024
    if (sizeInBytes > maxSize) {
      return NextResponse.json(
        { error: "ファイルサイズが10MBを超えています" },
        { status: 400 }
      )
    }

    // settingsからGeminiモデル設定を取得
    const { data: modelSetting } = await supabase
      .from("settings")
      .select("value")
      .eq("user_id", user.id)
      .eq("key", "gemini_model")
      .maybeSingle()

    const modelId = (typeof modelSetting?.value === "string" ? modelSetting.value : null) || DEFAULT_GEMINI_MODEL

    // settingsからdocument_typesを取得（種別判定に使う）
    const { data: docTypes } = await supabase
      .from("document_types")
      .select("name")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true })

    const documentTypes = docTypes?.map((t) => t.name)

    const result = await analyzeDocument(base64, mimeType, { modelId, documentTypes })

    // 自動仕分けルールを取得して適用（AIの判定より優先）
    const { data: classifyRules } = await supabase
      .from("auto_classify_rules")
      .select("keyword, document_type, priority, is_active")
      .eq("user_id", user.id)

    let finalResult = result
    if (classifyRules && classifyRules.length > 0) {
      const applied = applyAutoClassifyRules(result, classifyRules as AutoClassifyRule[])
      finalResult = { ...applied, model_used: result.model_used }
    }

    return NextResponse.json({
      data: finalResult,
      model_used: finalResult.model_used,
    })
  } catch (error) {
    console.error("Gemini API エラー:", error)
    return NextResponse.json(
      { error: "AI解析に失敗しました" },
      { status: 500 }
    )
  }
}
