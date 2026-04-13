-- 支払ステータス管理
-- documents.payment_status: 未対応 / 支払い済み

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT '未対応';

COMMENT ON COLUMN documents.payment_status IS '支払ステータス（未対応/支払い済み）';

CREATE INDEX IF NOT EXISTS idx_documents_payment_status
  ON documents(payment_status);
