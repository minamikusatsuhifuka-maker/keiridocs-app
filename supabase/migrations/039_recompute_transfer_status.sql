-- 039: 要振込マーク（documents.status = '要振込'）を「都度振込のみ」の基準で再計算する
--
-- 背景:
--   以前の実装では「支払方法＝要確認（未確定）」も安全側で要振込に含めていたため、
--   口座振替で支払済みのものや判定が付かないものまで要振込に溜まっていた。
--   要振込の定義を「種別=請求書 かつ 支払方法カテゴリ=都度振込 かつ 未払い」に統一する。
--
-- 支払方法カテゴリの決定順:
--   1) vendor_payment_methods に登録があればそれを優先（都度振込 / 口座振替 / その他）
--   2) 無ければ documents.payment_method から変換
--      bank_transfer → 都度振込 / auto_debit → 口座振替 / credit_card → その他 / それ以外 → 要確認
--
-- ※ Supabase SQL Editor で手動実行すること。
-- ※ 手動の「アーカイブ」ステータスは変更しない。

-- ── STEP 1: 実行前の件数確認（先にこれだけ実行して内訳を確認する） ──────────────
--
-- SELECT
--   COALESCE(
--     (SELECT v.method FROM vendor_payment_methods v WHERE v.vendor_name = d.vendor_name),
--     CASE d.payment_method
--       WHEN 'bank_transfer' THEN '都度振込'
--       WHEN 'auto_debit'    THEN '口座振替'
--       WHEN 'credit_card'   THEN 'その他'
--       ELSE '要確認'
--     END
--   ) AS category,
--   COUNT(*) AS 件数
-- FROM documents d
-- WHERE d.type = '請求書'
--   AND d.status = '要振込'
-- GROUP BY 1
-- ORDER BY 2 DESC;

-- ── STEP 2: 要振込から外す（都度振込ではない／支払い済み のものを 処理済み にする） ──
UPDATE documents d
SET status = '処理済み'
WHERE d.type = '請求書'
  AND d.status = '要振込'
  AND (
    d.payment_status = '支払い済み'
    OR COALESCE(
         (SELECT v.method FROM vendor_payment_methods v WHERE v.vendor_name = d.vendor_name),
         CASE d.payment_method
           WHEN 'bank_transfer' THEN '都度振込'
           WHEN 'auto_debit'    THEN '口座振替'
           WHEN 'credit_card'   THEN 'その他'
           ELSE '要確認'
         END
       ) <> '都度振込'
  );

-- ── STEP 3: 要振込に入れ直す（都度振込かつ未払いなのに処理済みになっているもの） ──
UPDATE documents d
SET status = '要振込'
WHERE d.type = '請求書'
  AND d.status = '処理済み'
  AND COALESCE(d.payment_status, '未対応') <> '支払い済み'
  AND COALESCE(
        (SELECT v.method FROM vendor_payment_methods v WHERE v.vendor_name = d.vendor_name),
        CASE d.payment_method
          WHEN 'bank_transfer' THEN '都度振込'
          WHEN 'auto_debit'    THEN '口座振替'
          WHEN 'credit_card'   THEN 'その他'
          ELSE '要確認'
        END
      ) = '都度振込';

-- ── STEP 4: 実行後の確認 ─────────────────────────────────────────────
--
-- SELECT status, COUNT(*) FROM documents WHERE type = '請求書' GROUP BY 1 ORDER BY 2 DESC;
