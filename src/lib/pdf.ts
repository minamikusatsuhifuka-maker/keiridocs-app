// PDF結合（pdf-lib）
import { PDFDocument } from "pdf-lib"

/**
 * 複数の画像（JPG/PNG）を1つのPDFに結合する
 * @param images Base64エンコードされた画像データとMIMEタイプの配列
 * @returns 結合されたPDFのバイナリ（Uint8Array）
 */
export async function combineImagesToPdf(
  images: Array<{ base64: string; mimeType: string }>
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create()

  for (const image of images) {
    const imageBytes = Buffer.from(image.base64, "base64")

    let embeddedImage
    if (image.mimeType === "image/png") {
      embeddedImage = await pdfDoc.embedPng(imageBytes)
    } else {
      // JPG/JPEGはすべてembedJpgで処理
      embeddedImage = await pdfDoc.embedJpg(imageBytes)
    }

    // 画像サイズに合わせたページを追加（A4比率を維持しつつ画像を収める）
    const { width, height } = embeddedImage.scale(1)
    const page = pdfDoc.addPage([width, height])
    page.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width,
      height,
    })
  }

  return pdfDoc.save()
}

/**
 * 既存のPDFデータをそのまま返す（単一PDFの場合）
 * 複数PDFの結合にも対応
 */
export async function mergePdfs(
  pdfBuffers: Uint8Array[]
): Promise<Uint8Array> {
  if (pdfBuffers.length === 1) {
    return pdfBuffers[0]
  }

  const mergedDoc = await PDFDocument.create()

  for (const pdfBytes of pdfBuffers) {
    const srcDoc = await PDFDocument.load(pdfBytes)
    const pages = await mergedDoc.copyPages(srcDoc, srcDoc.getPageIndices())
    for (const page of pages) {
      mergedDoc.addPage(page)
    }
  }

  return mergedDoc.save()
}
