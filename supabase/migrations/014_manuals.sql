-- マニュアルカテゴリテーブル
CREATE TABLE manual_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  emoji text NOT NULL DEFAULT '',
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE manual_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "manual_categories_all" ON manual_categories FOR ALL USING (true);

-- マニュアルテーブル
CREATE TABLE manuals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid REFERENCES manual_categories(id) ON DELETE SET NULL,
  title text NOT NULL,
  content text NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE manuals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "manuals_all" ON manuals FOR ALL USING (true);

-- 全文検索用インデックス
CREATE INDEX idx_manuals_title_content ON manuals USING gin (to_tsvector('simple', title || ' ' || content));

-- 初期カテゴリデータ
INSERT INTO manual_categories (name, emoji, description) VALUES
  ('処置・手順', '🩹', '診療・処置に関する手順書'),
  ('服務・規則・マナー', '📋', '就業規則・接遇マナー・身だしなみ'),
  ('機器操作・緊急時対応', '🔧', '医療機器の操作方法・緊急対応マニュアル'),
  ('美容施術・皮膚科診療', '💆', '美容施術メニュー・皮膚科診療の基本'),
  ('新人研修', '🎓', '新入職員向けオリエンテーション・研修資料'),
  ('事務・経理・受付手順', '🏥', '受付業務・会計・経理処理の手順');
