-- 024_staff_refund_settlement.sql
-- スタッフ領収書の精算方法（小口/給与/保管）を区別するカラムを追加
ALTER TABLE petty_cash_transactions
  ADD COLUMN IF NOT EXISTS settlement_method TEXT,
  ADD COLUMN IF NOT EXISTS payroll_refund_status TEXT,
  ADD COLUMN IF NOT EXISTS payroll_refunded_at TIMESTAMPTZ;

-- settlement_method: 'petty_cash'(小口から返金) / 'payroll'(給与で返金) / 'storage_only'(保管のみ)
-- payroll_refund_status: 'pending'(給与返金待ち) / 'done'(返金済み) ※ settlement_method='payroll' のときのみ使用
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='petty_cash_settlement_check') THEN
    ALTER TABLE petty_cash_transactions
      ADD CONSTRAINT petty_cash_settlement_check
      CHECK (settlement_method IS NULL OR settlement_method IN ('petty_cash','payroll','storage_only'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_petty_cash_settlement ON petty_cash_transactions(settlement_method, payroll_refund_status);

COMMENT ON COLUMN petty_cash_transactions.settlement_method IS '精算方法 petty_cash(小口から返金)/payroll(給与で返金)/storage_only(保管のみ)。NULLは後方互換で小口返金扱い';
COMMENT ON COLUMN petty_cash_transactions.payroll_refund_status IS '給与返金の状態 pending(返金待ち)/done(返金済み)。settlement_method=payroll のときのみ使用';
COMMENT ON COLUMN petty_cash_transactions.payroll_refunded_at IS '給与で返金済みにした日時';
