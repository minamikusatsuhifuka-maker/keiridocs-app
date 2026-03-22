-- staff_membersテーブルにLINE user_idカラムを追加
ALTER TABLE staff_members ADD COLUMN line_user_id text;

-- line_user_idでの検索用インデックス
CREATE INDEX idx_staff_members_line_user_id ON staff_members (line_user_id) WHERE line_user_id IS NOT NULL;
