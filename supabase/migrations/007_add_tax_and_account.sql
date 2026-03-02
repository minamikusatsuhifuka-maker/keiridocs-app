-- 税区分・勘定科目カラムをdocumentsテーブルに追加
ALTER TABLE documents ADD COLUMN IF NOT EXISTS tax_category TEXT DEFAULT '未判定';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS account_title TEXT DEFAULT '';
