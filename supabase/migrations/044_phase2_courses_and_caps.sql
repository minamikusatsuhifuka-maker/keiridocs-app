-- 044_phase2_courses_and_caps.sql
-- フェーズ2：費用区分の再編と支給上限（講座マスタ・上限超過の承認）
--
-- ■ 背景
-- 旧ルールは「セミナー2回目以降なら半額、それ以外は全額、上限なし」だけだった。
-- 実際の規程は次のとおりで、上限と内訳の区別が必要になる。
--   【頂点への道】初回      受講料 全額／交通費＋宿泊費 合計30,000円まで／弁当代 全額
--   【頂点への道】2回目以降 受講料 半額／交通費＋宿泊費 30,000円で頭打ちにしてから半額／弁当代 全額
--   【その他のアチーブメント講座】初回と同じ（半額にならない）
--   【アチーブメント以外】受講料 全額／交通費＋宿泊費 合計30,000円まで／弁当代は対象外
--   【書籍代】【診療費】 申請月（20日締め）ごとに各5,000円まで（別枠）
--   【資格試験】合格通知・修了通知の添付があれば受験料 全額
--
-- ■ 上限を超えた場合
-- 申請は拒否しない。支給額は上限で計算し、超過分は受付担当（河村）が
-- 追加支給額を入力して承認する。承認するまでは税理士提出・支給集計に含めない。
--
-- ■ 講座マスタ（courses）が必要な理由
-- 30,000円の上限は「講座1件ごと」に判定する。領収書には講座名が載らないことが多く、
-- AIが読んだ文字列では「頂点への道」「頂点への道11月期」「ATC」と揺れて同じ講座として
-- 束ねられない。束ねられないと上限が効かず過大支給になる。
-- 講座に区分（apex / ach_other / non_ach）を紐づけることで、
-- スタッフは講座名を1タップ選ぶだけでよく、支給率と上限は自動で決まる。
--
-- ※ Supabase SQL Editor で手動実行する。実行直後は PostgREST のスキーマキャッシュ反映を待つこと。

-- ---------- 講座マスタ ----------
CREATE TABLE IF NOT EXISTS courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 講座名。スタッフが選ぶ表示名（例：頂点への道 2026年11月期）
  name text NOT NULL,
  -- 区分：apex=頂点への道／ach_other=その他のアチーブメント講座／non_ach=アチーブメント以外
  kind text NOT NULL CHECK (kind IN ('apex', 'ach_other', 'non_ach')),
  -- 選択肢に出すか（終了した講座はOFFにして一覧から外す。過去の申請は残る）
  is_active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE courses IS
  'スタッフ立替の講座マスタ。30,000円上限の単位（講座1件ごと）と支給区分の判定に使う';
COMMENT ON COLUMN courses.kind IS
  'apex=頂点への道（初回/2回目以降で支給率が変わる）／ach_other=その他のアチーブメント講座（常に全額・弁当代対象）／non_ach=アチーブメント以外（常に全額・弁当代対象外）';

CREATE INDEX IF NOT EXISTS idx_courses_active ON courses (is_active, name);

ALTER TABLE courses ENABLE ROW LEVEL SECURITY;

-- 認証済みユーザーは参照可。更新はサービスロール（API経由）のみ
DROP POLICY IF EXISTS courses_select ON courses;
CREATE POLICY courses_select ON courses FOR SELECT TO authenticated USING (true);

-- ---------- 明細に区分・上限超過・承認を持たせる ----------
ALTER TABLE petty_cash_transactions
  -- どの講座の分か（研修・セミナー以外はNULL）
  ADD COLUMN IF NOT EXISTS course_id uuid REFERENCES courses(id) ON DELETE SET NULL,
  -- 講座マスタに無い講座名で申請された場合の入力値（担当が後から割り当てる）
  ADD COLUMN IF NOT EXISTS course_pending_name text,
  -- 内訳：tuition=受講料／transport=交通費／lodging=宿泊費／bento=弁当代／
  --       books=書籍代／medical=診療費／exam=受験料／commute=交通費(通常業務)／other=その他
  ADD COLUMN IF NOT EXISTS expense_item text,
  -- 上限を超えた金額（未承認の間だけ値が入る）
  ADD COLUMN IF NOT EXISTS excess_amount integer,
  -- 担当が承認した追加支給額（却下は 0。NULL は未対応）
  ADD COLUMN IF NOT EXISTS approved_excess integer,
  ADD COLUMN IF NOT EXISTS approved_excess_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_excess_by text,
  -- 確定前の保留理由：excess=上限超過の承認待ち／course=講座の割り当て待ち／attach=添付待ち
  ADD COLUMN IF NOT EXISTS hold_reason text;

COMMENT ON COLUMN petty_cash_transactions.excess_amount IS
  '規程の上限を超えた金額。担当が approved_excess に追加支給額を入れて承認するまで確定しない';
COMMENT ON COLUMN petty_cash_transactions.approved_excess IS
  '担当が承認した追加支給額。0 は「承認しない」。NULL は未対応（保留中）';
COMMENT ON COLUMN petty_cash_transactions.hold_reason IS
  'excess=上限超過の承認待ち／course=講座の割り当て待ち／attach=合格通知の添付待ち。NULL は確定済み';

-- 要対応一覧の絞り込み用
CREATE INDEX IF NOT EXISTS idx_pct_hold
  ON petty_cash_transactions (created_at)
  WHERE category = 'staff_refund' AND hold_reason IS NOT NULL;

-- 講座ごとの上限合算用
CREATE INDEX IF NOT EXISTS idx_pct_course
  ON petty_cash_transactions (staff_member_id, course_id)
  WHERE category = 'staff_refund';

NOTIFY pgrst, 'reload schema';
