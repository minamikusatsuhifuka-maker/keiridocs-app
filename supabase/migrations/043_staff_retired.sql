-- 043_staff_retired.sql
-- スタッフの「退職」を記録する列を追加する（論理削除）。
--
-- 背景：これまで退職者を外す手段が「削除」しかなかった。しかし
--   staff_receipts.staff_member_id   … ON DELETE CASCADE（領収書レコードが全件消える）
--   petty_cash_transactions.staff_member_id … ON DELETE SET NULL（支給取引の氏名が失われる）
-- のため、退職者を削除すると過去の申請記録と税理士提出リストの裏づけが消えてしまう。
-- 経理データは残さなければならないので、退職は削除ではなくフラグで表す。
--
-- 方針：
--   - retired_at に退職日時を入れる。NULL は在籍中。
--   - 退職者は /mkadmin の一覧から既定で隠す（「退職者も表示」で確認できる）。
--   - 退職者はLINEからの氏名照合の対象外にする（退職後に申請できない）。
--   - 過去の申請があるスタッフは削除できないようAPI側でブロックする。
--
-- ※ Supabase SQL Editor で手動実行する。実行直後は PostgREST のスキーマキャッシュ反映を待つこと。

ALTER TABLE staff_members
  ADD COLUMN IF NOT EXISTS retired_at timestamptz;

COMMENT ON COLUMN staff_members.retired_at IS
  '退職日時。NULL は在籍中。退職者は一覧から隠し、LINEからの申請も受け付けないが、過去の申請記録は保持する';

-- 在籍者の絞り込み用（一覧・氏名照合で毎回使う）
CREATE INDEX IF NOT EXISTS idx_staff_members_active
  ON staff_members (name)
  WHERE retired_at IS NULL;

NOTIFY pgrst, 'reload schema';
