"use client"

import { useCallback, useEffect, useState } from "react"
import type { Database } from "@/types/database"

type SettingsRow = Database["public"]["Tables"]["settings"]["Row"]

// 設定データ取得フック
export function useSettings() {
  const [settings, setSettings] = useState<SettingsRow[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings?table=settings")
      const json = await res.json() as { data?: SettingsRow[]; error?: string }
      if (json.error) throw new Error(json.error)
      setSettings(json.data ?? [])
    } catch {
      // 設定取得失敗時は空配列のまま
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  // キーで設定値を取得
  function getSettingValue<T>(key: string): T | null {
    const setting = settings.find((s) => s.key === key)
    return setting?.value as T | null
  }

  return { settings, isLoading, refetch: fetchSettings, getSettingValue }
}
