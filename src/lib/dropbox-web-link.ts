// Dropboxウェブ（www.dropbox.com）で該当フォルダ/ファイルを開くURLを生成するヘルパー
// サーバー（xlsxのHYPERLINK）・クライアント（実行履歴画面のリンク）の両方から使う

/** パスをDropboxウェブURL用にエンコードする（スラッシュは保持） */
function encodeDropboxPath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")
}

/** フォルダパスをDropboxウェブで開くURL（例: /経理書類/税理士提出/2026年07月） */
export function dropboxFolderUrl(folderPath: string): string {
  return `https://www.dropbox.com/home${encodeDropboxPath(folderPath)}`
}

/**
 * ファイルパスからDropboxウェブURLを生成する。
 * 親フォルダを開き、?preview= で該当ファイルをプレビュー表示する。
 */
export function dropboxFileUrl(filePath: string): string {
  const idx = filePath.lastIndexOf("/")
  if (idx <= 0) return dropboxFolderUrl(filePath)
  const folder = filePath.slice(0, idx)
  const fileName = filePath.slice(idx + 1)
  return `${dropboxFolderUrl(folder)}?preview=${encodeURIComponent(fileName)}`
}
