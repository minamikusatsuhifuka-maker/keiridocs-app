#!/usr/bin/env node
// スタッフ領収書マイグレーション適用スクリプト
// 使い方: node scripts/apply-migration.js <DB_PASSWORD>
//
// DBパスワードの確認方法:
//   1. https://supabase.com/dashboard にログイン
//   2. プロジェクト選択 → Settings → Database
//   3. Connection string の URI からパスワードを確認

const fs = require("fs")
const path = require("path")

async function main() {
  const password = process.argv[2]
  if (!password) {
    console.error("使い方: node scripts/apply-migration.js <DB_PASSWORD>")
    console.error("")
    console.error("DBパスワードはSupabase Dashboard > Settings > Database で確認できます")
    process.exit(1)
  }

  const projectRef = "qwyfzsaebyiykafpxgsu"
  const migrationFile = path.join(__dirname, "..", "supabase", "migrations", "012_staff_receipts.sql")
  const sql = fs.readFileSync(migrationFile, "utf-8")

  let postgres
  try {
    postgres = require("postgres")
  } catch {
    console.error("postgresパッケージが見つかりません。npm install --no-save postgres を実行してください")
    process.exit(1)
  }

  const db = postgres({
    host: "aws-0-ap-northeast-1.pooler.supabase.com",
    port: 5432,
    database: "postgres",
    username: `postgres.${projectRef}`,
    password,
    ssl: { rejectUnauthorized: false },
    connect_timeout: 15,
  })

  try {
    console.log("接続中...")
    await db`SELECT 1`
    console.log("接続成功")

    console.log("マイグレーション実行中...")
    await db.unsafe(sql)
    console.log("マイグレーション適用完了")

    console.log("\nテーブル確認:")
    const tables = await db`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('staff_members', 'staff_receipts')
      ORDER BY table_name
    `
    tables.forEach((t) => console.log("  ✓", t.table_name))

    console.log("\nスタッフデータ確認:")
    const staff = await db`SELECT id, name, created_at FROM staff_members ORDER BY created_at`
    staff.forEach((s) => console.log(`  - ${s.name} (${s.id})`))

    console.log("\n完了!")
  } catch (err) {
    console.error("エラー:", err.message)
    process.exit(1)
  } finally {
    await db.end()
  }
}

main()
