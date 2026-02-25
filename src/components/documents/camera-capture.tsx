"use client"

import { useRef, useState, useCallback, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Camera, RotateCcw, X, Trash2 } from "lucide-react"

interface CapturedImage {
  base64: string
  mimeType: string
  thumbnail: string
}

interface CameraCaptureProps {
  onCapture: (images: CapturedImage[]) => void
  images: CapturedImage[]
}

// カメラ撮影コンポーネント
export function CameraCapture({ onCapture, images }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [isCameraActive, setIsCameraActive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // カメラを起動する
  const startCamera = useCallback(async () => {
    setError(null)
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          // モバイル背面カメラ優先
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      })

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream
      }
      setStream(mediaStream)
      setIsCameraActive(true)
    } catch {
      setError("カメラを起動できません。カメラへのアクセスを許可してください。")
    }
  }, [])

  // カメラを停止する
  const stopCamera = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop())
      setStream(null)
    }
    setIsCameraActive(false)
  }, [stream])

  // コンポーネントのアンマウント時にカメラを停止
  useEffect(() => {
    return () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop())
      }
    }
  }, [stream])

  // 撮影する
  const capturePhoto = useCallback(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    ctx.drawImage(video, 0, 0)

    // JPEG形式でBase64エンコード
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9)
    const base64 = dataUrl.split(",")[1]

    // サムネイル用に縮小
    const thumbCanvas = document.createElement("canvas")
    const thumbSize = 200
    const aspectRatio = video.videoWidth / video.videoHeight
    thumbCanvas.width = thumbSize
    thumbCanvas.height = thumbSize / aspectRatio
    const thumbCtx = thumbCanvas.getContext("2d")
    if (thumbCtx) {
      thumbCtx.drawImage(video, 0, 0, thumbCanvas.width, thumbCanvas.height)
    }
    const thumbnail = thumbCanvas.toDataURL("image/jpeg", 0.5)

    const newImage: CapturedImage = {
      base64,
      mimeType: "image/jpeg",
      thumbnail,
    }

    onCapture([...images, newImage])
  }, [images, onCapture])

  // 画像を削除する
  const removeImage = useCallback(
    (index: number) => {
      const newImages = images.filter((_, i) => i !== index)
      onCapture(newImages)
    },
    [images, onCapture]
  )

  return (
    <div className="space-y-4">
      {/* カメラビュー */}
      {isCameraActive ? (
        <div className="space-y-3">
          <div className="relative overflow-hidden rounded-lg border bg-black">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full"
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={capturePhoto} className="flex-1">
              <Camera className="mr-2 size-4" />
              撮影
            </Button>
            <Button variant="outline" onClick={stopCamera}>
              <X className="mr-2 size-4" />
              閉じる
            </Button>
          </div>
        </div>
      ) : (
        <Button onClick={startCamera} variant="outline" className="w-full h-32">
          <div className="flex flex-col items-center gap-2">
            <Camera className="size-8" />
            <span>カメラを起動</span>
          </div>
        </Button>
      )}

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {/* 撮影済み画像のプレビュー */}
      {images.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">
              撮影済み: {images.length}枚
            </p>
            {images.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onCapture([])}
              >
                <RotateCcw className="mr-1 size-3" />
                すべて削除
              </Button>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {images.map((img, idx) => (
              <div key={idx} className="group relative overflow-hidden rounded-md border">
                <img
                  src={img.thumbnail}
                  alt={`撮影 ${idx + 1}`}
                  className="aspect-[4/3] w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeImage(idx)}
                  className="absolute top-1 right-1 rounded-full bg-black/60 p-1 opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <Trash2 className="size-3 text-white" />
                </button>
                <span className="absolute bottom-0 left-0 right-0 bg-black/50 py-0.5 text-center text-xs text-white">
                  {idx + 1}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 非表示のcanvas（撮影用） */}
      <canvas ref={canvasRef} className="hidden" />
    </div>
  )
}
