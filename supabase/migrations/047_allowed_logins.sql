-- 047: ログインできるメールアドレスの許可リスト
--
-- ■ 背景
-- これまでアプリに許可リストが無く、Googleアカウントを持っている人なら
-- 誰でもログインでき、自動的に「スタッフ」権限が付いていた。
-- ログインすると取引先名・金額・スタッフの氏名と立替額が見える。
-- URLが外部に出ただけで情報が漏れる状態だったため、許可制にする。
--
-- ■ 仕組み
-- allowed_emails に入っているメールアドレスだけがログインできる。
-- 入っていない人は、ログインしても「権限がありません」の画面になる。
--
-- ■ 締め出しの防止
-- すでにログインしたことがある人（auth.users にいる人）を自動で登録する。
-- 実行した時点で使っている人が締め出されることはない。
-- 不要な人は管理画面「ログイン許可」から削除する。
--
-- ※ Supabase SQL Editor で手動実行する。実行直後は PostgREST のスキーマキャッシュ反映を待つこと。

CREATE TABLE IF NOT EXISTS allowed_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 小文字で保存する（Googleアカウントの大文字小文字の違いを吸収するため）
  email text NOT NULL UNIQUE,
  display_name text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);

COMMENT ON TABLE allowed_emails IS
  'アプリにログインできるメールアドレス。ここに無いアドレスはログインしても操作できない';

CREATE INDEX IF NOT EXISTS idx_allowed_emails_email ON allowed_emails (email);

ALTER TABLE allowed_emails ENABLE ROW LEVEL SECURITY;

-- 自分のアドレスが許可されているかだけを確認できるようにする。
-- 一覧全体は見せない（他の許可者のアドレスが見えてしまうため）。
-- 管理画面の一覧はサービスロール（API経由）で取得する。
DROP POLICY IF EXISTS allowed_emails_select_self ON allowed_emails;
CREATE POLICY allowed_emails_select_self ON allowed_emails
  FOR SELECT TO authenticated
  USING (lower(email) = lower(auth.jwt() ->> 'email'));

-- 既にログインしたことがある人を自動で登録する（締め出しの防止）
INSERT INTO allowed_emails (email, note, created_by)
SELECT DISTINCT lower(u.email), '047の実行時に自動登録', 'migration'
FROM auth.users u
WHERE u.email IS NOT NULL
ON CONFLICT (email) DO NOTHING;

-- PostgRESTのスキーマキャッシュを更新する
NOTIFY pgrst, 'reload schema';
