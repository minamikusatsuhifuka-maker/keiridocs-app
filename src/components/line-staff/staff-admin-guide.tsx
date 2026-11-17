"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ArrowDown, UserPlus, UserMinus, Pencil, GraduationCap } from "lucide-react"

/**
 * スタッフ管理の入口案内。
 *
 * 入職・退職・氏名変更・既受講の登録が別々の場所にあると、
 * 「どこを触ればいいのか」が分からず確認もれにつながる。
 * このタブ1枚にまとめ、上部で操作と場所を対応づける。
 */

interface GuideItem {
  icon: typeof UserPlus
  when: string
  what: string
  where: string
}

const ITEMS: GuideItem[] = [
  {
    icon: UserPlus,
    when: "入職したとき",
    what: "スタッフを追加する",
    where: "下の「スタッフ一覧」の「スタッフを追加」。氏名はフルネームで入れてください。追加後、本人がLINEで初回設定（氏名・最寄り駅・通勤手段・定期券）を行います。",
  },
  {
    icon: UserMinus,
    when: "退職したとき",
    what: "在籍のスイッチを切る",
    where: "「スタッフ一覧」の各行の「在籍」スイッチをオフにします。削除はしません（過去の申請記録が消えるため）。退職後はLINEから申請できなくなります。",
  },
  {
    icon: Pencil,
    when: "氏名が変わったとき",
    what: "氏名を書き換える",
    where: "「スタッフ一覧」の各行の「編集」。院内で使うお名前と、給与や手続きに使うお名前を別々に登録できます。LINEの紐づけと過去の申請は変わりません。",
  },
  {
    icon: GraduationCap,
    when: "アプリを使う前に受講していたとき",
    what: "受講済み回数を登録する",
    where: "下の「既受講の登録」。登録しないと、既受講の方が「初受講＝全額支給」と判定され過大支給になります。",
  },
]

export function StaffAdminGuide() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">どこを触ればいいか</CardTitle>
        <CardDescription>
          スタッフに関する操作はこのタブにまとめています。該当する場面から探してください。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          {ITEMS.map((item) => {
            const Icon = item.icon
            return (
              <div
                key={item.when}
                className="rounded-lg border p-3"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="flex items-center gap-2">
                  <Icon className="size-4 shrink-0" style={{ color: "var(--dusk-primary)" }} />
                  <span className="text-sm font-semibold">{item.when}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5 text-sm">
                  <ArrowDown className="size-3.5 shrink-0" style={{ color: "var(--dusk-text-muted)" }} />
                  <span className="font-medium">{item.what}</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--dusk-text-muted)" }}>
                  {item.where}
                </p>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
