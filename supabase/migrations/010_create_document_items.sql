-- 明細行テーブル（書類の各行データを保存）
CREATE TABLE IF NOT EXISTS document_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  item_name TEXT NOT NULL DEFAULT '',
  quantity NUMERIC DEFAULT 1,
  unit_price NUMERIC DEFAULT 0,
  amount NUMERIC NOT NULL DEFAULT 0,
  category TEXT DEFAULT '',
  tax_rate TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE document_items ENABLE ROW LEVEL SECURITY;

-- ユーザーは自分の明細のみ操作可能
CREATE POLICY "Users can manage own items"
  ON document_items FOR ALL
  USING (auth.uid() = user_id);

-- Admin は全件操作可能
CREATE POLICY "Admin can manage all items"
  ON document_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
    )
  );

CREATE INDEX idx_document_items_document_id ON document_items(document_id);
CREATE INDEX idx_document_items_user_id ON document_items(user_id);
