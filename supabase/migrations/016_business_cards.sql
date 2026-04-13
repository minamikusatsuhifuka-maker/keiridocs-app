-- 名刺管理テーブル
CREATE TABLE business_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text,
  department text,
  name text,
  title text,
  email text,
  phone text,
  mobile text,
  address text,
  website text,
  memo text,
  dropbox_path text,
  file_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE business_cards ENABLE ROW LEVEL SECURITY;

-- 全操作許可（認証済みユーザー）
CREATE POLICY "business_cards_all" ON business_cards FOR ALL USING (true) WITH CHECK (true);

-- 検索用インデックス
CREATE INDEX idx_business_cards_company_name ON business_cards (company_name);
CREATE INDEX idx_business_cards_name ON business_cards (name);
CREATE INDEX idx_business_cards_created_at ON business_cards (created_at DESC);
