-- スキャン検知ファイルの状態管理テーブル
CREATE TABLE IF NOT EXISTS scan_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  dropbox_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending / processing / processed / needs_review / error
  review_reasons TEXT[],                    -- 要確認理由の配列
  error_message TEXT,                       -- エラーメッセージ
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,  -- 登録された書類のID
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_scan_items_user_id ON scan_items(user_id);
CREATE INDEX IF NOT EXISTS idx_scan_items_status ON scan_items(status);
CREATE INDEX IF NOT EXISTS idx_scan_items_dropbox_path ON scan_items(dropbox_path);

-- RLSポリシー
ALTER TABLE scan_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "scan_items_select_own" ON scan_items
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "scan_items_insert_own" ON scan_items
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "scan_items_update_own" ON scan_items
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "scan_items_delete_own" ON scan_items
  FOR DELETE USING (auth.uid() = user_id);
