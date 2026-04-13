-- documents テーブルに Google カレンダーイベントIDを追加
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS calendar_event_id text;

COMMENT ON COLUMN documents.calendar_event_id IS 'Google カレンダーに登録済みのイベントID（未登録の場合は NULL）';
