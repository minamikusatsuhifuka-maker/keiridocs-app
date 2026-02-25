-- download_sources: サイト自動DL（請求書自動取得）ソース管理テーブル
CREATE TABLE IF NOT EXISTS download_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url text,
  description text,
  schedule text DEFAULT 'manual' CHECK (schedule IN ('manual', 'monthly')),
  last_downloaded_at timestamptz,
  is_active boolean DEFAULT true,
  login_info_encrypted text,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- RLS有効化
ALTER TABLE download_sources ENABLE ROW LEVEL SECURITY;

-- SELECT: 自分のデータのみ閲覧可
CREATE POLICY "download_sources_select" ON download_sources
  FOR SELECT USING (auth.uid() = user_id);

-- INSERT: 自分のデータのみ追加可
CREATE POLICY "download_sources_insert" ON download_sources
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- UPDATE: 自分のデータのみ更新可
CREATE POLICY "download_sources_update" ON download_sources
  FOR UPDATE USING (auth.uid() = user_id);

-- DELETE: 自分のデータのみ削除可
CREATE POLICY "download_sources_delete" ON download_sources
  FOR DELETE USING (auth.uid() = user_id);
