-- 書類登録者機能
-- registrants: 書類の登録者マスタ（運用者の名前を管理）
-- documents.registrant_id: 書類がどの登録者によって取り込まれたか

-- 登録者マスタ
CREATE TABLE IF NOT EXISTS registrants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE registrants IS '書類登録者マスタ';
COMMENT ON COLUMN registrants.name IS '登録者名（例: 管理者、スタッフA）';

-- documents に registrant_id を追加
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS registrant_id uuid REFERENCES registrants(id) ON DELETE SET NULL;

COMMENT ON COLUMN documents.registrant_id IS '書類を取り込んだ登録者（registrants.id）';

CREATE INDEX IF NOT EXISTS idx_documents_registrant_id ON documents(registrant_id);

-- RLS: 全操作可（運用者マスタなので共有）
ALTER TABLE registrants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "registrants_select_all" ON registrants;
CREATE POLICY "registrants_select_all" ON registrants
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "registrants_insert_all" ON registrants;
CREATE POLICY "registrants_insert_all" ON registrants
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "registrants_update_all" ON registrants;
CREATE POLICY "registrants_update_all" ON registrants
  FOR UPDATE USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "registrants_delete_all" ON registrants;
CREATE POLICY "registrants_delete_all" ON registrants
  FOR DELETE USING (true);

-- 初期データ
INSERT INTO registrants (name)
SELECT '管理者'
WHERE NOT EXISTS (SELECT 1 FROM registrants WHERE name = '管理者');
