-- 045_course_rule_and_group.sql
-- 講座の「分類」と「支給率の方式」を分ける。
--
-- ■ 背景
-- 044 では courses.kind に分類と支給ルールを兼用させていた（apex/ach_other/non_ach）。
-- 実際の規程は分類と支給率が1対1ではない。
--
--   【頂点への道】は4コースある
--     ・アチーブメントテクノロジーコース（ATC）
--     ・ダイナミックコース
--     ・ダイナミックアドバンスコース
--     ・ピークパフォーマンスコース
--   ATCだけ「初回は受講料全額／再受講1〜6回目は50%／7回目以降は未定」という独自の方式。
--   他の3コースの支給率は未定。
--
-- さらに分類としては JPSA や 検定・試験 も必要になった。
--
-- そこで次の2列に分ける。
--   kind … 分類（表示・集計用）。apex / ach_other / jpsa / exam / non_ach
--   rule … 支給率の方式（計算に使う）。full / atc / undecided
--
-- ■ rule の意味
--   full       … 常に全額（交通費＋宿泊費は合計30,000円/講座の上限あり）
--   half       … 常に半額。受講料・交通費・宿泊費が半額（弁当代とアカデミー会費は全額）。
--                 ダイナミックコース／ダイナミックアドバンスコース／ピークパフォーマンスコースがこれ。
--   atc        … ATC方式。受講料は初回全額／再受講1〜6回目は半額／7回目以降は担当判断。
--                 再受講の回は「そのスタッフの atc 方式の受講料申請の回数」で数える。
--                 交通費・宿泊費も半額の回は半額（上限30,000円を当ててから半額）。
--                 弁当代とアカデミー会費は常に全額。
--   undecided  … 支給率が未定。自動では支給額を確定させず、すべて担当の判断待ちにする。
--                 未定のまま推測で支給すると是正が煩雑になるため、保留が既定。
--
-- 既存の行は rule='undecided' になる。担当が講座マスタで方式を選ぶまで保留されるので、
-- 規程が決まっていない支給が自動で通ることはない。
--
-- ※ Supabase SQL Editor で手動実行する。実行直後は PostgREST のスキーマキャッシュ反映を待つこと。

-- 分類に JPSA・検定/試験 を追加するため、旧いCHECK制約を外して付け直す
ALTER TABLE courses DROP CONSTRAINT IF EXISTS courses_kind_check;
ALTER TABLE courses
  ADD CONSTRAINT courses_kind_check
  CHECK (kind IN ('apex', 'ach_other', 'jpsa', 'exam', 'non_ach'));

-- 支給率の方式
ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS rule text NOT NULL DEFAULT 'undecided';

ALTER TABLE courses DROP CONSTRAINT IF EXISTS courses_rule_check;
ALTER TABLE courses
  ADD CONSTRAINT courses_rule_check
  CHECK (rule IN ('full', 'atc', 'half', 'undecided'));

COMMENT ON COLUMN courses.kind IS
  '分類（表示・集計用）。apex=頂点への道／ach_other=その他のアチーブメント講座／jpsa=JPSA／exam=検定・試験／non_ach=アチーブメント以外';
COMMENT ON COLUMN courses.rule IS
  '支給率の方式。full=常に全額／half=常に半額／atc=ATC方式（初回全額・再受講1〜6回目半額・7回目以降は担当判断）／undecided=未定（すべて担当の判断待ちにする）';

NOTIFY pgrst, 'reload schema';
