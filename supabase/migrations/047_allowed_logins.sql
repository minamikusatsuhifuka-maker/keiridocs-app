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
-- 入っていない人は、ログインしても「このアカウントでは利用できません」の画面になる。
--
-- ■ 締め出しの防止
-- すでにログインしたことがある人（auth.users にいる人）を自動で登録する。
-- 実行した時点で使っている人が締め出されることはない。
-- 不要な人は管理画面「ログイン許可」から削除する。
--
-- ■ 元に戻したいとき
--   DROP TABLE allowed_emails;
-- アプリはこのテーブルが無い場合「制限なし」として動くため、
-- 実行前の状態に戻る（万が一ログインできなくなったときの戻し方）。
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

-- 既にログインしたことがある人を自動で登録する（締め出しの防止）。
-- RLSを有効にする前に入れておく。
INSERT INTO allowed_emails (email, note, created_by)
SELECT DISTINCT lower(u.email), '047の実行時に自動登録', 'migration'
FROM auth.users u
WHERE u.email IS NOT NULL
ON CONFLICT (email) DO NOTHING;

ALTER TABLE allowed_emails ENABLE ROW LEVEL SECURITY;

-- 自分のアドレスが許可されているかだけを確認できるようにする。
-- 一覧全体は見せない（他の許可者のアドレスが見えてしまうため）。
-- 管理画面の一覧はサービスロール（API経由）で取得する。
--
-- メールアドレスはJWTのクレームから取る。Supabaseの auth.email() が
-- 使える環境ではそちらを優先し、無い場合はクレームを直接読む
-- （どちらかが取れれば判定できるようにして、締め出しを避ける）。
DROP POLICY IF EXISTS allowed_emails_select_self ON allowed_emails;
CREATE POLICY allowed_emails_select_self ON allowed_emails
  FOR SELECT TO authenticated
  USING (
    lower(email) = lower(coalesce(nullif(auth.jwt() ->> 'email', ''), ''))
    OR lower(email) = lower(coalesce(nullif(auth.jwt() -> 'user_metadata' ->> 'email', ''), ''))
  );

-- PostgRESTのスキーマキャッシュを更新する
NOTIFY pgrst, 'reload schema';

-- 実行後の確認用（許可されたアドレスの一覧）
SELECT email, note, created_at FROM allowed_emails ORDER BY created_at;
