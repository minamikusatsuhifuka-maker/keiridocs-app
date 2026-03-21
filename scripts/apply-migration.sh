#!/bin/bash
# スタッフ領収書マイグレーション適用スクリプト
# 使い方: bash scripts/apply-migration.sh
#
# Supabase Dashboard > Project Settings > Database > Connection string > URI
# からDBパスワードを確認してください

set -e

PROJECT_REF="qwyfzsaebyiykafpxgsu"
MIGRATION_FILE="supabase/migrations/012_staff_receipts.sql"
PSQL="/opt/homebrew/opt/libpq/bin/psql"

if [ ! -f "$PSQL" ]; then
  PSQL="psql"
fi

echo "=== Supabase マイグレーション適用 ==="
echo "対象: $MIGRATION_FILE"
echo ""
echo "Supabase Dashboard > Project Settings > Database > Connection string"
echo "からDBパスワードを確認して入力してください。"
echo ""
read -sp "Database Password: " DB_PASSWORD
echo ""

if [ -z "$DB_PASSWORD" ]; then
  echo "パスワードが入力されませんでした。終了します。"
  exit 1
fi

echo "接続中..."
PGPASSWORD="$DB_PASSWORD" "$PSQL" \
  "host=aws-0-ap-northeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.${PROJECT_REF} sslmode=require connect_timeout=10" \
  -f "$MIGRATION_FILE"

echo ""
echo "=== マイグレーション適用完了 ==="
echo "テーブル確認中..."
PGPASSWORD="$DB_PASSWORD" "$PSQL" \
  "host=aws-0-ap-northeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.${PROJECT_REF} sslmode=require connect_timeout=10" \
  -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('staff_members', 'staff_receipts') ORDER BY table_name;"

echo ""
PGPASSWORD="$DB_PASSWORD" "$PSQL" \
  "host=aws-0-ap-northeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.${PROJECT_REF} sslmode=require connect_timeout=10" \
  -c "SELECT id, name, created_at FROM staff_members ORDER BY created_at;"
