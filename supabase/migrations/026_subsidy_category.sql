-- 026_subsidy_category.sql
-- アチーブメント研修の参加区分カラムを追加（スタッフ返金＝category='staff_refund' の行で使う）
-- 区分により支給率が変わる: 2回目以降のみ半額、それ以外は全額（支給額の計算は資料出力時）
ALTER TABLE petty_cash_transactions
  ADD COLUMN IF NOT EXISTS subsidy_category TEXT;

-- subsidy_category: achievement_first(初参加・全額) / achievement_repeat(2回目以降・半額) / other(それ以外・全額)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='petty_cash_subsidy_category_check') THEN
    ALTER TABLE petty_cash_transactions
      ADD CONSTRAINT petty_cash_subsidy_category_check
      CHECK (subsidy_category IS NULL OR subsidy_category IN ('achievement_first','achievement_repeat','other'));
  END IF;
END $$;

COMMENT ON COLUMN petty_cash_transactions.subsidy_category IS 'アチーブメント参加区分 achievement_first(初参加・全額)/achievement_repeat(2回目以降・半額)/other(それ以外・全額)。NULLは後方互換で全額扱い';
