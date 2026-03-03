-- ファイルハッシュカラムを追加（重複検知の精度向上）
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_hash TEXT DEFAULT '';
