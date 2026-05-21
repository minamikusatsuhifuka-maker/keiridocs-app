// /staff-receipts は廃止。スタッフ領収書のアップロードは
// /petty-cash の「スタッフ返金」へ統合された。
// 過去データ参照用の /staff-receipts/admin へ転送する。

import { redirect } from "next/navigation"

export default function StaffReceiptsRedirect() {
  redirect("/staff-receipts/admin")
}
