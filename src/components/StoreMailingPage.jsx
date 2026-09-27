import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import {
  ArrowLeft, CalendarDays, Check, ClipboardCopy, FileSpreadsheet, Loader2, MessageCircle, PackageCheck, QrCode, WalletCards, X,
} from 'lucide-react'
import { api } from '../utils/api'
import { allStores } from '../utils/selectors'
import { takeNotificationRecordFocus } from '../utils/notificationNavigation'
import {
  MAILING_METHOD,
  MAILING_TIER,
  buildMailingCopyText,
  canGenerateCustomerQr,
  requiresPaymentConfirmation,
  shippingAmountCents,
  shippingPresentation,
} from '../utils/mailingWorkflow'
import MailingQrSheet from './MailingQrSheet'
import { DeveloperSafeDeleteButton } from './DeveloperSafeDelete'

async function copyText(text) {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Some WeChat WebViews do not expose the async clipboard API.
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    textarea.remove()
    return copied
  } catch {
    return false
  }
}

function ChoiceGroup({ label, options, value, onChange }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-sm font-semibold text-slate-600">{label}</legend>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={label}>
        {options.map((option) => {
          const item = typeof option === 'string' ? { value: option, label: option } : option
          const active = value === item.value
          return (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(item.value)}
              className={`min-h-11 min-w-0 rounded-xl border px-3 text-sm font-semibold transition ${active ? 'border-budu-200 bg-budu-50 text-budu-700 ring-1 ring-budu-100' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              <span className="whitespace-nowrap">{item.label}</span>
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}

function ConfirmShipSheet({ record, busy, onConfirm, onClose }) {
  if (!record) return null
  return (
    <div className="fixed inset-0 z-[175] flex items-end justify-center bg-slate-950/45 backdrop-blur-sm sm:items-center sm:p-6" role="presentation">
      <section role="dialog" aria-modal="true" aria-label="确认已发货" className="w-full max-w-md rounded-t-[28px] bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-[28px]">
        <div className="flex items-start justify-between gap-3">
          <div><h3 className="text-lg font-bold text-slate-900">确认已发货</h3><p className="mt-1 text-sm leading-6 text-slate-500">确认 {record.recipient} 的邮寄任务已经交付物流？</p></div>
          <button type="button" onClick={onClose} aria-label="关闭" className="grid h-11 w-11 place-items-center rounded-xl text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary min-h-12">暂不</button>
          <button type="button" onClick={onConfirm} disabled={busy} className="btn-primary min-h-12">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}{busy ? '处理中…' : '确认已发货'}</button>
        </div>
      </section>
    </div>
  )
}

const formatTime = (iso) => {
  if (!iso) return ''
  const date = new Date(iso)
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date).replaceAll('/', '-')
}

export default function StoreMailingPage({ currentUser, onBack }) {
  const availableStores = useMemo(() => allStores().filter((store) => {
    const keys = Array.isArray(currentUser?.storeKeys) ? currentUser.storeKeys : []
    return ['developer', 'admin', 'finance'].includes(currentUser?.role) || keys.includes(store.key)
  }), [currentUser])
  const [storeKey, setStoreKey] = useState(availableStores[0]?.key || '')
  const [method, setMethod] = useState(MAILING_METHOD.SF)
  const [postage, setPostage] = useState('包邮')
  const [shippingTier, setShippingTier] = useState(MAILING_TIER.STANDARD)
  const [paymentConfirmed, setPaymentConfirmed] = useState(false)
  const [sheetKind, setSheetKind] = useState('')
  const [qrLoading, setQrLoading] = useState(false)
  const [qrError, setQrError] = useState('')
  const [qrRequest, setQrRequest] = useState(null)
  const [records, setRecords] = useState([])
  const [recordsLoading, setRecordsLoading] = useState(true)
  const [recordsError, setRecordsError] = useState('')
  const [activeTab, setActiveTab] = useState('pending')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [exportDone, setExportDone] = useState(false)
  const [toast, setToast] = useState('')
  const [shipRecord, setShipRecord] = useState(null)
  const [shippingId, setShippingId] = useState('')
  const [notificationFocusId, setNotificationFocusId] = useState(() => takeNotificationRecordFocus('store-mailing'))

  const amountCents = shippingAmountCents(shippingTier)
  const config = { storeKey, method, postage, shippingTier, paymentConfirmed }
  const selectedStoreName = availableStores.find((store) => store.key === storeKey)?.name || storeKey
  const selectedPresentation = shippingPresentation({
    method,
    postage,
    shippingTier,
    shippingAmountCents: amountCents,
    shippingPaymentMode: method === MAILING_METHOD.FLASH && postage === '不包邮' ? 'WECHAT_COMMUNICATION' : '',
  })

  const showToast = (message) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 1800)
  }

  const loadRecords = async () => {
    setRecordsLoading(true)
    try {
      const data = await api('/v2/mailing-records')
      setRecords(Array.isArray(data.rows) ? data.rows : [])
      setRecordsError('')
    } catch (error) {
      setRecordsError(error.message || '加载发件记录失败')
    } finally {
      setRecordsLoading(false)
    }
  }

  useEffect(() => { loadRecords() }, [])
  useEffect(() => { setPaymentConfirmed(false); setQrRequest(null); setQrError('') }, [storeKey, method, postage, shippingTier])
  useEffect(() => {
    if (!notificationFocusId || records.length === 0) return
    const row = records.find((record) => record.id === notificationFocusId)
    if (!row) return
    setActiveTab(row.status === 'shipped' ? 'shipped' : 'pending')
    window.setTimeout(() => document.querySelector(`[data-mailing-record-id="${CSS.escape(notificationFocusId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
  }, [notificationFocusId, records])
  useEffect(() => {
    const receiveFocus = (event) => {
      if (event.detail?.target !== 'store-mailing') return
      const refId = takeNotificationRecordFocus('store-mailing') || String(event.detail?.refId || '')
      if (refId) setNotificationFocusId(refId)
    }
    window.addEventListener('budu:notification-record-focus', receiveFocus)
    return () => window.removeEventListener('budu:notification-record-focus', receiveFocus)
  }, [])

  const requestPayload = () => ({
    type: 'MAILING',
    storeKey,
    method,
    postage,
    shippingTier: requiresPaymentConfirmation(config) ? shippingTier : undefined,
    shippingAmountCents: requiresPaymentConfirmation(config) ? amountCents : undefined,
    paymentConfirmed: requiresPaymentConfirmation(config) ? paymentConfirmed : false,
  })

  const generateCustomerQr = async () => {
    if (!canGenerateCustomerQr(config)) return
    setSheetKind('customer')
    setQrLoading(true)
    setQrError('')
    try {
      const data = await api('/v2/customer-requests', { method: 'POST', body: JSON.stringify(requestPayload()) })
      setQrRequest(data)
    } catch (error) {
      setQrError(error.message || '二维码生成失败')
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
    } catch (error) {
      setQrError(error.message || '二维码重新生成失败')
    } finally {
      setQrLoading(false)
    }
  }

  const cancelCustomerQr = async () => {
    if (!qrRequest?.request?.id) return
    setQrLoading(true)
    try {
      await api(`/v2/customer-requests/${qrRequest.request.id}/cancel`, { method: 'POST' })
      setQrRequest(null)
      setSheetKind('')
      showToast('本次二维码已取消')
    } catch (error) {
      setQrError(error.message || '二维码取消失败')
    } finally {
      setQrLoading(false)
    }
  }

  const inRange = (iso) => {
    const date = iso ? iso.slice(0, 10) : ''
    return (!fromDate || date >= fromDate) && (!toDate || date <= toDate)
  }
  const pendingRecords = records.filter((record) => record.status === 'pending' && inRange(record.createdAt))
  const shippedRecords = records.filter((record) => record.status === 'shipped' && inRange(record.createdAt))
  const visibleRecords = activeTab === 'pending' ? pendingRecords : shippedRecords

  const copyRecord = async (record) => {
    const copied = await copyText(buildMailingCopyText(record))
    showToast(copied ? '已复制本单收件信息' : '复制失败，请长按选择内容')
  }

  const confirmShip = async () => {
    if (!shipRecord?.id) return
    setShippingId(shipRecord.id)
    try {
      await api(`/v2/mailing-records/${shipRecord.id}/ship`, { method: 'POST' })
      setShipRecord(null)
      await loadRecords()
      showToast('已移入已发货')
    } catch (error) {
      showToast(error.message || '操作失败')
    } finally {
      setShippingId('')
    }
  }

  const handleExport = () => {
    if (!visibleRecords.length) return showToast('当前筛选范围内暂无记录')
    const rows = visibleRecords.map((record) => {
      const view = shippingPresentation(record)
      return [formatTime(record.createdAt), record.status === 'shipped' ? '已发货' : '待发货', record.storeKey || '', view.method, view.detail, view.tierLabel, record.address, record.recipient, record.phone, record.remark || '']
    })
    const sheet = XLSX.utils.aoa_to_sheet([['提交时间', '状态', '门店', '配送', '运费', '类型', '收件地址', '收件人', '联系方式', '备注'], ...rows])
    sheet['!cols'] = [{ wch: 18 }, { wch: 8 }, { wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 12 }, { wch: 30 }, { wch: 10 }, { wch: 14 }, { wch: 24 }]
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, sheet, '发件记录')
    XLSX.writeFile(book, `budu发件记录_${(fromDate || 'all').replaceAll('-', '')}-${(toDate || 'all').replaceAll('-', '')}.xlsx`)
    setExportDone(true)
    window.setTimeout(() => setExportDone(false), 1600)
  }

  const tabClass = (tab) => `min-h-10 rounded-lg px-3 text-xs font-semibold transition ${activeTab === tab ? 'bg-white text-budu-700 shadow-sm' : 'text-slate-500'}`

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 pb-4">
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={onBack} className="btn-secondary min-h-11 px-3"><ArrowLeft className="h-4 w-4" />返回</button>
        <p className="text-right text-xs leading-5 text-slate-400">顾客扫码提交后自动进入待发货</p>
      </div>

      <section className="card overflow-hidden p-4 sm:p-6" data-testid="mailing-qr-only-creation">
        <div className="mb-5">
          <h2 className="text-lg font-bold text-slate-900">创建邮寄</h2>
          <p className="mt-1 text-sm leading-6 text-slate-500">选择本次服务条件，再生成顾客填写二维码。</p>
        </div>
        <div className="space-y-5">
          <label className="block text-sm font-semibold text-slate-600">本次服务门店
            <select value={storeKey} onChange={(event) => setStoreKey(event.target.value)} className="input mt-2 min-h-12 w-full" aria-label="本次服务门店">
              {availableStores.map((store) => <option key={store.key} value={store.key}>{store.name}</option>)}
            </select>
          </label>
          <ChoiceGroup label="配送方式" options={[MAILING_METHOD.SF, MAILING_METHOD.FLASH]} value={method} onChange={setMethod} />
          <ChoiceGroup label="运费承担" options={['包邮', '不包邮']} value={postage} onChange={setPostage} />

          {requiresPaymentConfirmation(config) && (
            <div className="space-y-3 rounded-2xl border border-amber-100 bg-amber-50/60 p-3">
              <ChoiceGroup label="顺丰类型" options={[{ value: MAILING_TIER.STANDARD, label: '标准 ¥18' }, { value: MAILING_TIER.FRESH, label: '生鲜 ¥35' }]} value={shippingTier} onChange={setShippingTier} />
              <button type="button" onClick={() => setSheetKind('payment')} className="btn-secondary min-h-12 w-full"><WalletCards className="h-4 w-4" />打开微信收款二维码</button>
              <button
                type="button"
                aria-pressed={paymentConfirmed}
                onClick={() => setPaymentConfirmed((value) => !value)}
                className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border px-3 text-sm font-bold transition ${paymentConfirmed ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-white text-amber-700'}`}
              >
                <Check className="h-4 w-4" />{paymentConfirmed ? `已确认收到 ¥${amountCents / 100}` : `确认已收到 ¥${amountCents / 100}`}
              </button>
              {!paymentConfirmed && <p className="text-center text-xs leading-5 text-amber-700">收到运费并确认后，才能生成顾客填写二维码。</p>}
            </div>
          )}

          {method === MAILING_METHOD.FLASH && postage === '不包邮' && (
            <div className="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-3">
              <p className="text-sm font-bold text-emerald-800">不包邮 · 微信沟通</p>
              <p className="mt-1 text-xs leading-5 text-emerald-700">闪送费用不在系统内定价，请顾客添加微信后沟通。</p>
              <button type="button" onClick={() => setSheetKind('wechat')} className="btn-secondary mt-3 min-h-12 w-full"><MessageCircle className="h-4 w-4" />打开个人微信二维码</button>
            </div>
          )}

          <button type="button" onClick={generateCustomerQr} disabled={!canGenerateCustomerQr(config) || qrLoading} className="btn-primary min-h-12 w-full whitespace-nowrap">
            {qrLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
            生成顾客填写二维码
          </button>
        </div>
      </section>

      <section className="card overflow-hidden">
        <div data-testid="mailing-record-toolbar" className="space-y-3 border-b border-slate-100 px-4 py-4 sm:px-5 lg:flex lg:items-end lg:gap-3 lg:space-y-0">
          <div className="flex items-center justify-between gap-3 lg:mr-auto lg:block">
            <h3 className="text-[15px] font-bold text-slate-900">发件记录</h3>
            <span className="rounded-lg bg-amber-50 px-2 py-1 text-xs font-bold text-amber-700">待发货 {pendingRecords.length} 条</span>
          </div>
          <div className="grid grid-cols-2 rounded-xl bg-slate-100 p-1 lg:w-64">
            <button type="button" onClick={() => setActiveTab('pending')} className={tabClass('pending')}>待发货 {pendingRecords.length}</button>
            <button type="button" onClick={() => setActiveTab('shipped')} className={tabClass('shipped')}>已发货 {shippedRecords.length}</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="min-w-0 text-[11px] font-semibold text-slate-500"><span className="mb-1 flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />开始日期</span><input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className="input min-w-0 w-full text-xs" /></label>
            <label className="min-w-0 text-[11px] font-semibold text-slate-500"><span className="mb-1 flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />结束日期</span><input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} className="input min-w-0 w-full text-xs" /></label>
          </div>
          <button type="button" onClick={handleExport} disabled={!visibleRecords.length} className="btn-secondary min-h-11 w-full whitespace-nowrap lg:w-auto"><FileSpreadsheet className="h-4 w-4" />{exportDone ? '已导出' : '导出 Excel'}</button>
        </div>

        <div className="space-y-3 bg-slate-50/60 p-3 sm:p-4">
          {recordsLoading ? <div className="empty-state py-12">加载中…</div>
            : recordsError ? <div className="empty-state py-12">{recordsError}</div>
              : !visibleRecords.length ? <div className="empty-state py-12">{activeTab === 'pending' ? '暂无待发货记录' : '暂无已发货记录'}</div>
                : visibleRecords.map((record) => {
                  const view = shippingPresentation(record)
                  const storeName = availableStores.find((store) => store.key === record.storeKey)?.name || record.storeKey || '历史记录'
                  return (
                    <article
                      key={record.id}
                      data-mailing-record-id={record.id}
                      className={`rounded-2xl border bg-white p-4 shadow-sm ${record.status === 'shipped' ? 'border-slate-100 opacity-70' : 'border-slate-200'} ${notificationFocusId === record.id ? 'ring-2 ring-budu-200' : ''}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2"><h4 className="font-bold text-slate-900">{record.recipient}</h4><span className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${record.status === 'shipped' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{record.status === 'shipped' ? '已发货' : '待发货'}</span></div>
                          <p className="mt-1 text-xs text-slate-400">{formatTime(record.createdAt)} · {storeName}</p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1"><span className="rounded-lg bg-budu-50 px-2 py-1 text-[10px] font-bold text-budu-700">{view.method}</span><span className="rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">{view.tierLabel || view.detail}</span></div>
                      </div>
                      <div className="mt-3 space-y-1 rounded-xl bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-700">
                        <p className="font-semibold">{record.phone}</p>
                        <p className="break-words">{record.address}</p>
                        {record.remark && <p className="break-words text-slate-500">备注：{record.remark}</p>}
                        <p className="text-xs font-semibold text-slate-500">运费：{view.detail}</p>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <button type="button" onClick={() => copyRecord(record)} className="btn-secondary min-h-11 whitespace-nowrap"><ClipboardCopy className="h-4 w-4" />复制本单</button>
                        {record.status === 'pending' ? <button type="button" onClick={() => setShipRecord(record)} className="btn-primary min-h-11 whitespace-nowrap"><PackageCheck className="h-4 w-4" />标记已发货</button> : <span className="flex min-h-11 items-center justify-center text-xs text-slate-400">发货于 {formatTime(record.shippedAt)}</span>}
                        <DeveloperSafeDeleteButton user={currentUser} type="mailing" record={{ ...record, title: `${record.recipient} · ${view.method}`, subtitle: record.address }} onDeleted={loadRecords} className="col-span-2" />
                      </div>
                    </article>
                  )
                })}
        </div>
      </section>

      {toast && <div role="status" className="fixed bottom-[max(5rem,calc(env(safe-area-inset-bottom)+4rem))] left-1/2 z-[190] -translate-x-1/2 whitespace-nowrap rounded-full bg-slate-900 px-4 py-2 text-xs font-bold text-white shadow-xl">{toast}</div>}
      <MailingQrSheet
        open={Boolean(sheetKind)}
        kind={sheetKind}
        amountCents={amountCents}
        request={qrRequest}
        loading={sheetKind === 'customer' && qrLoading}
        error={sheetKind === 'customer' ? qrError : ''}
        storeName={selectedStoreName}
        conditions={`${selectedPresentation.method}${selectedPresentation.tierLabel ? ` · ${selectedPresentation.tierLabel}` : ''} · ${selectedPresentation.detail}`}
        onRegenerate={regenerateCustomerQr}
        onCancel={cancelCustomerQr}
        onClose={() => setSheetKind('')}
      />
      <ConfirmShipSheet record={shipRecord} busy={shippingId === shipRecord?.id} onConfirm={confirmShip} onClose={() => setShipRecord(null)} />
    </div>
  )
}
