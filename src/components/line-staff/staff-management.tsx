"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Switch } from "@/components/ui/switch"
import {
  Users,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  MessageCircle,
  ArrowRight,
} from "lucide-react"
import { toast } from "sonner"

interface StaffMember {
  id: string
  name: string
  line_user_id: string | null
  created_at: string
  seminar_repeat_claimed_at?: string | null
}

/** セミナー2回目以降の申請日時を日本時間で表示（YYYY/MM/DD HH:mm） */
function formatClaimedAt(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ""
  return d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * LINEスタッフ管理のCRUD部分（パスワード認証なし）
 * - /line-staff ページと /mkadmin の「LINEスタッフ管理」タブの両方から再利用する
 * - 認証は呼び出し側（各ページ/管理画面）で行う
 *
 * @param showHeader 見出し・領収書管理リンクを表示するか（タブ内では false 推奨）
 */
export function StaffManagement({ showHeader = true }: { showHeader?: boolean }) {
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // 追加ダイアログ
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [newName, setNewName] = useState("")
  const [isAdding, setIsAdding] = useState(false)

  // 編集ダイアログ
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editingStaff, setEditingStaff] = useState<StaffMember | null>(null)
  const [editName, setEditName] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  // 削除中のID
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // セミナー2回目以降 ON/OFFトグル処理中のID
  const [togglingId, setTogglingId] = useState<string | null>(null)

  /* ---------- データ取得 ---------- */
  const fetchStaff = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch("/api/line-staff")
      if (!res.ok) throw new Error("取得失敗")
      const json = (await res.json()) as { data: StaffMember[] }
      setStaff(json.data ?? [])
    } catch {
      toast.error("スタッフ一覧の取得に失敗しました")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStaff()
  }, [fetchStaff])

  /* ---------- 追加 ---------- */
  async function handleAdd() {
    if (!newName.trim()) {
      toast.error("名前を入力してください")
      return
    }
    setIsAdding(true)
    try {
      const res = await fetch("/api/line-staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error || "追加に失敗しました")
      }
      toast.success("スタッフを追加しました")
      setNewName("")
      setAddDialogOpen(false)
      fetchStaff()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "追加に失敗しました")
    } finally {
      setIsAdding(false)
    }
  }

  /* ---------- 編集 ---------- */
  function openEditDialog(member: StaffMember) {
    setEditingStaff(member)
    setEditName(member.name)
    setEditDialogOpen(true)
  }

  async function handleEdit() {
    if (!editingStaff || !editName.trim()) {
      toast.error("名前を入力してください")
      return
    }
    setIsSaving(true)
    try {
      const res = await fetch("/api/line-staff", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingStaff.id, name: editName.trim() }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error || "更新に失敗しました")
      }
      toast.success("スタッフ名を更新しました")
      setEditDialogOpen(false)
      setEditingStaff(null)
      fetchStaff()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新に失敗しました")
    } finally {
      setIsSaving(false)
    }
  }

  /* ---------- セミナー2回目以降 ON/OFFトグル（手動切替・訂正用・会計履歴は無改変） ---------- */
  // ON→以降「初回ATC＋アカデミー会員費」を非表示 / OFF→初回ATCを再表示
  async function handleToggleSeminarRepeat(member: StaffMember, next: boolean) {
    // 申請済み→未申請（OFF）に戻すときのみ確認（誤操作防止）
    if (!next && !confirm(`「${member.name}」のセミナー2回目以降を未登録（OFF）に戻しますか？\n（初回ATCが再表示されます。会計履歴は変更されません）`)) {
      return
    }
    setTogglingId(member.id)
    try {
      const res = await fetch("/api/line-staff", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: member.id, seminar_repeat_claimed: next }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error || "操作に失敗しました")
      }
      toast.success(next ? "セミナー2回目以降を登録済（ON）にしました（初回ATC非表示）" : "セミナー2回目以降を未登録（OFF）に戻しました（初回ATC再表示）")
      fetchStaff()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作に失敗しました")
    } finally {
      setTogglingId(null)
    }
  }

  /* ---------- 削除 ---------- */
  async function handleDelete(id: string, name: string) {
    if (!confirm(`「${name}」を削除しますか？`)) return
    setDeletingId(id)
    try {
      const res = await fetch(`/api/line-staff?id=${id}`, { method: "DELETE" })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error || "削除に失敗しました")
      }
      toast.success("スタッフを削除しました")
      fetchStaff()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "削除に失敗しました")
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* 見出し + 操作ボタン */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {showHeader && (
            <>
              <div
                className="flex h-10 w-10 items-center justify-center rounded-xl text-white"
                style={{ background: "var(--dusk-accent-gradient)" }}
              >
                <Users className="h-5 w-5" />
              </div>
              <h1 className="text-2xl font-bold" style={{ color: "var(--dusk-text-main)" }}>
                LINEスタッフ管理
              </h1>
            </>
          )}
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/staff-receipts/admin">
              スタッフ領収書管理へ
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
          <Button
            className="btn-dusk-primary gap-2"
            onClick={() => setAddDialogOpen(true)}
          >
            <Plus className="h-4 w-4" />
            スタッフを追加
          </Button>
        </div>
      </div>

      {/* 説明カード */}
      <Card>
        <CardContent className="flex items-start gap-3 pt-5">
          <MessageCircle className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "var(--dusk-primary)" }} />
          <div className="text-sm" style={{ color: "var(--dusk-text-muted)" }}>
            <p>スタッフがLINEで名前を送ると自動登録されます。</p>
            <p>LINE未登録のスタッフにはリマインダーが届きません。</p>
          </div>
        </CardContent>
      </Card>

      {/* スタッフ一覧 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">スタッフ一覧</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--dusk-primary)" }} />
            </div>
          ) : staff.length === 0 ? (
            <div className="py-12 text-center" style={{ color: "var(--dusk-text-muted)" }}>
              <Users className="mx-auto mb-3 h-10 w-10 opacity-40" />
              <p>スタッフが登録されていません</p>
              <p className="mt-1 text-sm">「スタッフを追加」ボタンから登録してください</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名前</TableHead>
                    <TableHead>LINE登録状況</TableHead>
                    <TableHead>セミナー2回目以降</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {staff.map((member) => (
                    <TableRow key={member.id}>
                      <TableCell className="font-medium">{member.name}</TableCell>
                      <TableCell>
                        {member.line_user_id ? (
                          <span className="inline-flex items-center gap-1.5 text-sm text-green-600">
                            <CheckCircle2 className="h-4 w-4" />
                            登録済み
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-sm text-amber-600">
                            <AlertTriangle className="h-4 w-4" />
                            未登録
                          </span>
                        )}
                      </TableCell>
                      {/* セミナー2回目以降の登録状態。ON=初回ATC非表示 / OFF=初回ATC再表示。手動トグル可（訂正用） */}
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={!!member.seminar_repeat_claimed_at}
                              onCheckedChange={(checked) => handleToggleSeminarRepeat(member, checked)}
                              disabled={togglingId === member.id}
                              aria-label="セミナー2回目以降 登録済の切り替え"
                            />
                            <span
                              className="inline-flex items-center gap-1 text-sm font-medium"
                              style={{
                                color: member.seminar_repeat_claimed_at
                                  ? "var(--dusk-primary)"
                                  : "var(--dusk-text-muted)",
                              }}
                            >
                              {togglingId === member.id && <Loader2 className="h-3 w-3 animate-spin" />}
                              {member.seminar_repeat_claimed_at ? "登録済（初回ATC非表示）" : "未登録（初回ATC表示）"}
                            </span>
                          </div>
                          {member.seminar_repeat_claimed_at && (
                            <span className="text-xs" style={{ color: "var(--dusk-text-muted)" }}>
                              {formatClaimedAt(member.seminar_repeat_claimed_at)}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEditDialog(member)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => handleDelete(member.id, member.name)}
                            disabled={deletingId === member.id}
                          >
                            {deletingId === member.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 追加ダイアログ */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>スタッフを追加</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="new-name">名前</Label>
              <Input
                id="new-name"
                placeholder="例: 山田太郎"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isAdding) handleAdd()
                }}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setAddDialogOpen(false)
                  setNewName("")
                }}
              >
                キャンセル
              </Button>
              <Button
                className="btn-dusk-primary"
                onClick={handleAdd}
                disabled={isAdding || !newName.trim()}
              >
                {isAdding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                追加
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 編集ダイアログ */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>スタッフ名を編集</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="edit-name">名前</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isSaving) handleEdit()
                }}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setEditDialogOpen(false)
                  setEditingStaff(null)
                }}
              >
                キャンセル
              </Button>
              <Button
                className="btn-dusk-primary"
                onClick={handleEdit}
                disabled={isSaving || !editName.trim()}
              >
                {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                保存
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
