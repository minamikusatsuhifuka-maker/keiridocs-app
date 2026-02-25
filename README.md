# keiridocs - 経理書類管理アプリ

小規模事業向けの経理書類管理 Web アプリケーション。書類の撮影・アップロード・メール取込から、AI による自動解析、Dropbox への保存、通知まで一括管理できます。

## 技術スタック

- **フレームワーク**: Next.js 15 (App Router, Server Components)
- **言語**: TypeScript (strict mode)
- **UI**: shadcn/ui + Tailwind CSS
- **DB**: Supabase (PostgreSQL)
- **認証**: Supabase Auth (Google OAuth)
- **ファイル保存**: Dropbox API v2
- **AI解析**: Google Gemini 2.5 Flash (書類OCR)
- **メール通知**: Resend
- **メール取込**: Gmail API
- **PDF生成**: pdf-lib
- **デプロイ**: Vercel

## 主な機能

- **書類登録**: カメラ撮影・ファイルアップロード・メール取込の3つの入力経路
- **AI自動解析**: Gemini AI による書類のOCR（取引先名・金額・日付等を自動抽出）
- **書類管理**: 一覧表示・検索・フィルタ・ソート・ステータス管理
- **Dropbox連携**: 書類ファイルの自動保存・月別フォルダ構造
- **メール取込**: Gmail から添付ファイルを自動取得・承認ワークフロー
- **通知機能**: 支払期限アラート・月末サマリー・未承認メール通知
- **ダッシュボード**: 統計情報・期限アラート・月別チャート

## セットアップ

### 前提条件

- Node.js 18 以上
- npm
- Supabase プロジェクト
- Dropbox アプリ
- Google Cloud プロジェクト（Gemini API, Gmail API）
- Resend アカウント

### インストール

```bash
git clone <repository-url>
cd keiridocs-app
npm install
```

### 環境変数

`.env.local` を作成し、以下の環境変数を設定してください。

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Google Gemini AI
GEMINI_API_KEY=your-gemini-api-key

# Dropbox
DROPBOX_ACCESS_TOKEN=your-dropbox-access-token
DROPBOX_ROOT_FOLDER=/経理書類

# Gmail
GMAIL_CLIENT_ID=your-gmail-client-id
GMAIL_CLIENT_SECRET=your-gmail-client-secret
GMAIL_REFRESH_TOKEN=your-gmail-refresh-token

# Resend (メール通知)
RESEND_API_KEY=your-resend-api-key
RESEND_FROM_EMAIL=経理書類管理 <noreply@yourdomain.com>
```

### データベースセットアップ

Supabase にマイグレーションを適用します。

```bash
npm run db:migrate
```

型定義を生成します。

```bash
npm run db:types
```

## 開発コマンド

```bash
# 開発サーバー起動
npm run dev

# 本番ビルド
npm run build

# 本番サーバー起動
npm start

# ESLint
npm run lint

# テスト
npm test

# DBマイグレーション適用
npm run db:migrate

# Supabase型定義生成
npm run db:types
```

## デプロイ

### Vercel

1. [Vercel](https://vercel.com) にリポジトリを接続
2. 環境変数を Vercel のプロジェクト設定に追加
3. デプロイ実行（`main` ブランチへの push で自動デプロイ）

### 環境変数の注意点

- `NEXT_PUBLIC_` プレフィックスの変数はクライアントサイドに公開されます
- `SUPABASE_SERVICE_ROLE_KEY` はサーバーサイドのみで使用してください
- `.env.local` は Git 管理外です。本番環境では Vercel の環境変数設定を使用してください

## ディレクトリ構成

```
src/
├── app/              # Next.js App Router (ページ・APIルート)
├── components/       # React コンポーネント
│   ├── ui/           # shadcn/ui コンポーネント
│   ├── layout/       # レイアウト (サイドバー・ヘッダー)
│   ├── documents/    # 書類関連
│   ├── dashboard/    # ダッシュボード
│   ├── mail/         # メール関連
│   └── settings/     # 設定関連
├── lib/              # ユーティリティ・API連携
│   ├── supabase/     # Supabase クライアント
│   ├── dropbox.ts    # Dropbox API
│   ├── gemini.ts     # Gemini AI
│   ├── gmail.ts      # Gmail API
│   ├── resend.ts     # メール通知
│   └── pdf.ts        # PDF生成
├── types/            # TypeScript型定義
└── hooks/            # React カスタムフック
```

## ライセンス

Private
