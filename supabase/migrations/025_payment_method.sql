-- 支払方法・振込先情報（要振込の請求書を抽出するための判別カラム）
-- payment_method: bank_transfer（振込）/ auto_debit（自動引落し）/ credit_card（カード）/ unknown（不明）
-- 既存データは payment_method NULL → アプリ上は unknown（不明）として扱う

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS payment_method TEXT,
  ADD COLUMN IF NOT EXISTS bank_info JSONB;

COMMENT ON COLUMN documents.payment_method IS '支払方法（bank_transfer/auto_debit/credit_card/unknown）';
COMMENT ON COLUMN documents.bank_info IS '振込先情報（銀行名・支店名・口座種別・口座番号・口座名義）';

-- payment_method の値を制限（NULLは許容＝既存データ＝不明扱い）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='documents_payment_method_check') THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_payment_method_check
      CHECK (payment_method IS NULL OR payment_method IN ('bank_transfer','auto_debit','credit_card','unknown'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_documents_payment_method ON documents(payment_method);
