-- 030_staff_receipt_image_hash.sql
-- スタッフ立替領収書の重複検知用に、LINE登録画像のSHA-256ハッシュを保存するカラムを追加する。
-- 同一画像の二重申請（別メッセージでの再送）を検知してブロックするために使う。

ALTER TABLE staff_receipts
  ADD COLUMN IF NOT EXISTS image_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_staff_receipts_image_hash
  ON staff_receipts(image_hash);

COMMENT ON COLUMN staff_receipts.image_hash IS
  'LINE登録画像のSHA-256ハッシュ（重複検知用）';
