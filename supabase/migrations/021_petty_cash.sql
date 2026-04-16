-- 小口現金管理テーブル

-- 小口現金設定（残高管理・1レコードのみ）
CREATE TABLE IF NOT EXISTS petty_cash_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  balance numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 初期レコード挿入
INSERT INTO petty_cash_settings (balance) VALUES (0)
ON CONFLICT DO NOTHING;

-- 小口現金取引履歴
CREATE TABLE IF NOT EXISTS petty_cash_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('入金', '出金', '返金')),
  amount numeric NOT NULL CHECK (amount > 0),
  description text,
  staff_member_id uuid REFERENCES staff_members(id) ON DELETE SET NULL,
  staff_receipt_id uuid REFERENCES staff_receipts(id) ON DELETE SET NULL,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  receipt_image_url text,
  dropbox_path text,
  registered_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS有効化
ALTER TABLE petty_cash_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE petty_cash_transactions ENABLE ROW LEVEL SECURITY;

-- SELECT: 全員可
CREATE POLICY "petty_cash_settings_select" ON petty_cash_settings
  FOR SELECT USING (true);

CREATE POLICY "petty_cash_transactions_select" ON petty_cash_transactions
  FOR SELECT USING (true);

-- INSERT/UPDATE/DELETE: service roleのみ（anon/authenticatedは不可）
-- service roleはRLSをバイパスするため、明示的なポリシーは不要
