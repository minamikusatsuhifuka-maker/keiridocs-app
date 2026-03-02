// Dropbox API ラッパー（fetch API直接呼び出し）

const DROPBOX_API = "https://api.dropboxapi.com/2"
const DROPBOX_CONTENT = "https://content.dropboxapi.com/2"

/* ---------- アクセストークン自動更新 ---------- */
let cachedAccessToken: string | null = null
let tokenExpiresAt: number = 0

async function getValidAccessToken(): Promise<string> {
  // キャッシュが有効ならそれを返す
  if (cachedAccessToken && Date.now() < tokenExpiresAt) {
    return cachedAccessToken
  }

  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN
  const appKey = process.env.DROPBOX_APP_KEY
  const appSecret = process.env.DROPBOX_APP_SECRET

  // Refresh Token がない場合は既存のアクセストークンをそのまま使う
  if (!refreshToken || !appKey || !appSecret) {
    console.warn("Dropbox Refresh Token未設定。既存のアクセストークンを使用します。")
    return process.env.DROPBOX_ACCESS_TOKEN || ""
  }

  // Refresh Token でアクセストークンを更新
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: appKey,
      client_secret: appSecret,
    }),
  })

  if (!res.ok) {
    const errorText = await res.text()
    console.error("Dropbox トークン更新失敗:", errorText)
    // フォールバック: 既存のアクセストークンを試す
    return process.env.DROPBOX_ACCESS_TOKEN || ""
  }

  const data = await res.json()
  cachedAccessToken = data.access_token
  // expires_in（秒）の80%の時点で期限切れとして扱う（安全マージン）
  tokenExpiresAt = Date.now() + (data.expires_in * 800)
  console.log("Dropbox アクセストークン更新成功")
  return cachedAccessToken!
}

/* ---------- 非ASCIIエスケープ ---------- */

/**
 * Dropbox-API-Arg ヘッダー用に非ASCII文字をUnicodeエスケープする
 * （ヘッダーはASCIIのみ対応のため、日本語パスはエスケープが必要）
 */
function escapeNonAscii(str: string): string {
  return str.replace(/[^\x20-\x7E]/g, (char) => {
    const code = char.charCodeAt(0)
    if (code > 0xFFFF) {
      const hi = Math.floor((code - 0x10000) / 0x400) + 0xD800
      const lo = (code - 0x10000) % 0x400 + 0xDC00
      return "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0")
    }
    return "\\u" + code.toString(16).padStart(4, "0")
  })
}

/* ---------- 共通ヘルパー ---------- */

async function dbxPost(endpoint: string, body: Record<string, unknown>) {
  const token = await getValidAccessToken()
  const res = await fetch(`${DROPBOX_API}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Dropbox API error (${endpoint}): ${res.status} ${text}`)
  }
  return res.json()
}

/* ---------- パス生成 ---------- */

/**
 * 書類種別と日付から月別Dropboxパスを生成する
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

/* ---------- フォルダ作成 ---------- */

/**
 * フォルダが存在しなければ作成する
 * 409（既に存在）エラーは無視する
 */
export async function ensureDropboxFolderExists(folderPath: string): Promise<void> {
  try {
    await dbxPost("/files/create_folder_v2", {
      path: folderPath,
      autorename: false,
    })
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes("path/conflict") || msg.includes("409")) return
    throw error
  }
}

/* ---------- アップロード ---------- */

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
  // フォルダ部分を取得して事前に作成
  const folderPath = path.substring(0, path.lastIndexOf("/"))
  if (folderPath) {
    await ensureDropboxFolderExists(folderPath)
  }

  const token = await getValidAccessToken()
  const res = await fetch(`${DROPBOX_CONTENT}/files/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Dropbox-API-Arg": escapeNonAscii(JSON.stringify({
        path,
        mode: "overwrite",
        autorename: false,
      })),
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(contents),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Dropbox upload error: ${res.status} ${text}`)
  }

  const data = await res.json()
  return data.path_display ?? path
}

/* ---------- ダウンロード ---------- */

/**
 * ファイルをDropboxからダウンロードする
 */
export async function downloadFile(path: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const token = await getValidAccessToken()
  const res = await fetch(`${DROPBOX_CONTENT}/files/download`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Dropbox-API-Arg": escapeNonAscii(JSON.stringify({ path })),
    },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Dropbox download error: ${res.status} ${text}`)
  }

  const contentType = res.headers.get("content-type") || "application/octet-stream"
  const arrayBuffer = await res.arrayBuffer()
  return { buffer: Buffer.from(arrayBuffer), mimeType: contentType }
}

/* ---------- コピー ---------- */

/**
 * ファイルをコピーする（copy_v2 API使用、元ファイルは残す）
 */
export async function copyFile(
  fromPath: string,
  toPath: string
): Promise<string> {
  // コピー先フォルダを作成
  const folderPath = toPath.substring(0, toPath.lastIndexOf("/"))
  if (folderPath) {
    await ensureDropboxFolderExists(folderPath)
  }

  const data = await dbxPost("/files/copy_v2", {
    from_path: fromPath,
    to_path: toPath,
    autorename: true,
  })

  return data.metadata?.path_display ?? toPath
}

/* ---------- 移動 ---------- */

/**
 * ファイルを別のパスに移動する
 */
export async function moveFile(
  fromPath: string,
  toPath: string
): Promise<string> {
  // 移動先フォルダを作成
  const folderPath = toPath.substring(0, toPath.lastIndexOf("/"))
  if (folderPath) {
    await ensureDropboxFolderExists(folderPath)
  }

  const data = await dbxPost("/files/move_v2", {
    from_path: fromPath,
    to_path: toPath,
    autorename: false,
  })

  return data.metadata?.path_display ?? toPath
}

/* ---------- CSV作成 ---------- */

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

/* ---------- フォルダ一覧 ---------- */

/**
 * フォルダ内のファイル一覧を取得する
 */
export async function listFiles(path: string): Promise<Array<{
  name: string
  path_display: string
  size: number
  client_modified: string
}>> {
  const entries: Array<{
    name: string
    path_display: string
    size: number
    client_modified: string
  }> = []
  let cursor: string | null = null
  let hasMore = true

  while (hasMore) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any
    if (!cursor) {
      data = await dbxPost("/files/list_folder", {
        path,
        recursive: false,
        include_deleted: false,
      })
    } else {
      data = await dbxPost("/files/list_folder/continue", { cursor })
    }

    for (const entry of data.entries) {
      if (entry[".tag"] === "file") {
        entries.push({
          name: entry.name,
          path_display: entry.path_display,
          size: entry.size,
          client_modified: entry.client_modified,
        })
      }
    }

    hasMore = data.has_more
    cursor = data.cursor
  }

  return entries
}
