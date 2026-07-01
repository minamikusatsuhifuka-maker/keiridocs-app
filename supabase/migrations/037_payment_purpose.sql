-- 037_payment_purpose.sql
-- 書類一覧・CSVに「支払い内容」（AIによるおおよその要約）を表示するための列を追加する。
-- 例）「セミナー参加費」「講演料」「医薬品（デュピクセント 等）」「電気料金」「消防設備点検」。
-- 既存の摘要（description・生データ寄りの抜粋）とは別項目。判定不能時は空欄（''）。
--   NULL      … 未生成（バックフィル/遅延生成の対象）
--   ''（空）  … 生成を試みたが判定不能（再生成しない）
--   文字列    … AI要約済み

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS payment_purpose text;

COMMENT ON COLUMN documents.payment_purpose IS
  '支払い内容（AI要約・best-effort）。NULL=未生成 / 空=判定不能 / 文字列=要約済み';
