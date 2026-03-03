-- Admin can delete all documents (重複削除機能用)
create policy "Admin can delete all documents"
  on documents for delete
  using (
    exists (
      select 1 from user_roles ur
      where ur.user_id = auth.uid() and ur.role = 'admin'
    )
  );

-- Admin can select all documents (重複チェック・管理用)
create policy "Admin can select all documents"
  on documents for select
  using (
    exists (
      select 1 from user_roles ur
      where ur.user_id = auth.uid() and ur.role = 'admin'
    )
  );
