-- 書類登録スタッフマスタ
-- document_staff: 書類登録時に選択する登録者名
-- 従来の registrants から独立した専用マスタ

CREATE TABLE IF NOT EXISTS document_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE document_staff IS '書類登録スタッフマスタ';
COMMENT ON COLUMN document_staff.name IS 'スタッフ名（例: 管理者、伊藤、スタッフA）';

-- documents に document_staff_id を追加
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS document_staff_id uuid REFERENCES document_staff(id) ON DELETE SET NULL;

COMMENT ON COLUMN documents.document_staff_id IS '書類を登録したスタッフ（document_staff.id）';

CREATE INDEX IF NOT EXISTS idx_documents_document_staff_id ON documents(document_staff_id);

-- RLS: 全操作可
ALTER TABLE document_staff ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "document_staff_select_all" ON document_staff;
CREATE POLICY "document_staff_select_all" ON document_staff
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "document_staff_insert_all" ON document_staff;
CREATE POLICY "document_staff_insert_all" ON document_staff
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "document_staff_update_all" ON document_staff;
CREATE POLICY "document_staff_update_all" ON document_staff
  FOR UPDATE USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "document_staff_delete_all" ON document_staff;
CREATE POLICY "document_staff_delete_all" ON document_staff
  FOR DELETE USING (true);

-- 初期データ: staff_members から全員 + 管理者・伊藤
INSERT INTO document_staff (name)
SELECT name FROM staff_members
ON CONFLICT (name) DO NOTHING;

INSERT INTO document_staff (name)
VALUES ('管理者'), ('伊藤')
ON CONFLICT (name) DO NOTHING;
