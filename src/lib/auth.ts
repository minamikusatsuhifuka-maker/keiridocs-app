// ユーザー権限管理ユーティリティ
import { createClient } from "@/lib/supabase/server"

/** ユーザーの権限種別 */
export type UserRole = "admin" | "staff" | "viewer"

/**
 * ログインユーザーの権限を取得する
 * user_rolesにレコードがなければ 'staff' を返す
 */
export async function getCurrentUserRole(): Promise<{ role: UserRole; userId: string } | null> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return null
  }

  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle()

  const role = (data?.role as UserRole) || "staff"

  return { role, userId: user.id }
}

/** admin権限かどうか */
export async function isAdmin(): Promise<boolean> {
  const result = await getCurrentUserRole()
  return result?.role === "admin"
}

/** 編集可能（admin or staff）かどうか */
export async function canEdit(): Promise<boolean> {
  const result = await getCurrentUserRole()
  return result?.role === "admin" || result?.role === "staff"
}

/** 削除可能（adminのみ）かどうか */
export async function canDelete(): Promise<boolean> {
  const result = await getCurrentUserRole()
  return result?.role === "admin"
}
