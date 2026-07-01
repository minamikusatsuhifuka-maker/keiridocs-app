-- 038_tax_folder_copy_runs.sql
-- 税理士フォルダへの一括コピー（単月/期間指定コピー・追加分の一括取り込み）の
-- 実行履歴を記録し、アプリ画面から後から見返せるようにする。
-- 書き込みはサービスロールキー経由（RLSバイパス）のためINSERTポリシーは設けない。

CREATE TABLE IF NOT EXISTS tax_folder_copy_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at         timestamptz NOT NULL DEFAULT now(),
  run_by         text,
  run_type       text NOT NULL,
  period_start   text NOT NULL,
  period_end     text NOT NULL,
  target_folders text[] NOT NULL DEFAULT '{}',
  summary        jsonb NOT NULL,
  issues         jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE tax_folder_copy_runs IS
  '税理士フォルダ一括コピーの実行履歴（何を・いつ・どこへコピーしたかの記録）';
COMMENT ON COLUMN tax_folder_copy_runs.run_type IS
  'range_copy=単月/期間指定コピー, additional_import=追加分の一括取り込み';
COMMENT ON COLUMN tax_folder_copy_runs.period_start IS '対象期間の開始年月（YYYY-MM）';
COMMENT ON COLUMN tax_folder_copy_runs.period_end IS '対象期間の終了年月（YYYY-MM）。単月はstartと同値';
COMMENT ON COLUMN tax_folder_copy_runs.summary IS
  '月別・フォルダ別のコピー/スキップ/失敗件数（run_typeにより構造が異なる）';
COMMENT ON COLUMN tax_folder_copy_runs.issues IS
  '失敗・要確認の一覧 [{file_name, reason, ...}, ...]（無ければnull）';

CREATE INDEX IF NOT EXISTS idx_tax_folder_copy_runs_run_at
  ON tax_folder_copy_runs(run_at DESC);

-- RLS: 閲覧はアプリ内で誰でも可。書込はサービスロール経由のためポリシー不要。
ALTER TABLE tax_folder_copy_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tax_folder_copy_runs_select" ON tax_folder_copy_runs;
CREATE POLICY "tax_folder_copy_runs_select" ON tax_folder_copy_runs
  FOR SELECT USING (true);
