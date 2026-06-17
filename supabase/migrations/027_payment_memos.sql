-- ============================================================
-- Migration 027: 支払いメモ（テキスト/画像をAIが仕分け、複数支払を抽出して管理）
-- 2026-06-15
-- ============================================================
-- 通常の取り込み資料（documents）・小口現金（petty_cash_transactions）とは
-- 別テーブルで独立管理する。1メモ＝複数支払項目に対応。

-- 支払いメモ本体（貼り付けた原文・画像）
CREATE TABLE IF NOT EXISTS payment_memos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_text TEXT,                       -- 貼り付けたテキスト原文
  image_url TEXT,                      -- スクリーンショット画像（DropboxパスまたはStorageパス）
  ai_summary TEXT,                     -- AIの全体要約
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- メモから抽出された個々の支払項目
CREATE TABLE IF NOT EXISTS payment_memo_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memo_id UUID REFERENCES payment_memos(id) ON DELETE CASCADE,
  vendor_name TEXT,                    -- 支払先
  amount NUMERIC,                      -- 金額
  due_date DATE,                       -- 支払期限
  payment_method TEXT,                 -- bank_transfer / credit_card / auto_debit / unknown
  note TEXT,                           -- 内容・備考
  payment_status TEXT DEFAULT '未払い', -- 未払い / 支払済み
  created_at TIMESTAMPTZ DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payment_memo_items_method_check') THEN
    ALTER TABLE payment_memo_items
      ADD CONSTRAINT payment_memo_items_method_check
      CHECK (payment_method IS NULL OR payment_method IN ('bank_transfer','credit_card','auto_debit','unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payment_memo_items_status_check') THEN
    ALTER TABLE payment_memo_items
      ADD CONSTRAINT payment_memo_items_status_check
      CHECK (payment_status IN ('未払い','支払済み'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payment_memo_items_memo ON payment_memo_items(memo_id);
CREATE INDEX IF NOT EXISTS idx_payment_memo_items_status ON payment_memo_items(payment_status);

-- ============================================================
-- RLS（既存テーブル petty_cash_transactions の方針に揃える）
--   SELECT: 全員可（USING true）
--   INSERT/UPDATE/DELETE: service role 経由のみ
--     （service role は RLS をバイパスするため明示ポリシー不要。
--      anon/authenticated 向けポリシーを作らないことで書込みを封鎖）
-- ============================================================
ALTER TABLE payment_memos ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_memo_items ENABLE ROW LEVEL SECURITY;

-- SELECT: 全員可
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='payment_memos' AND policyname='payment_memos_select') THEN
    CREATE POLICY "payment_memos_select" ON payment_memos FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='payment_memo_items' AND policyname='payment_memo_items_select') THEN
    CREATE POLICY "payment_memo_items_select" ON payment_memo_items FOR SELECT USING (true);
  END IF;
END $$;

COMMENT ON TABLE payment_memos IS '支払いメモ本体（貼り付けたテキスト・画像・AI要約）';
COMMENT ON TABLE payment_memo_items IS 'メモから抽出された個々の支払項目（1メモ複数項目）';
COMMENT ON COLUMN payment_memo_items.payment_method IS '支払方法: bank_transfer/credit_card/auto_debit/unknown';
COMMENT ON COLUMN payment_memo_items.payment_status IS '支払状況: 未払い/支払済み';
