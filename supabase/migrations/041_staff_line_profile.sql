-- 041_staff_line_profile.sql
-- LINE経費申請 フェーズ1：定期券・初回設定の完了状態などを保持する jsonb 列を1つだけ追加する。
--
-- 既存の staff_members には jsonb 列が無く、settings テーブルは auth.users への外部キーが必須のため
-- スタッフ単位の情報を置けない。そこで「列を1つだけ」追加し、以降の項目追加はこの jsonb 内で行う
-- （項目ごとのスキーマ変更を不要にする）。
--
-- 保持する内容（src/lib/line-staff-profile.ts の LineProfile 型が正本）:
--   commuter_pass        : { has: boolean, from?: string, from_pref?: string, to?: string, to_pref?: string, updated_at }
--                          has=false … 定期券なし（以降質問しない） / キー無し … 未回答
--   name_confirmed_at    : フルネーム確認の完了日時
--   setup_completed_at   : 初回設定（氏名確認・最寄り駅・定期券）の完了日時。非NULLなら二度と聞かない
--   last_applied_at      : 直近の申請開始日時（3か月以上空いた場合の一言案内に使う）
--   name_change_requests : 氏名変更の申請履歴（担当が /mkadmin で変更する）
--
-- ※ Supabase SQL Editor で手動実行する。実行直後は PostgREST のスキーマキャッシュ反映を待つこと
--   （反映前はアプリ側が「列なし」とみなして従来動作にフォールバックする）。

ALTER TABLE staff_members
  ADD COLUMN IF NOT EXISTS line_profile jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN staff_members.line_profile IS
  'LINE申請用のスタッフ設定（定期券・初回設定完了・最終申請日時・氏名変更申請）。形式は src/lib/line-staff-profile.ts を参照';

-- PostgREST のスキーマキャッシュを即時更新する
NOTIFY pgrst, 'reload schema';
