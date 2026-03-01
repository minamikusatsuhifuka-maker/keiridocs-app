-- notify_recipients / allowed_senders / custom_folders の INSERT用 RLSポリシー修正
-- 既存の "for all using" ポリシーは SELECT/UPDATE/DELETE には機能するが、
-- INSERT 時の WITH CHECK が暗黙的に USING と同じになる。
-- しかし一部の Supabase バージョンでは INSERT に USING 句が適用されず失敗するケースがある。
-- 明示的に INSERT 用ポリシーを追加して確実にする。

-- notify_recipients: 既存ポリシーを削除して再作成
drop policy if exists "Users can manage own notify_recipients" on notify_recipients;

create policy "Users can select own notify_recipients"
  on notify_recipients for select
  using (auth.uid() = user_id);

create policy "Users can insert own notify_recipients"
  on notify_recipients for insert
  with check (auth.uid() = user_id);

create policy "Users can update own notify_recipients"
  on notify_recipients for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own notify_recipients"
  on notify_recipients for delete
  using (auth.uid() = user_id);

-- allowed_senders: 同様に修正
drop policy if exists "Users can manage own allowed_senders" on allowed_senders;

create policy "Users can select own allowed_senders"
  on allowed_senders for select
  using (auth.uid() = user_id);

create policy "Users can insert own allowed_senders"
  on allowed_senders for insert
  with check (auth.uid() = user_id);

create policy "Users can update own allowed_senders"
  on allowed_senders for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own allowed_senders"
  on allowed_senders for delete
  using (auth.uid() = user_id);

-- custom_folders: 同様に修正
drop policy if exists "Users can manage own custom_folders" on custom_folders;

create policy "Users can select own custom_folders"
  on custom_folders for select
  using (auth.uid() = user_id);

create policy "Users can insert own custom_folders"
  on custom_folders for insert
  with check (auth.uid() = user_id);

create policy "Users can update own custom_folders"
  on custom_folders for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own custom_folders"
  on custom_folders for delete
  using (auth.uid() = user_id);
