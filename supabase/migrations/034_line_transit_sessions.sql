-- 034_line_transit_sessions.sql
-- LINEの「領収書なし交通費」申請は複数ステップの対話（手段選択→到着駅→県→片道/往復→利用日→確認）。
-- 各テキスト入力の間で「今どのステップか・入力済みデータ」を保持するため、
-- LINEユーザー単位の軽量な会話セッションをDBに永続化する（Vercelの関数インスタンス再利用に依存しない）。
-- 1ユーザー1セッション（line_user_id がPK）。確定・キャンセル時に削除する。

CREATE TABLE IF NOT EXISTS line_transit_sessions (
  line_user_id    text PRIMARY KEY,
  staff_member_id uuid,
  step            text NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE line_transit_sessions IS
  'LINE「領収書なし交通費」申請の対話セッション（ステップ＋入力途中データ）。確定/キャンセルで削除';
