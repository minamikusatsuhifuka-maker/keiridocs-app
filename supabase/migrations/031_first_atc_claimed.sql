-- 031_first_atc_claimed.sql
-- 「初回ATC＋アカデミー会員費」は1スタッフ1回限りの申請。
-- 申請完了（LINE確認画面でOK）したスタッフを記録し、以降LINEで初回ATCボタンを非表示にする。
-- 会計履歴（petty_cash_transactions）は書き換えず、この軽量フラグで状態管理する（訂正はフラグのトグル）。

ALTER TABLE staff_members
  ADD COLUMN IF NOT EXISTS first_atc_claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN staff_members.first_atc_claimed_at IS
  '初回ATC＋アカデミー会員費の申請完了日時。NULL=未申請。管理画面でクリア可（訂正用）';
