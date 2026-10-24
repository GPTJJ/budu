import { useEffect, useState } from 'react'
import { Check, Copy, Loader2, RefreshCw, ShieldCheck, X } from 'lucide-react'
import CustomerServiceQr from './CustomerServiceQr'

const expiryLabel = (value) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export default function QrCodeModal({ open, title, description, request, loading, error, onRegenerate, onCancel, onClose }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open) setCopied(false)
  }, [open])

  if (!open) return null

  const copyLink = async () => {
    if (!request?.publicUrl) return
    await navigator.clipboard.writeText(request.publicUrl)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="fixed inset-0 z-[160] grid place-items-center bg-slate-950/45 p-3 backdrop-blur-sm sm:p-6" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="customer-request-qr-title"
        className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl sm:p-7"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p id="customer-request-qr-title" className="text-lg font-bold text-slate-900">{title}</p>
            <p className="mt-1 text-sm leading-6 text-slate-500">{description}</p>
          </div>
          <button type="button" onClick={onClose} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-slate-400 hover:bg-slate-100" aria-label="关闭二维码">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 grid min-h-72 place-items-center rounded-3xl border border-budu-100 bg-budu-50/40 p-4">
          {loading ? (
            <div className="flex flex-col items-center gap-3 text-sm font-medium text-budu-600">
              <Loader2 className="h-8 w-8 animate-spin" />
              正在生成安全二维码…
            </div>
          ) : request?.publicUrl ? (
            <CustomerServiceQr request={request} />
          ) : (
            <p className="text-sm text-rose-500">{error || '二维码生成失败，请重试'}</p>
          )}
        </div>

        {request?.request?.expiresAt && (
          <div className="mt-4 flex items-center justify-center gap-2 text-sm font-semibold text-slate-600">
            <ShieldCheck className="h-4 w-4 text-emerald-500" />
            有效期至 {expiryLabel(request.request.expiresAt)}
          </div>
        )}
        {error && request?.publicUrl && <p className="mt-3 text-center text-sm text-rose-500">{error}</p>}

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button type="button" onClick={onRegenerate} disabled={loading || !request?.request?.id} className="btn-secondary min-h-11 whitespace-nowrap px-3">
            <RefreshCw className="h-4 w-4" />
            重新生成
          </button>
          <button type="button" onClick={copyLink} disabled={!request?.publicUrl} className="btn-primary min-h-11 whitespace-nowrap px-3">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? '已复制' : '复制网页链接'}
          </button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" onClick={onCancel} disabled={loading || !request?.request?.id} className="min-h-11 rounded-xl px-3 text-sm font-medium text-rose-500 hover:bg-rose-50 disabled:opacity-50">
            取消二维码
          </button>
          <button type="button" onClick={onClose} className="btn-secondary min-h-11 px-3">关闭</button>
        </div>
      </section>
    </div>
  )
}
