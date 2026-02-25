"use client"

import { useEffect, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"
import { ArrowLeft, Shield, Users } from "lucide-react"
import Link from "next/link"
import { useRole } from "@/hooks/use-role"

interface UserRoleRow {
  id: string
  user_id: string
  role: string
  display_name: string | null
  created_at: string
  updated_at: string
}

const ROLE_LABELS: Record<string, string> = {
  admin: "管理者",
  staff: "スタッフ",
  viewer: "閲覧者",
}

const ROLE_VARIANTS: Record<string, "default" | "secondary" | "outline"> = {
  admin: "default",
  staff: "secondary",
  viewer: "outline",
}

export default function UsersSettingsPage() {
  const router = useRouter()
  const { isAdmin, isLoading: roleLoading } = useRole()
  const [users, setUsers] = useState<UserRoleRow[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/users")
      if (!res.ok) {
        if (res.status === 403) {
          router.push("/settings")
          return
        }
        throw new Error("取得に失敗しました")
      }
      const data = await res.json() as { data: UserRoleRow[] }
      setUsers(data.data)
    } catch {
      toast.error("ユーザー一覧の取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }, [router])

  useEffect(() => {
    if (!roleLoading && !isAdmin) {
      router.push("/settings")
      return
    }
    if (!roleLoading && isAdmin) {
      fetchUsers()
    }
  }, [roleLoading, isAdmin, router, fetchUsers])

  // 権限変更
  async function handleRoleChange(userId: string, newRole: string) {
    try {
      const res = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, role: newRole }),
      })

      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(data.error || "権限変更に失敗しました")
      }

      toast.success("権限を変更しました")
      fetchUsers()
    } catch (error) {
      const message = error instanceof Error ? error.message : "権限変更に失敗しました"
      toast.error(message)
    }
  }

  if (roleLoading || (!isAdmin && isLoading)) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div className="flex items-center gap-4">
        <Link href="/settings">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="h-6 w-6" />
            ユーザー管理
          </h1>
          <p className="text-sm text-muted-foreground">
            ユーザーの権限を管理します（管理者専用）
          </p>
        </div>
      </div>

      {/* 権限の説明 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="h-4 w-4" />
            権限について
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 text-sm">
            <div className="flex items-center gap-2">
              <Badge variant="default">管理者</Badge>
              <span className="text-muted-foreground">全機能アクセス、設定変更、ユーザー管理、全書類の閲覧・編集・削除</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">スタッフ</Badge>
              <span className="text-muted-foreground">書類の登録・閲覧・編集（自分の書類のみ）、メール取込、分析閲覧</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">閲覧者</Badge>
              <span className="text-muted-foreground">書類の閲覧のみ（自分の書類のみ）、分析閲覧</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ユーザー一覧 */}
      <Card>
        <CardHeader>
          <CardTitle>ユーザー一覧</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : users.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              ユーザーがいません。Supabase Authでサインアップしたユーザーが表示されます。
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>表示名</TableHead>
                  <TableHead>ユーザーID</TableHead>
                  <TableHead>権限</TableHead>
                  <TableHead>登録日</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>{u.display_name || "（未設定）"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono">
                      {u.user_id.substring(0, 8)}...
                    </TableCell>
                    <TableCell>
                      <Badge variant={ROLE_VARIANTS[u.role] || "outline"}>
                        {ROLE_LABELS[u.role] || u.role}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(u.created_at).toLocaleDateString("ja-JP")}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={u.role}
                        onValueChange={(value) => handleRoleChange(u.user_id, value)}
                      >
                        <SelectTrigger className="w-[130px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">管理者</SelectItem>
                          <SelectItem value="staff">スタッフ</SelectItem>
                          <SelectItem value="viewer">閲覧者</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
