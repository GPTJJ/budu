import { Loader2, RefreshCw, ShieldCheck, X } from 'lucide-react'
import paymentQr from '../assets/mailing-payment-qr.jpg'
import personalWechatQr from '../assets/mailing-personal-wechat-qr.jpg'
import CustomerServiceQr from './CustomerServiceQr'

function expiryLabel(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export default function MailingQrSheet({
  open,
  kind,
  amountCents,
  request,
  loading,
  error,
  storeName,
  conditions,
  onRegenerate,
  onCancel,
  onClose,
}) {
  if (!open) return null

  const isCustomer = kind === 'customer'
  const title = isCustomer ? '顾客填写收件信息' : kind === 'payment' ? `微信收款 ¥${Number(amountCents || 0) / 100}` : '添加微信沟通闪送费'
  return (
    <div className="fixed inset-0 z-[170] flex items-end justify-center bg-slate-950/45 backdrop-blur-sm sm:items-center sm:p-6" role="presentation">
      <section role="dialog" aria-modal="true" aria-label={title} className="max-h-[calc(100dvh-0.75rem)] w-full max-w-md overflow-y-auto rounded-t-[28px] bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 shadow-2xl sm:rounded-[28px] sm:p-6">
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200 sm:hidden" />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-slate-900">{title}</h3>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              {isCustomer ? '请顾客扫码填写，本次配送条件已锁定。' : kind === 'payment' ? '请顾客扫码付款，到账后由工作人员确认。' : '请顾客添加微信，闪送费用通过微信沟通。'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button>
        </div>

        {isCustomer && (
          <div className="mt-3 rounded-2xl bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
            <p><span className="text-slate-400">门店：</span>{storeName}</p>
            <p><span className="text-slate-400">本次条件：</span>{conditions}</p>
          </div>
        )}

        <div className="mt-4 grid min-h-64 place-items-center overflow-hidden rounded-3xl border border-budu-100 bg-budu-50/35 p-3">
          {loading ? (
            <div className="flex flex-col items-center gap-3 text-sm font-semibold text-budu-600"><Loader2 className="h-8 w-8 animate-spin" />正在生成安全二维码…</div>
          ) : error ? (
            <p className="px-4 text-center text-sm text-rose-500">{error}</p>
          ) : isCustomer ? (
            <CustomerServiceQr request={request} />
          ) : (
            <img
              src={kind === 'payment' ? paymentQr : personalWechatQr}
              alt={kind === 'payment' ? '微信收款二维码' : '个人微信二维码'}
              data-testid={kind === 'payment' ? 'mailing-payment-qr' : 'mailing-personal-wechat-qr'}
              className="max-h-[52dvh] w-full object-contain"
            />
          )}
        </div>

        {isCustomer && request?.request?.expiresAt && (
          <p className="mt-3 flex items-center justify-center gap-2 text-sm font-semibold text-slate-600"><ShieldCheck className="h-4 w-4 text-emerald-500" />有效期至 {expiryLabel(request.request.expiresAt)}</p>
        )}
        {isCustomer && request?.publicUrl && (
          <button type="button" onClick={onRegenerate} disabled={loading} className="btn-secondary mt-4 min-h-11 w-full"><RefreshCw className="h-4 w-4" />重新生成</button>
        )}
        <div className="mt-2 grid grid-cols-1 gap-2">
          <button type="button" onClick={onClose} className="btn-primary min-h-12 w-full">完成</button>
          {isCustomer && request?.request?.id && <button type="button" onClick={onCancel} disabled={loading} className="min-h-11 rounded-xl text-sm font-medium text-slate-400 hover:bg-slate-50">取消本次二维码</button>}
        </div>
      </section>
    </div>
  )
}
