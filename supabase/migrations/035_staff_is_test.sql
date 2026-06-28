-- 035_staff_is_test.sql
-- LINE申請フローを本番環境で安全にテストするためのテストスタッフ判別フラグ。
-- is_test=true のスタッフの申請は、保存先（Dropbox）・会計士向けCSV/立替集計・院長通知から分離・除外する。
-- 院長LINEを一時的にテストスタッフとして登録→テスト→解除、という運用を可能にする。
-- ※分離するのは「保存先・集計・通知」のみ。重複検知・支給額計算・各フローの挙動自体は本番と同一。

ALTER TABLE staff_members
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN staff_members.is_test IS
  'テストスタッフ判別。true=保存先をテストフォルダに分離し、会計士CSV/立替集計/院長通知から除外する';
