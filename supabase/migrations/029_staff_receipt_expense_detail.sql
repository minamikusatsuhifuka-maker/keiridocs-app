-- 029_staff_receipt_expense_detail.sql
-- スタッフ立替（LINE精算フロー）の詳細区分を保存するカラムを追加する。
-- subsidy_category（支給率：achievement_repeat=半額/other=全額）とは別に、
-- 6種類の詳細区分（初回ATC＋アカデミー会員費／セミナー2回目以降／交通費／宿泊費／
-- 書籍代／当院での保険診療代／その他）のフル名称を保持し、経費科目としても活用する。

ALTER TABLE petty_cash_transactions
  ADD COLUMN IF NOT EXISTS expense_detail TEXT;

COMMENT ON COLUMN petty_cash_transactions.expense_detail IS
  'スタッフ立替の詳細区分（初回ATC＋アカデミー会員費/セミナー2回目以降（ATC再受講、ATC以外のコース）/交通費/宿泊費/書籍代/当院での保険診療代/その他）';
