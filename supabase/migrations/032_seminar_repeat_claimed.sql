-- 032_seminar_repeat_claimed.sql
-- 「初回ATC＋アカデミー会員費」の表示制御を、申請件数ベースから「セミナー2回目以降」登録ベースに変更する。
-- 「セミナー2回目以降」が確定（LINE確認画面でOK）した時点でこの日時をセットし、
-- 以降そのスタッフには「初回ATC＋アカデミー会員費」を非表示にする。
-- それまでは「初回ATC＋アカデミー会員費」を何件でも登録可能。
-- 会計履歴（petty_cash_transactions）は書き換えず、この軽量フラグで表示状態のみ管理する（訂正はフラグのトグル）。
-- 旧 first_atc_claimed_at は履歴保持のため DROP しない（読み書きは停止）。

ALTER TABLE staff_members
  ADD COLUMN IF NOT EXISTS seminar_repeat_claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN staff_members.seminar_repeat_claimed_at IS
  'セミナー2回目以降の登録完了日時。非NULL=以降「初回ATC＋アカデミー会員費」を非表示。NULL=表示。管理画面でトグル可（訂正用）';
