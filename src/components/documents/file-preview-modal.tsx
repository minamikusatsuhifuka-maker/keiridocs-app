"use client"

// 書類一覧から登録資料（Dropbox実ファイル）をその場で確認するプレビューモーダル。
// 画像・PDF をアプリ内で表示し、フッターから Dropboxウェブでも開ける。

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ExternalLink, Loader2 } from "lucide-react"
import { dropboxFileUrl } from "@/lib/dropbox-web-link"

/** プレビュー対象（previewKind が判定できたファイルのみモーダル表示する） */
export interface FilePreviewTarget {
  /** documents.id（配信APIのパス解決に使う） */
  id: string
  /** documents.dropbox_path（ファイル名表示・Dropboxリンク用） */
  dropboxPath: string
  /** 見出し表示用（取引先名など） */
  title: string
  kind: "image" | "pdf"
}

/**
 * Dropboxパスの拡張子からアプリ内プレビュー可能な種別を判定する。
 * プレビューできない形式（CSV等）は null（＝Dropboxウェブを新しいタブで開く）。
 */
export function previewKind(path: string): "image" | "pdf" | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  if (["jpg", "jpeg", "png"].includes(ext)) return "image"
  if (ext === "pdf") return "pdf"
  return null
}

interface FilePreviewModalProps {
  target: FilePreviewTarget | null
  onClose: () => void
}

export function FilePreviewModal({ target, onClose }: FilePreviewModalProps) {
  // 読み込み中スピナー（画像/PDFのロード完了で消す）
  const [loaded, setLoaded] = useState(false)

  const fileName = target ? target.dropboxPath.slice(target.dropboxPath.lastIndexOf("/") + 1) : ""
  const fileUrl = target ? `/api/documents/${target.id}/file` : ""

  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) {
          setLoaded(false)
          onClose()
        }
      }}
    >
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="pr-8 truncate">{target?.title}</DialogTitle>
          <DialogDescription className="truncate">{fileName}</DialogDescription>
        </DialogHeader>
        {target && (
          <div className="relative min-h-[300px] flex-1 overflow-auto rounded-md border bg-muted/30">
            {!loaded && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            )}
            {target.kind === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element -- 認証付きAPI経由の動的画像のため next/image は使わない
              <img
                src={fileUrl}
                alt={fileName}
                className="mx-auto max-w-full"
                onLoad={() => setLoaded(true)}
                onError={() => setLoaded(true)}
              />
            ) : (
              <iframe
                src={fileUrl}
                title={fileName}
                className="h-[70vh] w-full"
                onLoad={() => setLoaded(true)}
              />
            )}
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="outline" size="sm" asChild>
            <a
              href={target ? dropboxFileUrl(target.dropboxPath) : "#"}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="size-3.5" />
              Dropboxで開く
            </a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
