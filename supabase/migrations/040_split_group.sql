-- 040: 分割登録グループID
-- 1ファイルに複数の独立した支払いが含まれる場合、支払いごとに別レコードとして登録する。
-- 同じファイル由来の分割レコード同士を識別し、重複検知の誤発火を防ぐためのグループID。
-- ※ Supabase SQL Editor で手動実行すること

ALTER TABLE documents ADD COLUMN IF NOT EXISTS split_group uuid;

-- 分割レコードの検索用（NULLが大半のため部分インデックス）
CREATE INDEX IF NOT EXISTS idx_documents_split_group
  ON documents (split_group)
  WHERE split_group IS NOT NULL;
