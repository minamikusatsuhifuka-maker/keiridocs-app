-- 初期スキーマ
-- 書類マスタ
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  vendor_name text not null,
  amount numeric,
  issue_date date,
  due_date date,
  description text,
  input_method text not null,
  status text not null default '未処理',
  dropbox_path text,
  thumbnail_url text,
  ocr_raw jsonb,
  user_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- メール未承認
create table if not exists mail_pending (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  sender text not null,
  received_at timestamptz,
  ai_type text,
  ai_confidence numeric,
  temp_path text,
  status text not null default 'pending',
  user_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

-- 設定
create table if not exists settings (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  value jsonb,
  user_id uuid not null references auth.users(id),
  updated_at timestamptz not null default now()
);

-- 許可送信元
create table if not exists allowed_senders (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  display_name text,
  user_id uuid not null references auth.users(id)
);

-- 通知先
create table if not exists notify_recipients (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  display_name text,
  user_id uuid not null references auth.users(id)
);

-- カスタムフォルダ
create table if not exists custom_folders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  monthly boolean not null default true,
  status_split boolean not null default true,
  date_field text not null default 'issueDate',
  user_id uuid not null references auth.users(id)
);

-- RLS有効化
alter table documents enable row level security;
alter table mail_pending enable row level security;
alter table settings enable row level security;
alter table allowed_senders enable row level security;
alter table notify_recipients enable row level security;
alter table custom_folders enable row level security;

-- RLSポリシー（ユーザーは自分のデータのみアクセス可能）
create policy "Users can manage own documents" on documents for all using (auth.uid() = user_id);
create policy "Users can manage own mail_pending" on mail_pending for all using (auth.uid() = user_id);
create policy "Users can manage own settings" on settings for all using (auth.uid() = user_id);
create policy "Users can manage own allowed_senders" on allowed_senders for all using (auth.uid() = user_id);
create policy "Users can manage own notify_recipients" on notify_recipients for all using (auth.uid() = user_id);
create policy "Users can manage own custom_folders" on custom_folders for all using (auth.uid() = user_id);

-- updated_at 自動更新トリガー
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger documents_updated_at
  before update on documents
  for each row execute function update_updated_at();

create trigger settings_updated_at
  before update on settings
  for each row execute function update_updated_at();
