-- 自動仕分けルールテーブル
create table if not exists auto_classify_rules (
  id uuid primary key default gen_random_uuid(),
  keyword text not null,
  document_type text not null,
  priority integer not null default 0,
  is_active boolean not null default true,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (keyword, user_id)
);

-- RLSを有効化
alter table auto_classify_rules enable row level security;

-- ユーザーは自分のルールのみ操作可能
create policy "auto_classify_rules_select" on auto_classify_rules
  for select using (auth.uid() = user_id);

create policy "auto_classify_rules_insert" on auto_classify_rules
  for insert with check (auth.uid() = user_id);

create policy "auto_classify_rules_update" on auto_classify_rules
  for update using (auth.uid() = user_id);

create policy "auto_classify_rules_delete" on auto_classify_rules
  for delete using (auth.uid() = user_id);
