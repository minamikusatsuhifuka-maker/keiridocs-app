-- 036_vendor_payment_methods.sql
-- 支払先ごとの支払方法マスタ（永続・AI判定より優先）。
-- 「要振込の請求書」リストから口座振替（自動引落・振込不要）の支払先を除外するために使う。
-- 例）関西電力を method='口座振替' に登録 → 以降その支払先の請求書は要振込リストから自動で外れる。
--
-- 支払方法の値:
--   '都度振込' … 銀行振込が必要（要振込リストに表示）
--   '口座振替' … 自動引落・振込不要（要振込リストから除外）
--   'その他'   … 現金・カード等（要振込リストから除外）
--
-- ※ documents.payment_method（bank_transfer/auto_debit/credit_card/unknown）は
--    AI初期判定のまま維持し、この支払先マスタを重ね合わせて最終判定する（マスタ優先）。

CREATE TABLE IF NOT EXISTS vendor_payment_methods (
  vendor_name text PRIMARY KEY,
  method      text NOT NULL DEFAULT '口座振替',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- method の値を制限
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vendor_payment_methods_method_check'
  ) THEN
    ALTER TABLE vendor_payment_methods
      ADD CONSTRAINT vendor_payment_methods_method_check
      CHECK (method IN ('都度振込', '口座振替', 'その他'));
  END IF;
END $$;

COMMENT ON TABLE vendor_payment_methods IS
  '支払先ごとの支払方法マスタ（AI判定より優先）。口座振替の支払先を要振込リストから除外するために使う';
COMMENT ON COLUMN vendor_payment_methods.vendor_name IS '支払先名（documents.vendor_name と突き合わせ）';
COMMENT ON COLUMN vendor_payment_methods.method IS '支払方法（都度振込/口座振替/その他）';

-- RLS（既存テーブル payment_memos の方針に揃える）
--   SELECT: 全員可（USING true）
--   INSERT/UPDATE/DELETE: service role 経由のみ（明示ポリシーを作らないことで書込みを封鎖）
ALTER TABLE vendor_payment_methods ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'vendor_payment_methods' AND policyname = 'vendor_payment_methods_select'
  ) THEN
    CREATE POLICY "vendor_payment_methods_select" ON vendor_payment_methods FOR SELECT USING (true);
  END IF;
END $$;
