"use client"

import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import type { UserRole } from "@/lib/auth"

// ユーザー権限フック（UIの表示/非表示制御用）
export function useRole() {
  const [role, setRole] = useState<UserRole>("staff")
  const [isLoading, setIsLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    async function fetchRole() {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
          setIsLoading(false)
          return
        }

        const { data } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", user.id)
          .maybeSingle()

        setRole((data?.role as UserRole) || "staff")
      } catch {
        // エラー時はデフォルトのstaffを維持
      } finally {
        setIsLoading(false)
      }
    }

    fetchRole()
  }, [supabase])

  return {
    role,
    isLoading,
    isAdmin: role === "admin",
    canEdit: role === "admin" || role === "staff",
    canDelete: role === "admin",
  }
}
