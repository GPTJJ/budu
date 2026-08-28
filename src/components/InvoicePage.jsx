import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CalendarClock, Copy, Loader2, Mail, MapPin, QrCode, Receipt, Trash2 } from 'lucide-react'
import { allStores, storeName } from '../utils/selectors'
import { api } from '../utils/api'
import { t } from '../utils/text'
import QrCodeModal from './QrCodeModal'
import { takeNotificationRecordFocus } from '../utils/notificationNavigation'

const inputCls = 'input'

const yuan = (cents) => (Number(cents || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

const INVOICE_CATEGORIES = Object.freeze(['食品', '巧克力', '太妃糖'])

export default function InvoicePage({ onBack }) {
  const [month, setMonth] = useState(`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`)
  const [store, setStore] = useState('all')
  const [tab, setTab] = useState('pending')
  const [dateFilter, setDateFilter] = useState('')
  const [pendingRows, setPendingRows] = useState([])
  const [doneRows, setDoneRows] = useState([])
  const [form, setForm] = useState({
    storeKey: '',
    amount: '',
    category: '',
  })
  const [error, setError] = useState('')
  const [savedTip, setSavedTip] = useState('')
  const [qrOpen, setQrOpen] = useState(false)
  const [qrLoading, setQrLoading] = useState(false)
  const [qrError, setQrError] = useState('')
  const [qrRequest, setQrRequest] = useState(null)
  const [notificationFocusId, setNotificationFocusId] = useState(() => takeNotificationRecordFocus('finance-invoice'))

  const load = async () => {
    setError('')
    const base = new URLSearchParams({ month })
    if (store !== 'all') base.set('store', store)
    const pendingQs = new URLSearchParams(base)
    pendingQs.set('status', 'pending')
    const doneQs = new URLSearchParams(base)
    doneQs.set('status', 'done')
    if (dateFilter) doneQs.set('date', dateFilter)
    try {
      const [pd, dn] = await Promise.all([
        api(`/v2/invoices?${pendingQs}`),
        api(`/v2/invoices?${doneQs}`),
      ])
      setPendingRows(pd.rows || [])
      setDoneRows(dn.rows || [])
    } catch (err) {
      setError(t(err.message))
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, store, dateFilter])

  useEffect(() => {
    if (!notificationFocusId) return
    const row = [...pendingRows, ...doneRows].find((item) => item.id === notificationFocusId)
    if (!row) return
    setTab(row.status === 'done' ? 'done' : 'pending')
    window.setTimeout(() => {
      document.querySelector(`[data-invoice-record-id="${CSS.escape(notificationFocusId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)
  }, [notificationFocusId, pendingRows, doneRows])

  useEffect(() => {
    const receiveNotificationFocus = (event) => {
      if (event.detail?.target !== 'finance-invoice') return
      const refId = takeNotificationRecordFocus('finance-invoice') || String(event.detail?.refId || '')
      if (refId) setNotificationFocusId(refId)
    }
    window.addEventListener('budu:notification-record-focus', receiveNotificationFocus)
    return () => window.removeEventListener('budu:notification-record-focus', receiveNotificationFocus)
  }, [])

  const rows = useMemo(() => {
    if (tab === 'done') {
      return [...doneRows].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    }
    return pendingRows
  }, [tab, pendingRows, doneRows])

  const setField = (key, value) => setForm((s) => ({ ...s, [key]: value }))

  const amountText = String(form.amount || '')
  const amountCents = Math.round(Number(amountText) * 100)
  const amountValid = /^\d+(?:\.\d{1,2})?$/.test(amountText)
    && Number.isSafeInteger(amountCents)
    && amountCents > 0
    && amountCents <= 999999999999
  const qrReady = Boolean(form.storeKey) && amountValid && INVOICE_CATEGORIES.includes(form.category)

  const generateCustomerQr = async () => {
    setError('')
    if (!form.storeKey) {
      setError(t('请先选择本次服务门店'))
      return
    }
    if (!amountValid) {
      setError(t('请先填写正确的开票金额'))
      return
    }
    if (!INVOICE_CATEGORIES.includes(form.category)) {
      setError(t('请先选择商品类目'))
      return
    }
    setQrOpen(true)
    setQrLoading(true)
    setQrError('')
    try {
      const data = await api('/v2/customer-requests', {
        method: 'POST',
        body: JSON.stringify({
          type: 'INVOICE',
          storeKey: form.storeKey,
          amountCents,
          category: form.category,
        }),
      })
      setQrRequest(data)
    } catch (err) {
      setQrError(t(err.message || '二维码生成失败'))
    } finally {
      setQrLoading(false)
    }
  }

  const regenerateCustomerQr = async () => {
    if (!qrRequest?.request?.id) return
    setQrLoading(true)
    setQrError('')
    try {
      const data = await api(`/v2/customer-requests/${qrRequest.request.id}/regenerate`, { method: 'POST' })
      setQrRequest(data)
    } catch (err) {
      setQrError(t(err.message || '二维码重新生成失败'))
    } finally {
      setQrLoading(false)
    }
  }

  const cancelCustomerQr = async () => {
    if (!qrRequest?.request?.id) return
    setQrLoading(true)
    setQrError('')
    try {
      await api(`/v2/customer-requests/${qrRequest.request.id}/cancel`, { method: 'POST' })
      setQrRequest(null)
      setQrOpen(false)
      setSavedTip(t('二维码已取消'))
    } catch (err) {
      setQrError(t(err.message || '二维码取消失败'))
    } finally {
      setQrLoading(false)
    }
  }

  const remove = async (id) => {
    if (!window.confirm(t('确定删除该发票记录吗？'))) return
    try {
      await api(`/v2/invoices/${id}`, { method: 'DELETE' })
      await load()
    } catch (err) {
      setError(t(err.message))
    }
  }

  const toggleStatus = async (row) => {
    setError('')
    const next = row.status === 'done' ? 'pending' : 'done'
    try {
      await api(`/v2/invoices/${row.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: next }),
      })
      setSavedTip(t(next === 'done' ? '已标记为已开票 ✓' : '已恢复为待开票 ✓'))
      setTimeout(() => setSavedTip(''), 2000)
      await load()
    } catch (err) {
      setError(t(err.message))
    }
  }

  const copyRow = async (r) => {
    const text = [
      `${t('抬头')}：${r.companyName || '—'}`,
      `${t('税号')}：${r.taxNo || '—'}`,
      `${t('邮箱')}：${r.email || '—'}`,
      `${t('金额')}：¥${yuan(r.amountCents)}`,
      `${t('品类')}：${r.category || t('其他')}`,
      `${t('门店')}：${storeName(r.storeKey)}`,
      `${t('时间')}：${fmtTime(r.createdAt)}`,
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setSavedTip(t('已复制抬头/税号/邮箱等信息 ✓'))
    setTimeout(() => setSavedTip(''), 2000)
  }

  const totalCents = rows.reduce((s, r) => s + Number(r.amountCents || 0), 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-2xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-500 shadow-card transition hover:text-budu-600"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('返回首页')}
        </button>
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-slate-800">
            <Receipt className="h-5 w-5 text-budu-500" />
            {t('发票开具')}
          </h2>
          <p className="mt-0.5 text-[13px] text-slate-400">{t('创建顾客二维码申请并处理开票记录')}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={inputCls} />
          <select value={store} onChange={(e) => setStore(e.target.value)} className={inputCls}>
            <option value="all">{t('全部门店')}</option>
            {allStores().map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>
          {tab === 'done' && (
            <input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} className={inputCls} />
          )}
          <span className="rounded-xl bg-budu-50 px-3 py-2 text-xs font-semibold text-budu-600">
            {t('合计 ¥{amount}', { amount: yuan(totalCents) })}
          </span>
        </div>
      </div>

      {savedTip && <p className="rounded-xl bg-emerald-50 px-4 py-2 text-xs font-semibold text-emerald-600">{savedTip}</p>}
      {error && <p className="rounded-xl bg-rose-50 px-4 py-2 text-xs font-medium text-rose-500">{error}</p>}

      <section className="card p-5 sm:p-6" aria-labelledby="invoice-request-title">
        <div>
          <h3 id="invoice-request-title" className="text-lg font-bold text-slate-900">创建开票申请</h3>
          <p className="mt-1 text-sm leading-6 text-slate-500">门店先确认本次业务信息，再由顾客扫码填写开票资料。</p>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-700">本次服务门店</span>
            <select
              aria-label="本次服务门店"
              value={form.storeKey}
              onChange={(e) => setField('storeKey', e.target.value)}
              className={`${inputCls} min-h-12 w-full`}
            >
              <option value="">请选择门店</option>
              {allStores().map((s) => (
                <option key={s.key} value={s.key}>{s.name}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-700">开票金额</span>
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm font-bold text-slate-400">¥</span>
              <input
                aria-label="开票金额"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0.01"
                value={form.amount}
                onChange={(e) => setField('amount', e.target.value)}
                placeholder="请输入本次开票金额"
                className={`${inputCls} min-h-12 w-full pl-8`}
              />
            </div>
          </label>
        </div>

        <fieldset className="mt-4">
          <legend className="mb-2 text-sm font-semibold text-slate-700">商品类目</legend>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="商品类目">
            {INVOICE_CATEGORIES.map((category) => {
              const selected = form.category === category
              return (
                <button
                  key={category}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setField('category', category)}
                  className={`min-h-11 rounded-xl border px-2 text-sm font-bold transition ${
                    selected
                      ? 'border-budu-300 bg-budu-50 text-budu-700 shadow-sm'
                      : 'border-slate-200 bg-white text-slate-500 hover:border-budu-200 hover:bg-budu-50/40'
                  }`}
                >
                  {category}
                </button>
              )
            })}
          </div>
        </fieldset>

        <button
          type="button"
          onClick={generateCustomerQr}
          disabled={!qrReady || qrLoading}
          className="btn-primary mt-5 min-h-12 w-full justify-center disabled:cursor-not-allowed disabled:opacity-40"
        >
          {qrLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
          生成顾客申请二维码
        </button>
        <p className="mt-3 text-center text-xs leading-5 text-slate-400">顾客扫码后自行填写开票资料并提交</p>
      </section>

      <QrCodeModal
        open={qrOpen}
        title="顾客填写开票信息"
        description="微信扫码填写开票资料，金额由 budu 后台锁定"
        request={qrRequest}
        loading={qrLoading}
        error={qrError}
        onRegenerate={regenerateCustomerQr}
        onCancel={cancelCustomerQr}
        onClose={() => setQrOpen(false)}
      />

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4">
          <h3 className="text-[15px] font-bold text-slate-800">{t('开票记录')}</h3>
          <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setTab('pending')}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                tab === 'pending' ? 'bg-white text-budu-600 shadow' : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              {t('待开票')}
              <span className="ml-1 text-[10px] opacity-70">{pendingRows.length}</span>
            </button>
            <button
              type="button"
              onClick={() => setTab('done')}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                tab === 'done' ? 'bg-white text-emerald-600 shadow' : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              {t('已开票')}
              <span className="ml-1 text-[10px] opacity-70">{doneRows.length}</span>
            </button>
          </div>
        </div>
        <div className="space-y-3 p-3 sm:max-h-[520px] sm:space-y-0 sm:divide-y sm:divide-slate-50 sm:overflow-y-auto sm:p-0">
          {rows.map((r) => (
            <div
              key={r.id}
              data-invoice-record-id={r.id}
              role={tab === 'pending' ? 'button' : undefined}
              tabIndex={tab === 'pending' ? 0 : undefined}
              onClick={tab === 'pending' ? () => copyRow(r) : undefined}
              onKeyDown={tab === 'pending' ? (e) => e.key === 'Enter' && copyRow(r) : undefined}
              className={`rounded-2xl border border-slate-100 bg-white p-4 shadow-sm sm:flex sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-1 sm:rounded-none sm:border-0 sm:bg-transparent sm:px-5 sm:py-3 sm:shadow-none ${notificationFocusId === r.id ? 'bg-budu-50 ring-1 ring-inset ring-budu-200' : ''} ${
                tab === 'pending' ? 'cursor-pointer transition hover:border-budu-100 hover:bg-slate-50' : ''
              }`}
              title={tab === 'pending' ? t('点击复制抬头/税号/邮箱等信息') : undefined}
            >
              <div className="flex items-center gap-2 sm:contents">
                <span className="shrink-0 rounded-lg bg-budu-50 px-2 py-0.5 text-[11px] font-bold text-budu-600">
                  {t(r.titleType === 'company' ? '公司' : '个人')}
                </span>
                <span
                  className={`shrink-0 rounded-lg px-2 py-0.5 text-[11px] font-bold ${
                    r.status === 'done' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
                  }`}
                >
                  {t(r.status === 'done' ? '已开票' : '待开票')}
                </span>
                <span className="ml-auto shrink-0 text-lg font-black tabular-nums text-slate-800 sm:hidden">¥{yuan(r.amountCents)}</span>
              </div>

              <div className="mt-3 min-w-0 flex-1 sm:mt-0">
                <p className="break-words text-[15px] font-bold leading-6 text-slate-800 [overflow-wrap:anywhere] sm:text-sm sm:font-semibold sm:text-slate-700">
                  {r.companyName || '—'}
                  {r.taxNo && <span className="ml-2 hidden font-normal text-slate-400 sm:inline">{r.taxNo}</span>}
                </p>
                {r.taxNo && <p className="mt-1 break-all font-mono text-xs leading-5 text-slate-400 sm:hidden">{r.taxNo}</p>}

                <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 rounded-xl bg-slate-50/80 p-3 text-xs text-slate-500 sm:hidden">
                  <p className="flex min-w-0 items-center gap-1.5"><MapPin className="h-3.5 w-3.5 shrink-0 text-slate-300" /><span className="truncate">{storeName(r.storeKey)}</span></p>
                  <p className="truncate text-right">{t(r.category)}</p>
                  <p className="col-span-2 flex min-w-0 items-start gap-1.5"><Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-300" /><span className="min-w-0 break-all">{r.email || '—'}</span></p>
                  <p className="col-span-2 flex min-w-0 items-center gap-1.5"><CalendarClock className="h-3.5 w-3.5 shrink-0 text-slate-300" /><span>{fmtTime(r.createdAt)}</span><span className="ml-auto shrink-0 text-slate-400">{r.createdBy}</span></p>
                </div>

                <p className="mt-0.5 hidden text-[11px] text-slate-400 sm:block">
                  {storeName(r.storeKey)} · {t(r.category)} · {r.email} · {fmtTime(r.createdAt)} · {r.createdBy}
                </p>
              </div>
              <span className="hidden shrink-0 text-sm font-bold tabular-nums text-slate-800 sm:block">¥{yuan(r.amountCents)}</span>

              <div className="mt-3 flex items-stretch gap-2 sm:mt-0 sm:items-center">
                {tab === 'pending' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      copyRow(r)
                    }}
                    className="flex min-h-10 flex-1 items-center justify-center gap-1 rounded-xl bg-budu-50 px-3 py-2 text-xs font-semibold text-budu-600 transition hover:bg-budu-100 sm:min-h-0 sm:flex-none sm:rounded-lg sm:px-2.5 sm:py-1.5"
                    aria-label={t('复制信息')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    {t('复制信息')}
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleStatus(r)
                  }}
                  className={`min-h-10 flex-1 rounded-xl px-3 py-2 text-xs font-semibold transition sm:min-h-0 sm:flex-none sm:rounded-lg sm:px-2.5 sm:py-1.5 ${
                    r.status === 'done'
                      ? 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                      : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
                  }`}
                >
                  {t(r.status === 'done' ? '标记待开票' : '标记已开票')}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(r.id)
                  }}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-slate-100 text-slate-300 transition hover:border-rose-100 hover:bg-rose-50 hover:text-rose-500 sm:h-auto sm:w-auto sm:border-0 sm:p-1.5"
                  aria-label={t('删除')}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
          {rows.length === 0 && (
            <p className="grid place-items-center py-10 text-xs text-slate-300 sm:mx-0">
              {t(tab === 'done' ? '暂无已开票记录' : '暂无待开票记录')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
