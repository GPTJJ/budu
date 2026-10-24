import { useEffect, useRef, useState } from 'react'
import { BarcodeFormat, EncodeHintType, QRCodeWriter } from '@zxing/library'
import { Loader2, RefreshCw } from 'lucide-react'
import { api } from '../utils/api'

// The server owns both the release gate and the code's environment. Never turn
// an ordinary H5 URL into a pretend MiniProgram code in the browser.
export default function CustomerServiceQr({ request }) {
  const canvasRef = useRef(null)
  const [state, setState] = useState({ loading: true })
  const [retry, setRetry] = useState(0)
  const [legacy, setLegacy] = useState(false)
  const requestId = request?.request?.id

  useEffect(() => {
    let active = true
    setLegacy(false)
    setState({ loading: true })
    let capabilitiesLoaded = false
    async function load() {
      try {
        const capabilities = await api('/v2/customer-requests/service-capabilities')
        capabilitiesLoaded = true
        if (!active) return
        if (!capabilities.qrEnabled) {
          setState({ loading: false, legacyReason: '小程序入口尚未开启，本次使用网页填写码；网页申请不会自动加入顾客的小程序记录。' })
          return
        }
        const code = await api(`/v2/customer-requests/${encodeURIComponent(requestId)}/mini-code`, { method: 'POST' })
        if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(code.imageDataUrl || '')) throw Error('小程序码暂不可用')
        if (active) setState({ loading: false, image: code.imageDataUrl, envVersion: code.envVersion })
      } catch (error) {
        if (!active) return
        // Older backends intentionally retain their original H5 entry.
        if (!capabilitiesLoaded && error.status === 404) setState({ loading: false, legacyReason: '当前版本使用网页填写码，暂不支持小程序回查。' })
        else setState({ loading: false, error: '小程序码暂不可用，请重试或明确选择网页填写码。' })
      }
    }
    if (requestId) load()
    else setState({ loading: false, error: '请先生成本次申请。' })
    return () => { active = false }
  }, [requestId, retry])

  const showLegacy = Boolean(request?.publicUrl) && (legacy || Boolean(state.legacyReason))
  useEffect(() => {
    if (!showLegacy || !canvasRef.current) return
    const matrix = new QRCodeWriter().encode(request.publicUrl, BarcodeFormat.QR_CODE, 320, 320, new Map([[EncodeHintType.MARGIN, 1]]))
    const canvas = canvasRef.current
    canvas.width = matrix.getWidth(); canvas.height = matrix.getHeight()
    const ctx = canvas.getContext('2d')
    const pixels = ctx.createImageData(canvas.width, canvas.height)
    for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
      const at = (y * canvas.width + x) * 4
      pixels.data[at] = pixels.data[at + 1] = pixels.data[at + 2] = matrix.get(x, y) ? 24 : 255
      pixels.data[at + 3] = 255
    }
    ctx.putImageData(pixels, 0, 0)
  }, [showLegacy, request?.publicUrl])

  return <div className="flex w-full min-w-0 flex-col items-center gap-3 text-center">
    {state.loading ? <p className="flex items-center gap-2 text-sm text-budu-600"><Loader2 className="h-5 w-5 animate-spin" />正在准备填写入口…</p>
      : showLegacy ? <>
        <canvas ref={canvasRef} data-testid="customer-request-qr" aria-label="顾客网页填写二维码" className="aspect-square w-full max-w-64 rounded-2xl bg-white p-2 shadow-sm" />
        <p className="text-xs leading-5 text-slate-500">{state.legacyReason || '本次使用网页填写码，不能自动关联小程序顾客。'}</p>
      </> : state.image ? <>
        <img src={state.image} data-testid="customer-request-mini-code" alt="顾客小程序填写码" className="aspect-square w-full max-w-64 rounded-2xl bg-white object-contain p-2 shadow-sm" />
        <p className="text-sm font-semibold text-budu-700">微信扫码，进入本次小程序申请</p>
        {state.envVersion && state.envVersion !== 'release' && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">{state.envVersion === 'trial' ? '体验版' : '开发版'} · 仅用于指定测试，不能投放门店</p>}
      </> : <>
        <p role="alert" className="text-sm leading-6 text-rose-600">{state.error}</p>
        <button type="button" className="btn-secondary min-h-11" onClick={() => setRetry((value) => value + 1)}><RefreshCw className="h-4 w-4" />重试小程序码</button>
        {request?.publicUrl && <button type="button" className="min-h-11 rounded-xl px-3 text-sm text-slate-600 underline" onClick={() => setLegacy(true)}>改用网页填写码</button>}
      </>}
  </div>
}
