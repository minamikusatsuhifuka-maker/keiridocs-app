-- ユーザー権限管理テーブル
create table if not exists user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) unique,
  role text not null default 'staff' check (role in ('admin', 'staff', 'viewer')),
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS有効化
alter table user_roles enable row level security;

-- RLSポリシー: adminは全レコード閲覧・編集可
create policy "Admin can manage all user_roles"
  on user_roles for all
  using (
    exists (
      select 1 from user_roles ur
      where ur.user_id = auth.uid() and ur.role = 'admin'
    )
  );

-- RLSポリシー: staff/viewerは自分のレコードのみ閲覧
create policy "Users can view own role"
  on user_roles for select
  using (auth.uid() = user_id);

-- updated_at 自動更新トリガー
create trigger user_roles_updated_at
  before update on user_roles
  for each row execute function update_updated_at();
