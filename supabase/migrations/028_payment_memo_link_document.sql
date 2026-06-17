-- ============================================================
-- Migration 028: 支払いメモ項目を請求書(documents)と紐づける
-- 2026-06-17
-- ============================================================
-- documents.id は uuid（001_initial.sql で gen_random_uuid()）なので
-- linked_document_id も UUID とする。
-- ON DELETE SET NULL: 紐づけ先の書類が削除されてもメモ項目は残す。

ALTER TABLE payment_memo_items
  ADD COLUMN IF NOT EXISTS linked_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payment_memo_items_linked_doc
  ON payment_memo_items(linked_document_id);

COMMENT ON COLUMN payment_memo_items.linked_document_id IS '紐づけた請求書(documents)のID。NULL=未紐づけ';
