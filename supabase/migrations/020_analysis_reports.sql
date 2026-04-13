-- 分析レポート保存テーブル
-- ダッシュボードの月次分析データを保存し、AIによる改善提案を記録する

CREATE TABLE IF NOT EXISTS analysis_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  year integer NOT NULL,
  month integer NOT NULL,
  total_amount numeric NOT NULL DEFAULT 0,
  doc_count integer NOT NULL DEFAULT 0,
  category_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  weekly_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_summary text,
  ai_suggestions jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE analysis_reports IS '月次分析レポート（ダッシュボード集計のスナップショット）';
COMMENT ON COLUMN analysis_reports.category_breakdown IS 'カテゴリ別金額集計 [{name,value}, ...]';
COMMENT ON COLUMN analysis_reports.weekly_breakdown IS '週別金額推移 [{week,amount}, ...]';
COMMENT ON COLUMN analysis_reports.ai_summary IS 'AI生成のサマリーテキスト';
COMMENT ON COLUMN analysis_reports.ai_suggestions IS 'AI改善提案 [{title,description,priority,expected_effect}, ...]';

CREATE INDEX IF NOT EXISTS idx_analysis_reports_year_month
  ON analysis_reports(year DESC, month DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_reports_created_at
  ON analysis_reports(created_at DESC);

-- RLS: 全操作可
ALTER TABLE analysis_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "analysis_reports_select_all" ON analysis_reports;
CREATE POLICY "analysis_reports_select_all" ON analysis_reports
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "analysis_reports_insert_all" ON analysis_reports;
CREATE POLICY "analysis_reports_insert_all" ON analysis_reports
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "analysis_reports_update_all" ON analysis_reports;
CREATE POLICY "analysis_reports_update_all" ON analysis_reports
  FOR UPDATE USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "analysis_reports_delete_all" ON analysis_reports;
CREATE POLICY "analysis_reports_delete_all" ON analysis_reports
  FOR DELETE USING (true);
