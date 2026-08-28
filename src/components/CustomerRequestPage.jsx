import { useEffect, useMemo, useState } from 'react'
import { Check, Loader2, LockKeyhole, Mail, MapPin, PackageCheck, ReceiptText, ShieldCheck } from 'lucide-react'
import { customerRequestTokenFromLocation, publicCustomerRequestApi } from '../utils/customerRequestApi'
import { storeName } from '../utils/selectors'

const fieldClass = 'input min-h-12 w-full text-base'
const money = (cents) => (Number(cents || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function StatusCard({ type, submitted = false, message }) {
  const invoice = type === 'INVOICE'
  return (
    <div className="rounded-3xl border border-slate-100 bg-white p-7 text-center shadow-card">
      <div className={`mx-auto grid h-14 w-14 place-items-center rounded-2xl ${submitted ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
        {submitted ? <Check className="h-7 w-7" /> : <LockKeyhole className="h-7 w-7" />}
      </div>
      <h1 className="mt-4 text-xl font-bold text-slate-900">{submitted ? (invoice ? '开票资料已提交' : '已提交') : '无法继续填写'}</h1>
      <p className="mt-2 text-sm leading-6 text-slate-500">
        {message || (invoice ? '资料已发送给 budu 工作人员。请等待处理。' : '收件信息已发送给 budu 门店。请关闭此页面。')}
      </p>
    </div>
  )
}

export default function CustomerRequestPage() {
  const token = useMemo(() => customerRequestTokenFromLocation(), [])
  const [request, setRequest] = useState(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [mailing, setMailing] = useState({ recipient: '', phone: '', address: '', mailingContent: '', note: '', confirmedAccurate: false, companyWebsite: '' })
  const [invoice, setInvoice] = useState({ titleType: 'ENTERPRISE', invoiceTitle: '', taxNo: '', email: '', note: '', confirmedAccurate: false, companyWebsite: '' })

  useEffect(() => {
    let active = true
    if (!token) {
      setError('二维码无效或已失效')
      setLoading(false)
      return undefined
    }
    publicCustomerRequestApi(token)
      .then((data) => {
        if (!active) return
        setRequest(data.request)
        if (data.request?.status === 'SUBMITTED') setSubmitted(true)
      })
      .catch((err) => {
        if (active) setError(err.message || '二维码无效或已失效')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [token])

  const isInvoice = request?.type === 'INVOICE'
  const updateMailing = (key, value) => setMailing((state) => ({ ...state, [key]: value }))
  const updateInvoice = (key, value) => setInvoice((state) => ({ ...state, [key]: value }))

  const submit = async (event) => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      await publicCustomerRequestApi(token, '/submit', { method: 'POST', body: isInvoice ? invoice : mailing })
      setSubmitted(true)
    } catch (err) {
      setError(err.message || '提交失败，请检查后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="min-h-dvh bg-gradient-to-b from-budu-50/80 via-white to-slate-50 px-3 py-[max(1rem,env(safe-area-inset-top))] sm:px-5 sm:py-8">
      <div className="mx-auto w-full max-w-lg">
        <header className="mb-5 px-1 text-center">
          <p className="text-2xl font-black tracking-[0.18em] text-budu-600">budu</p>
          {!loading && request && !submitted && (
            <>
              <h1 className="mt-3 text-2xl font-bold text-slate-900">{isInvoice ? '开票信息填写' : '邮寄信息填写'}</h1>
              <p className="mt-2 text-sm leading-6 text-slate-500">请填写本次服务所需资料，提交后将直接发送至 budu 工作人员。</p>
            </>
          )}
        </header>

        {loading ? (
          <div className="grid min-h-64 place-items-center rounded-3xl bg-white shadow-card">
            <div className="flex items-center gap-2 text-sm font-medium text-budu-600"><Loader2 className="h-5 w-5 animate-spin" />正在验证二维码…</div>
          </div>
        ) : submitted ? (
          <StatusCard type={request?.type} submitted />
        ) : error && !request ? (
          <StatusCard message={error} />
        ) : (
          <form onSubmit={submit} className="space-y-5 rounded-3xl border border-slate-100 bg-white p-5 shadow-card sm:p-7" noValidate>
            <div className="flex items-start gap-3 rounded-2xl bg-budu-50/70 p-4">
              {isInvoice ? <ReceiptText className="mt-0.5 h-5 w-5 shrink-0 text-budu-600" /> : <PackageCheck className="mt-0.5 h-5 w-5 shrink-0 text-budu-600" />}
              <div className="min-w-0 text-sm leading-6 text-slate-600">
                <p className="font-semibold text-slate-800">一次性安全填写</p>
                <p>此页面仅用于本次{isInvoice ? '开票资料' : '邮寄资料'}提交，提交后二维码立即失效。</p>
              </div>
            </div>

            {isInvoice ? (
              <>
                <div>
                  <span className="mb-2 block text-sm font-semibold text-slate-700">抬头类型 *</span>
                  <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="抬头类型">
                    {[['PERSONAL', '个人'], ['ENTERPRISE', '企业']].map(([value, label]) => (
                      <button key={value} type="button" role="radio" aria-checked={invoice.titleType === value} onClick={() => updateInvoice('titleType', value)} className={`min-h-12 rounded-xl border px-3 text-sm font-semibold ${invoice.titleType === value ? 'border-budu-300 bg-budu-50 text-budu-700' : 'border-slate-200 text-slate-600'}`}>{label}</button>
                    ))}
                  </div>
                </div>
                <label className="block text-sm font-semibold text-slate-700">
                  发票抬头 *
                  <input value={invoice.invoiceTitle} onChange={(e) => updateInvoice('invoiceTitle', e.target.value)} autoComplete="organization" maxLength={100} className={`${fieldClass} mt-2`} placeholder={invoice.titleType === 'ENTERPRISE' ? '请输入企业名称' : '请输入个人姓名 / 抬头'} required />
                </label>
                {invoice.titleType === 'ENTERPRISE' && (
                  <label className="block text-sm font-semibold text-slate-700">
                    纳税人识别号 / 统一社会信用代码 *
                    <input value={invoice.taxNo} onChange={(e) => updateInvoice('taxNo', e.target.value.toUpperCase())} autoCapitalize="characters" maxLength={50} className={`${fieldClass} mt-2 uppercase`} placeholder="请输入税号" required />
                  </label>
                )}
                <label className="block text-sm font-semibold text-slate-700">
                  接收邮箱 *
                  <div className="relative mt-2">
                    <Mail className="pointer-events-none absolute left-3 top-3.5 h-5 w-5 text-slate-400" />
                    <input type="email" inputMode="email" autoComplete="email" value={invoice.email} onChange={(e) => updateInvoice('email', e.target.value)} maxLength={120} className={`${fieldClass} pl-10`} placeholder="用于接收电子发票" required />
                  </div>
                </label>
                <div className="rounded-2xl border border-budu-100 bg-budu-50/60 p-4" data-testid="locked-invoice-facts">
                  <p className="text-xs font-bold tracking-wide text-budu-600">本次开票</p>
                  <p className="mt-2 text-sm font-semibold text-slate-700">{storeName(request.invoiceStoreKey)}</p>
                  <p className="mt-1 text-2xl font-black text-slate-900">¥{money(request.invoiceAmountCents)}</p>
                  <p className="mt-1 text-sm font-semibold text-slate-600">{request.invoiceCategory}</p>
                  <p className="mt-2 text-xs leading-5 text-slate-400">门店、金额和商品类目已由 budu 门店确认，无法修改。</p>
                </div>
                <label className="block text-sm font-semibold text-slate-700">
                  备注
                  <textarea value={invoice.note} onChange={(e) => updateInvoice('note', e.target.value)} maxLength={200} rows={3} className={`${fieldClass} mt-2 resize-y`} placeholder="选填" />
                </label>
              </>
            ) : (
              <>
                <label className="block text-sm font-semibold text-slate-700">
                  收件人 *
                  <input value={mailing.recipient} onChange={(e) => updateMailing('recipient', e.target.value)} autoComplete="name" maxLength={50} className={`${fieldClass} mt-2`} placeholder="请输入收件人姓名" required />
                </label>
                <label className="block text-sm font-semibold text-slate-700">
                  手机号 *
                  <input value={mailing.phone} onChange={(e) => updateMailing('phone', e.target.value)} inputMode="tel" autoComplete="tel" maxLength={20} className={`${fieldClass} mt-2`} placeholder="请输入中国大陆手机号" required />
                </label>
                <label className="block text-sm font-semibold text-slate-700">
                  完整收件地址 *
                  <div className="relative mt-2">
                    <MapPin className="pointer-events-none absolute left-3 top-3.5 h-5 w-5 text-slate-400" />
                    <textarea value={mailing.address} onChange={(e) => updateMailing('address', e.target.value)} autoComplete="street-address" maxLength={200} rows={3} className={`${fieldClass} min-h-24 resize-y pl-10`} placeholder="省/市/区、街道、小区、楼栋、单元及门牌号" required />
                  </div>
                </label>
                <label className="block text-sm font-semibold text-slate-700">
                  邮寄内容
                  <input value={mailing.mailingContent} onChange={(e) => updateMailing('mailingContent', e.target.value)} maxLength={100} className={`${fieldClass} mt-2`} placeholder="选填，例如：礼盒 1 份" />
                </label>
                <label className="block text-sm font-semibold text-slate-700">
                  备注
                  <textarea value={mailing.note} onChange={(e) => updateMailing('note', e.target.value)} maxLength={200} rows={3} className={`${fieldClass} mt-2 resize-y`} placeholder="选填，例如：送达时间要求" />
                </label>
              </>
            )}

            <input tabIndex={-1} autoComplete="off" value={isInvoice ? invoice.companyWebsite : mailing.companyWebsite} onChange={(e) => (isInvoice ? updateInvoice('companyWebsite', e.target.value) : updateMailing('companyWebsite', e.target.value))} className="absolute -left-[9999px] h-px w-px opacity-0" aria-hidden="true" name="companyWebsite" />
            <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 p-3 text-sm leading-6 text-slate-600">
              <input type="checkbox" checked={isInvoice ? invoice.confirmedAccurate : mailing.confirmedAccurate} onChange={(e) => (isInvoice ? updateInvoice('confirmedAccurate', e.target.checked) : updateMailing('confirmedAccurate', e.target.checked))} className="mt-1 h-5 w-5 shrink-0 accent-[#9c755f]" required />
              <span>我已确认以上信息准确无误</span>
            </label>

            {error && <p role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm font-medium text-rose-600">{error}</p>}
            <button type="submit" disabled={submitting} className="btn-primary min-h-12 w-full text-base disabled:cursor-not-allowed disabled:opacity-60">
              {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <ShieldCheck className="h-5 w-5" />}
              {submitting ? '提交中…' : '确认提交'}
            </button>
          </form>
        )}
        <p className="mt-5 text-center text-xs leading-5 text-slate-400">页面不会展示 budu 内部业务信息，请勿将本次二维码转发给无关人员。</p>
      </div>
    </main>
  )
}
