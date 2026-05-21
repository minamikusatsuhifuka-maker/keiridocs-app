-- ============================================================
-- Migration 023: 小口現金統合（患者対応 / スタッフ返金）
-- 2026-05-21
-- ============================================================

-- 既存の petty_cash_transactions:
--   type ('入金'/'出金'/'返金'), amount (>0), description, staff_member_id (既存),
--   staff_receipt_id, document_id, receipt_image_url, dropbox_path, registered_by, created_at
-- 追加するもの:
--   category, subcategory, receipt_urls, note, created_by,
--   transaction_date, balance_after

ALTER TABLE petty_cash_transactions
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS subcategory TEXT,
  ADD COLUMN IF NOT EXISTS receipt_urls JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS note TEXT,
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS transaction_date DATE,
  ADD COLUMN IF NOT EXISTS balance_after NUMERIC;

-- 既存レコードの transaction_date を created_at から補完
UPDATE petty_cash_transactions
   SET transaction_date = (created_at AT TIME ZONE 'Asia/Tokyo')::date
 WHERE transaction_date IS NULL;

-- category 値の制約
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'petty_cash_category_check'
  ) THEN
    ALTER TABLE petty_cash_transactions
      ADD CONSTRAINT petty_cash_category_check
      CHECK (category IS NULL OR category IN ('patient_response','staff_refund','cash_in','other'));
  END IF;
END $$;

-- subcategory 値の制約（患者対応のみ使用）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'petty_cash_subcategory_check'
  ) THEN
    ALTER TABLE petty_cash_transactions
      ADD CONSTRAINT petty_cash_subcategory_check
      CHECK (subcategory IS NULL OR subcategory IN ('insurance_refund','self_pay_refund','other'));
  END IF;
END $$;

-- 月次集計用インデックス
CREATE INDEX IF NOT EXISTS idx_petty_cash_transaction_date
  ON petty_cash_transactions(transaction_date);

CREATE INDEX IF NOT EXISTS idx_petty_cash_category
  ON petty_cash_transactions(category);

CREATE INDEX IF NOT EXISTS idx_petty_cash_staff
  ON petty_cash_transactions(staff_member_id);

COMMENT ON COLUMN petty_cash_transactions.category IS '種別: patient_response/staff_refund/cash_in/other';
COMMENT ON COLUMN petty_cash_transactions.subcategory IS '患者対応の内訳: insurance_refund/self_pay_refund/other';
COMMENT ON COLUMN petty_cash_transactions.receipt_urls IS 'アップロードした領収書のDropboxパス配列';
COMMENT ON COLUMN petty_cash_transactions.transaction_date IS '取引日（YYYY-MM-DD）';
COMMENT ON COLUMN petty_cash_transactions.balance_after IS '取引後の残高（スナップショット）';
