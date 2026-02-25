-- 書類種別マスタ
create table if not exists document_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  dropbox_folder text,
  icon text,
  sort_order integer not null default 0,
  is_default boolean not null default false,
  user_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

-- ユーザーごとに種別名をユニークにする
create unique index if not exists document_types_user_name_idx
  on document_types (user_id, name);

-- RLS有効化
alter table document_types enable row level security;

-- RLSポリシー（ユーザーは自分のデータのみアクセス可能）
create policy "Users can manage own document_types"
  on document_types for all using (auth.uid() = user_id);
