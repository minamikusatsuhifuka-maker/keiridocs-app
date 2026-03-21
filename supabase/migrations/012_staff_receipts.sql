-- スタッフ領収書機能: スタッフマスタ + 領収書テーブル

-- スタッフマスタ
CREATE TABLE IF NOT EXISTS staff_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- スタッフ領収書
CREATE TABLE IF NOT EXISTS staff_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_member_id uuid NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  dropbox_path text NOT NULL,
  document_type text,
  date date,
  amount numeric,
  store_name text,
  tax_category text,
  account_title text,
  ai_raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS有効化
ALTER TABLE staff_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_receipts ENABLE ROW LEVEL SECURITY;

-- staff_members: 全員SELECT可
CREATE POLICY "staff_members_select" ON staff_members
  FOR SELECT USING (true);

-- staff_receipts: 全操作可
CREATE POLICY "staff_receipts_all" ON staff_receipts
  FOR ALL USING (true);

-- 初期スタッフデータ
INSERT INTO staff_members (name) VALUES
  ('田中太郎'),
  ('山田花子'),
  ('佐藤次郎');
