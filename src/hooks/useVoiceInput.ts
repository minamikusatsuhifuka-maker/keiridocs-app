"use client"

import { useState, useRef, useCallback, useEffect } from "react"

interface UseVoiceInputReturn {
  /** 録音中かどうか */
  isRecording: boolean
  /** 書き起こし処理中かどうか */
  isProcessing: boolean
  /** 録音秒数 */
  recordingSeconds: number
  /** 音声レベル（0-1） */
  audioLevel: number
  /** 録音開始 */
  startRecording: () => Promise<void>
  /** 録音停止（書き起こしなし） */
  stopRecording: () => void
  /** 録音停止して書き起こしテキストを返す */
  stopAndTranscribe: () => Promise<string | null>
}

/** ブラウザがサポートするMIMEタイプを検出 */
function getSupportedMimeType(): string {
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ]
  for (const type of types) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) {
      return type
    }
  }
  return "audio/webm"
}

/**
 * 音声入力フック
 * MediaRecorder APIで録音し、Gemini AIで書き起こす
 */
export function useVoiceInput(): UseVoiceInputReturn {
  const [isRecording, setIsRecording] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [audioLevel, setAudioLevel] = useState(0)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animFrameRef = useRef<number | null>(null)
  const mimeTypeRef = useRef(getSupportedMimeType())

  // 音声レベルの監視
  const startAudioLevelMonitor = useCallback((stream: MediaStream) => {
    try {
      const audioContext = new AudioContext()
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      analyserRef.current = analyser

      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      const updateLevel = () => {
        analyser.getByteFrequencyData(dataArray)
        const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length
        setAudioLevel(Math.min(1, average / 128))
        animFrameRef.current = requestAnimationFrame(updateLevel)
      }
      updateLevel()
    } catch {
      // Web Audio APIが使えない場合は無視
    }
  }, [])

  // クリーンアップ
  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    analyserRef.current = null
    setAudioLevel(0)
    setRecordingSeconds(0)
  }, [])

  // コンポーネントアンマウント時のクリーンアップ
  useEffect(() => {
    return () => {
      cleanup()
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop()
      }
    }
  }, [cleanup])

  // 録音開始
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const mimeType = mimeTypeRef.current
      const recorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data)
        }
      }

      recorder.start(100) // 100msごとにデータを取得
      setIsRecording(true)
      setRecordingSeconds(0)

      // 録音タイマー
      timerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1)
      }, 1000)

      // 音声レベル監視
      startAudioLevelMonitor(stream)
    } catch (error) {
      console.error("マイクへのアクセスに失敗:", error)
      cleanup()
    }
  }, [cleanup, startAudioLevelMonitor])

  // 録音停止（書き起こしなし）
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop()
    }
    setIsRecording(false)
    cleanup()
  }, [cleanup])

  // 録音停止して書き起こしテキストを返す
  const stopAndTranscribe = useCallback(async (): Promise<string | null> => {
    if (!mediaRecorderRef.current || !isRecording) return null

    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current!
      const mimeType = recorder.mimeType || "audio/webm"

      recorder.onstop = async () => {
        setIsProcessing(true)
        try {
          const blob = new Blob(chunksRef.current, { type: mimeType })
          const formData = new FormData()
          const ext = mimeType.includes("mp4") ? "mp4" : "webm"
          formData.append("audio", blob, `recording.${ext}`)

          const res = await fetch("/api/speech-to-text", {
            method: "POST",
            body: formData,
          })
          const data = (await res.json()) as { text?: string; error?: string }
          resolve(data.text?.trim() || null)
        } catch {
          resolve(null)
        } finally {
          setIsProcessing(false)
        }
      }

      recorder.stop()
      setIsRecording(false)
      cleanup()
    })
  }, [isRecording, cleanup])

  return {
    isRecording,
    isProcessing,
    recordingSeconds,
    audioLevel,
    startRecording,
    stopRecording,
    stopAndTranscribe,
  }
}
