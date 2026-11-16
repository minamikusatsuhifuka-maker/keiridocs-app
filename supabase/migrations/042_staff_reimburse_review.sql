-- 042_staff_reimburse_review.sql
-- スタッフ立替の「確認済み」を記録する列を追加する。
--
-- 背景：最寄り駅の変更・改姓・交通手段の変更（車 → 電車／定期券）が増えるため、
-- 受付担当が申請を1件ずつ確認する運用になった。どこまで見たかを残さないと、
-- 複数人で手分けしたときに重複したり、見落としたりする。
--
-- 方針：
--   - 確認は「明細1行ごと」に記録する。1枚の領収書を分割登録した場合は行ごとに確認する必要があるため、
--     staff_receipts ではなく petty_cash_transactions に持たせる。
--   - 確認は進捗の可視化のみで、支給や税理士提出は止めない（締めに間に合わない事故を防ぐため）。
--
-- ※ Supabase SQL Editor で手動実行する。実行直後は PostgREST のスキーマキャッシュ反映を待つこと
--   （反映前はアプリ側が「列なし」とみなして確認列を空で表示する）。

ALTER TABLE petty_cash_transactions
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by text;

COMMENT ON COLUMN petty_cash_transactions.reviewed_at IS
  'スタッフ立替の内容を受付担当が確認した日時。NULL は未確認。支給・税理士提出には影響しない';
COMMENT ON COLUMN petty_cash_transactions.reviewed_by IS
  '確認した担当者（ログイン中のユーザーのメールアドレスまたは表示名）';

-- 未確認の明細を絞り込むための部分インデックス（件数バッジ・一覧の絞り込みで使う）
CREATE INDEX IF NOT EXISTS idx_pct_unreviewed
  ON petty_cash_transactions (created_at)
  WHERE category = 'staff_refund' AND reviewed_at IS NULL;

-- PostgREST のスキーマキャッシュを即時更新する
NOTIFY pgrst, 'reload schema';
