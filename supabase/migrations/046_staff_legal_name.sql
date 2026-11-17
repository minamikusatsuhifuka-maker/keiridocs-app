-- 046: 給与・行政上の氏名（legal_name）
--
-- 結婚などで戸籍（行政上）の氏名が変わっても、職場では旧姓のまま働くことがある。
-- 給与・社会保険・源泉徴収は戸籍の氏名で処理する必要があるため、
-- 仕事上の氏名（name）と行政上の氏名（legal_name）を分けて持つ。
--
-- - name       … 仕事上の氏名。LINE・書類登録スタッフ・画面表示に使う
-- - legal_name … 給与・行政上の氏名。未入力なら name と同じ扱い
--
-- LINEの氏名照合はどちらの氏名でも一致する（スタッフが取り違えても通る）。

ALTER TABLE staff_members
  ADD COLUMN IF NOT EXISTS legal_name text;

COMMENT ON COLUMN staff_members.legal_name IS
  '給与・行政上の氏名。仕事上の氏名（name）と異なる場合のみ入力。未入力なら name と同じ';

-- PostgRESTのスキーマキャッシュを更新する（追加した列を即座に使えるようにする）
NOTIFY pgrst, 'reload schema';
