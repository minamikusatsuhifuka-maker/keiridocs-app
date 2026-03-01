// Dropbox API ラッパー
import { Dropbox } from "dropbox"

/** Dropboxクライアントを取得 */
function getClient(): Dropbox {
  const accessToken = process.env.DROPBOX_ACCESS_TOKEN
  if (!accessToken) {
    throw new Error("DROPBOX_ACCESS_TOKEN が設定されていません")
  }
  return new Dropbox({ accessToken })
}

/**
 * 書類種別と日付から月別Dropboxパスを生成する
 * CLAUDE.mdのフォルダ構造に準拠:
 *   /経理書類/請求書/2026年/03月/未処理/filename.pdf
 *   /経理書類/契約書/filename.pdf（月別なし）
 */
export function getDocumentPath(
  type: string,
  fileName: string,
  date: Date,
  status: string = "未処理"
): string {
  const base = "/経理書類"

  // 契約書は月別分類なし
  if (type === "契約書") {
    return `${base}/契約書/${fileName}`
  }

  const year = `${date.getFullYear()}年`
  const month = `${String(date.getMonth() + 1).padStart(2, "0")}月`

  return `${base}/${type}/${year}/${month}/${status}/${fileName}`
}

/**
 * フォルダが存在しなければ階層的に作成する
 * Dropbox APIはcreate_folder時に親が無くても再帰的に作成するため、
 * 409（既に存在）エラーは無視する
 */
export async function ensureDropboxFolderExists(folderPath: string): Promise<void> {
  const dbx = getClient()

  try {
    await dbx.filesCreateFolderV2({
      path: folderPath,
      autorename: false,
    })
  } catch (error: unknown) {
    // フォルダが既に存在する場合はエラーを無視
    const err = error as { status?: number; error?: { error_summary?: string } }
    if (err.status === 409 || err.error?.error_summary?.includes("path/conflict")) {
      return
    }
    throw error
  }
}

/**
 * ファイルをDropboxにアップロードする
 * @param path Dropbox上のファイルパス
 * @param contents ファイルデータ（Buffer）
 * @returns アップロードされたファイルのパス
 */
export async function uploadFile(
  path: string,
  contents: Buffer
): Promise<string> {
  const dbx = getClient()

  // フォルダ部分を取得して事前に作成
  const folderPath = path.substring(0, path.lastIndexOf("/"))
  if (folderPath) {
    await ensureDropboxFolderExists(folderPath)
  }

  // Rate Limit対策: 50ms待機
  await new Promise((resolve) => setTimeout(resolve, 50))

  const result = await dbx.filesUpload({
    path,
    contents,
    mode: { ".tag": "overwrite" },
    autorename: false,
  })

  return result.result.path_display ?? path
}

/**
 * ファイルをコピーする（copy_v2 API使用、元ファイルは残す）
 * @param fromPath コピー元パス
 * @param toPath コピー先パス
 * @returns コピー先のファイルパス
 */
export async function copyFile(
  fromPath: string,
  toPath: string
): Promise<string> {
  const dbx = getClient()

  // コピー先フォルダを作成
  const folderPath = toPath.substring(0, toPath.lastIndexOf("/"))
  if (folderPath) {
    await ensureDropboxFolderExists(folderPath)
  }

  // Rate Limit対策: 50ms待機
  await new Promise((resolve) => setTimeout(resolve, 50))

  const result = await dbx.filesCopyV2({
    from_path: fromPath,
    to_path: toPath,
    autorename: true,
  })

  const metadata = result.result.metadata
  if ("path_display" in metadata) {
    return metadata.path_display ?? toPath
  }
  return toPath
}

/**
 * CSVファイルをDropboxに直接作成する（upload API使用）
 * @param path Dropbox上のファイルパス
 * @param content CSV文字列
 * @returns アップロードされたファイルのパス
 */
export async function createCsvInDropbox(
  path: string,
  content: string
): Promise<string> {
  // BOM付きUTF-8でExcelでの文字化けを防ぐ
  const bom = "\uFEFF"
  const buffer = Buffer.from(bom + content, "utf-8")
  return uploadFile(path, buffer)
}

/**
 * ファイルを別のパスに移動する
 */
export async function moveFile(
  fromPath: string,
  toPath: string
): Promise<string> {
  const dbx = getClient()

  // 移動先フォルダを作成
  const folderPath = toPath.substring(0, toPath.lastIndexOf("/"))
  if (folderPath) {
    await ensureDropboxFolderExists(folderPath)
  }

  await new Promise((resolve) => setTimeout(resolve, 50))

  const result = await dbx.filesMoveV2({
    from_path: fromPath,
    to_path: toPath,
    autorename: false,
  })

  const metadata = result.result.metadata
  if ("path_display" in metadata) {
    return metadata.path_display ?? toPath
  }
  return toPath
}
