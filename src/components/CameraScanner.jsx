import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, RefreshCw, X } from 'lucide-react'
import { cameraErrorMessage, createBarcodeDecoder, normalizeAuthCode } from '../utils/cameraScanner'

const channelLabel = { wechat: '微信', alipay: '支付宝' }

export default function CameraScanner({ channel, onDetected, onCancel, decoderFactory = createBarcodeDecoder }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const decoderRef = useRef(null)
  const controlsRef = useRef(null)
  const handledRef = useRef(false)
  const activeRef = useRef(true)
  const onDetectedRef = useRef(onDetected)
  onDetectedRef.current = onDetected
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState('starting')
  const [message, setMessage] = useState('正在启动后置摄像头…')

  const releaseCamera = useCallback(() => {
    controlsRef.current?.stop?.()
    controlsRef.current = null
    decoderRef.current?.stop?.()
    decoderRef.current = null
    for (const track of streamRef.current?.getTracks?.() || []) track.stop()
    streamRef.current = null
    const video = videoRef.current
    if (video) {
      video.pause?.()
      video.srcObject = null
    }
  }, [])

  const retry = useCallback(() => {
    activeRef.current = false
    releaseCamera()
    handledRef.current = false
    setPhase('starting')
    setMessage('正在重新启动后置摄像头…')
    setAttempt((value) => value + 1)
  }, [releaseCamera])

  useEffect(() => {
    activeRef.current = true
    let cancelled = false
    let hintTimer = 0

    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          const error = new Error('getUserMedia unavailable')
          error.name = window.isSecureContext ? 'NotFoundError' : 'SecurityError'
          throw error
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        })
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop()
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (!video) throw new Error('video element unavailable')
        video.srcObject = stream
        await video.play()

        const decoder = await decoderFactory()
        if (cancelled) {
          decoder.stop?.()
          releaseCamera()
          return
        }
        decoderRef.current = decoder
        setPhase('scanning')
        setMessage('请将顾客付款码对准扫描框')
        hintTimer = window.setTimeout(() => {
          if (activeRef.current && !handledRef.current) setMessage('暂未识别，请保持付款码完整、清晰并避免反光。')
        }, 12000)

        const controls = await decoder.start({
          stream,
          video,
          onResult: (rawValue) => {
            if (cancelled || !activeRef.current || handledRef.current) return
            const authCode = normalizeAuthCode(rawValue)
            if (!authCode) {
              setMessage('识别到的内容不是有效付款码，请调整距离后重试。')
              return
            }
            handledRef.current = true
            setPhase('detected')
            setMessage('已识别付款码，正在提交模拟支付…')
            releaseCamera()
            onDetectedRef.current(authCode)
          },
          onError: () => {
            if (cancelled || !activeRef.current || handledRef.current) return
            setMessage('识别遇到问题，请保持付款码清晰，或点击“重新扫码”。')
          },
        })
        if (cancelled || handledRef.current) controls?.stop?.()
        else controlsRef.current = controls
      } catch (error) {
        if (cancelled) return
        releaseCamera()
        setPhase('error')
        setMessage(cameraErrorMessage(error))
      }
    }

    start()
    return () => {
      cancelled = true
      activeRef.current = false
      window.clearTimeout(hintTimer)
      releaseCamera()
    }
  }, [attempt, decoderFactory, releaseCamera])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden || handledRef.current) return
      activeRef.current = false
      releaseCamera()
      setPhase('paused')
      setMessage('页面已进入后台，摄像头已关闭。返回后请点击“重新扫码”。')
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [releaseCamera])

  const cancel = () => {
    activeRef.current = false
    releaseCamera()
    onCancel()
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`${channelLabel[channel] || ''}付款码扫码`}>
      <div className="grid h-full max-h-[680px] w-full max-w-5xl overflow-hidden rounded-[28px] bg-slate-900 shadow-2xl md:grid-cols-[minmax(0,1fr)_300px]">
        <div className="relative min-h-[300px] overflow-hidden bg-black">
          <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-cover" aria-label="摄像头预览" />
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-10">
            <div className="relative h-[46%] min-h-[150px] w-[82%] max-w-xl rounded-3xl border-2 border-white/90 shadow-[0_0_0_9999px_rgba(2,6,23,0.34)]">
              <span className="absolute -left-1 -top-1 h-12 w-12 rounded-tl-3xl border-l-4 border-t-4 border-budu-400" />
              <span className="absolute -right-1 -top-1 h-12 w-12 rounded-tr-3xl border-r-4 border-t-4 border-budu-400" />
              <span className="absolute -bottom-1 -left-1 h-12 w-12 rounded-bl-3xl border-b-4 border-l-4 border-budu-400" />
              <span className="absolute -bottom-1 -right-1 h-12 w-12 rounded-br-3xl border-b-4 border-r-4 border-budu-400" />
            </div>
          </div>
          <div className="absolute left-4 top-4 rounded-full bg-black/55 px-3 py-1.5 text-xs font-semibold text-white">优先使用后置摄像头</div>
        </div>

        <aside className="flex min-h-0 flex-col bg-white p-6" style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}>
          <button onClick={cancel} className="ml-auto grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-slate-500" aria-label="关闭扫码"><X className="h-5 w-5" /></button>
          <div className="mt-3"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-budu-50 text-budu-600"><Camera className="h-6 w-6" /></div><h2 className="mt-4 text-xl font-black text-slate-900">扫描{channelLabel[channel]}付款码</h2><p className={`mt-3 text-sm leading-6 ${phase === 'error' ? 'text-rose-600' : 'text-slate-500'}`}>{message}</p></div>
          <div className="mt-auto space-y-3 pt-6">
            <button onClick={retry} disabled={phase === 'detected'} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-budu-500 py-3.5 text-sm font-bold text-white disabled:opacity-40"><RefreshCw className="h-4 w-4" />重新扫码</button>
            <button onClick={cancel} className="w-full rounded-2xl border border-slate-200 py-3.5 text-sm font-bold text-slate-500">取消</button>
          </div>
        </aside>
      </div>
    </div>
  )
}
