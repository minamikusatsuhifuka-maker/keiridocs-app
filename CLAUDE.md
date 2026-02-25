# 経理書類管理アプリ — CLAUDE.md

## プロジェクト概要
- **名前**: keiridocs（経理書類管理）
- **種別**: 経理書類管理 Web アプリ（GASアプリからの移行版）
- **スタック**: Next.js 15 (App Router) + TypeScript + Supabase + Dropbox API + Gemini AI
- **対象ユーザー**: 小規模事業の経理担当者（日本語UI）

## 技術スタック
- **フレームワーク**: Next.js 15 (App Router, Server Components)
- **言語**: TypeScript（strict mode）
- **UI**: shadcn/ui + Tailwind CSS
- **DB**: Supabase (PostgreSQL)
- **認証**: Supabase Auth (Google OAuth)
- **ファイル保存**: Dropbox API v2
- **AI**: Google Gemini 2.5 Flash（書類OCR）
- **メール通知**: Resend
- **メール取込**: Gmail API
- **PDF生成**: pdf-lib
- **デプロイ**: Vercel
- **パッケージマネージャー**: npm

## コマンド
- `npm run dev` — 開発サーバー起動 (http://localhost:3000)
- `npm run build` — 本番ビルド
- `npm run lint` — ESLint実行
- `npm test` — テスト実行
- `npm run db:migrate` — DBマイグレーション適用
- `npm run db:types` — Supabase型定義生成

## ディレクトリ構成

```
keiridocs-app/
├── CLAUDE.md                    # このファイル
├── .claude/
│   └── commands/                # カスタムスラッシュコマンド
│       ├── new-feature.md
│       ├── fix-bug.md
│       ├── add-page.md
│       └── db-migrate.md
├── .mcp.json                    # MCP設定
├── .env.local                   # 環境変数（Git管理外）
├── src/
│   ├── app/                     # Next.js App Router
│   │   ├── layout.tsx           # ルートレイアウト
│   │   ├── page.tsx             # ダッシュボード（/）
│   │   ├── login/
│   │   │   └── page.tsx         # ログイン画面
│   │   ├── documents/
│   │   │   ├── page.tsx         # 書類一覧
│   │   │   ├── new/
│   │   │   │   └── page.tsx     # 書類登録
│   │   │   └── [id]/
│   │   │       └── page.tsx     # 書類詳細
│   │   ├── mail/
│   │   │   └── page.tsx         # メール確認・承認
│   │   ├── settings/
│   │   │   └── page.tsx         # 設定画面
│   │   └── api/
│   │       ├── documents/
│   │       │   └── route.ts     # 書類CRUD
│   │       ├── dropbox/
│   │       │   ├── upload/
│   │       │   │   └── route.ts # Dropboxアップロード
│   │       │   ├── download/
│   │       │   │   └── route.ts # Dropboxダウンロード
│   │       │   └── folders/
│   │       │       └── route.ts # フォルダ作成・一覧
│   │       ├── gemini/
│   │       │   └── route.ts     # AI解析
│   │       ├── mail/
│   │       │   ├── fetch/
│   │       │   │   └── route.ts # メール取込
│   │       │   └── approve/
│   │       │       └── route.ts # 承認・却下
│   │       ├── notify/
│   │       │   └── route.ts     # 通知送信
│   │       └── settings/
│   │           └── route.ts     # 設定CRUD
│   ├── components/
│   │   ├── ui/                  # shadcn/ui コンポーネント
│   │   ├── layout/
│   │   │   ├── sidebar.tsx      # サイドバーナビ
│   │   │   ├── header.tsx       # ヘッダー
│   │   │   └── mobile-nav.tsx   # モバイルナビ
│   │   ├── documents/
│   │   │   ├── document-table.tsx
│   │   │   ├── document-form.tsx
│   │   │   ├── camera-capture.tsx
│   │   │   ├── file-dropzone.tsx
│   │   │   ├── ocr-result-editor.tsx
│   │   │   └── status-badge.tsx
│   │   ├── dashboard/
│   │   │   ├── stats-cards.tsx
│   │   │   ├── due-alerts.tsx
│   │   │   └── monthly-chart.tsx
│   │   ├── mail/
│   │   │   ├── mail-list.tsx
│   │   │   └── approve-dialog.tsx
│   │   └── settings/
│   │       ├── sender-list.tsx
│   │       ├── notify-list.tsx
│   │       └── folder-settings.tsx
│   ├── lib/
│   │   ├── supabase/
│   │   │   ├── client.ts        # ブラウザ用クライアント
│   │   │   ├── server.ts        # サーバー用クライアント
│   │   │   └── middleware.ts    # 認証ミドルウェア
│   │   ├── dropbox.ts           # Dropbox API ラッパー
│   │   ├── gemini.ts            # Gemini API ラッパー
│   │   ├── gmail.ts             # Gmail API ラッパー
│   │   ├── resend.ts            # メール送信
│   │   ├── pdf.ts               # PDF結合
│   │   └── utils.ts             # ユーティリティ
│   ├── types/
│   │   ├── database.ts          # Supabase自動生成型
│   │   └── index.ts             # アプリ固有の型
│   └── hooks/
│       ├── use-documents.ts
│       ├── use-settings.ts
│       └── use-auth.ts
├── supabase/
│   └── migrations/
│       └── 001_initial.sql      # 初期スキーマ
├── public/
│   └── icons/
├── next.config.ts
├── tailwind.config.ts
├── tsconfig.json
└── package.json
```

## DBスキーマ（Supabase PostgreSQL）

### documents（書類マスタ）
| カラム | 型 | 説明 |
|---|---|---|
| id | uuid (PK) | 自動生成 |
| type | text | 種別（請求書/領収書/契約書/カスタム） |
| vendor_name | text | 取引先名 |
| amount | numeric | 金額 |
| issue_date | date | 発行日 |
| due_date | date | 支払期日 |
| description | text | 摘要 |
| input_method | text | 入力経路（camera/upload/email） |
| status | text | ステータス（未処理/処理済み/アーカイブ） |
| dropbox_path | text | Dropboxファイルパス |
| thumbnail_url | text | サムネイル |
| ocr_raw | jsonb | AI解析の生データ |
| user_id | uuid (FK) | users.id |
| created_at | timestamptz | 登録日時 |
| updated_at | timestamptz | 更新日時 |

### mail_pending（メール未承認）
| カラム | 型 | 説明 |
|---|---|---|
| id | uuid (PK) | 自動生成 |
| file_name | text | ファイル名 |
| sender | text | 差出人 |
| received_at | timestamptz | 受信日時 |
| ai_type | text | AI判定種別 |
| ai_confidence | numeric | AI判定確信度 |
| temp_path | text | 一時保存パス |
| status | text | pending/approved/rejected |
| user_id | uuid (FK) | users.id |
| created_at | timestamptz | 登録日時 |

### settings（設定）
| カラム | 型 | 説明 |
|---|---|---|
| id | uuid (PK) | 自動生成 |
| key | text (unique) | 設定キー |
| value | jsonb | 設定値 |
| user_id | uuid (FK) | users.id |
| updated_at | timestamptz | 更新日時 |

### allowed_senders（許可送信元）
| カラム | 型 | 説明 |
|---|---|---|
| id | uuid (PK) | 自動生成 |
| email | text | メールアドレス |
| display_name | text | 表示名 |
| user_id | uuid (FK) | users.id |

### notify_recipients（通知先）
| カラム | 型 | 説明 |
|---|---|---|
| id | uuid (PK) | 自動生成 |
| email | text | メールアドレス |
| display_name | text | 表示名 |
| user_id | uuid (FK) | users.id |

### custom_folders（カスタムフォルダ）
| カラム | 型 | 説明 |
|---|---|---|
| id | uuid (PK) | 自動生成 |
| name | text | フォルダ名 |
| monthly | boolean | 月別分類 |
| status_split | boolean | ステータス分類 |
| date_field | text | 基準日（issueDate/dueDate/createdAt） |
| user_id | uuid (FK) | users.id |

## コードスタイル規約

### TypeScript
- **strict mode 必須**（noImplicitAny, strictNullChecks）
- 関数コンポーネントのみ使用（classコンポーネントは禁止）
- 型定義は `src/types/` に集約
- `any` 型の使用禁止（`unknown` を使うこと）
- エラーハンドリングは try-catch + 適切なエラーメッセージ

### React / Next.js
- Server Components をデフォルトで使用
- クライアントコンポーネントは `"use client"` を明示
- データフェッチは Server Components または Server Actions で行う
- 状態管理は React hooks のみ（外部ライブラリ不要）

### UI
- shadcn/ui コンポーネントを優先使用
- Tailwind CSS でスタイリング（インラインstyle禁止）
- レスポンシブ対応必須（mobile-first）
- 日本語UI（ラベル・プレースホルダー・エラーメッセージすべて日本語）
- カラーテーマは shadcn のデフォルト（カスタマイズは設定ファイルで）

### API Routes
- すべて `src/app/api/` 配下
- エラーレスポンスは `{ error: string }` 形式で統一
- 認証チェックを必ず入れる
- レスポンスは `NextResponse.json()` を使用

### コメント
- コメントは日本語で書く
- 複雑なロジックには必ずコメントを付ける
- JSDocコメントは関数の上に書く

## Dropbox月別フォルダ構造

```
/経理書類/
├── 請求書/
│   └── 2026年/
│       └── 03月/
│           ├── 未処理/
│           └── 処理済み/
├── 領収書/
│   └── 2026年/
│       └── 03月/
├── 契約書/
│   （月別なし）
└── 一時保存/
    （メール取込の一時保存先）
```

- フォルダは書類登録時に自動作成（ensureDropboxFolderExists）
- 月別基準日はカスタムフォルダ設定による

## 環境変数（.env.local）
- **絶対に .env.local を変更しないこと**
- **絶対に .env.local の値をコードにハードコードしないこと**
- 環境変数は `process.env.XXX` で参照
- クライアントサイドは `NEXT_PUBLIC_` プレフィックスのみ

## 注意事項
- `/src/lib/` 内のAPI連携ファイルは慎重に扱うこと
- Supabaseのサービスロールキーはサーバーサイドのみで使用
- Dropbox API Rate Limit: リクエスト間に50ms以上のインターバル
- Gemini APIの応答は JSON パースし、失敗時はフォールバック値を使用
- ファイルアップロードの最大サイズ: 10MB
- 画像形式: JPG, JPEG, PNG, PDF をサポート
