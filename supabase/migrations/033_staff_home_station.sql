-- 033_staff_home_station.sql
-- 領収書なし交通費（電車）のAI運賃推定に使う「自宅最寄り駅」をスタッフ別に保持する。
-- home_station_pref（都道府県）は同名駅の特定に使用する。
-- /mkadmin のLINEスタッフ管理タブから管理者が登録・編集する。

ALTER TABLE staff_members
  ADD COLUMN IF NOT EXISTS home_station      text,
  ADD COLUMN IF NOT EXISTS home_station_pref text;

COMMENT ON COLUMN staff_members.home_station IS
  '自宅最寄り駅名（電車の片道運賃AI推定の出発駅）。NULL=未登録';
COMMENT ON COLUMN staff_members.home_station_pref IS
  '自宅最寄り駅の都道府県（同名駅の特定用）。NULL=未登録';
