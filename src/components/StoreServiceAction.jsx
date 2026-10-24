import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, Loader2, PackageCheck, RefreshCw, X } from 'lucide-react'
import { api } from '../utils/api'
import { storeName } from '../utils/selectors'

const time = (value) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'
const notificationLabels = {
  PENDING: '待发送', SENDING: '发送中', ACCEPTED: '微信平台已受理', SENT: '微信平台已受理',
  NO_PERMISSION: '无可用订阅权限', NOT_SUBSCRIBED: '未订阅', FAILED: '明确失败', UNKNOWN: '发送结果不确定',
  BLOCKED: '发送条件未就绪', BLOCKED_CONFIG: '发送条件未就绪', SKIPPED: '未发送',
}

function ServiceDialog({ record, type, onClose }) {
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ carrier: '', trackingNo: '', deliveryProof: '', reason: '' })
  const pending = useRef(false)
  const mounted = useRef(true)
  const isMailing = type === 'MAILING'
  const flash = record.method === '同城闪送'
  const requestId = record.serviceRequestId
  const load = async () => {
    setLoading(true)
    try {
      const data = await api(`/v2/customer-requests/${encodeURIComponent(requestId)}/service`)
      if (!mounted.current) return
      setDetail(data.request)
      setForm((old) => ({ ...old, carrier: data.request.carrier || (flash ? '同城闪送' : ''), trackingNo: data.request.trackingNo || '', deliveryProof: data.request.deliveryProof || '' }))
      setError('')
    } catch (err) { if (mounted.current) setError(err.message || '申请加载失败，请重试') }
    finally { if (mounted.current) setLoading(false) }
  }
  useEffect(() => {
    mounted.current = true
    load()
    return () => { mounted.current = false }
  }, [requestId])
  const confirmed = isMailing ? Boolean(detail?.shipmentConfirmedAt) : Boolean(detail?.receiptConfirmedAt)
  const notificationRows = Array.isArray(detail?.notifications) ? detail.notifications : []
  const validShipment = form.carrier.trim() && form.carrier.trim().length <= 30
    && (flash ? form.deliveryProof.trim() : /^[A-Za-z0-9-]{6,80}$/.test(form.trackingNo.trim()))
  const canSubmit = detail && !loading && !busy && (!confirmed || editing) && (!isMailing || validShipment) && (!editing || form.reason.trim())
  const submit = async (event) => {
    event.preventDefault()
    if (pending.current || !canSubmit) return
    pending.current = true; setBusy(true); setError(''); setSuccess('')
    const action = isMailing ? (editing ? 'correct-shipment' : 'confirm-shipment') : 'confirm-receipt'
    try {
      await api(`/v2/customer-requests/${encodeURIComponent(requestId)}/${action}`, { method: 'POST', body: JSON.stringify(isMailing ? form : {}) })
      setSuccess(editing ? '配送信息已更正并留痕。不会重复发送提醒。' : isMailing ? '发货确认已保存。提醒结果以发送状态为准。' : '已确认公司收到申请。未标记已开票或已发送邮件。')
      setEditing(false)
      await load()
    } catch (err) {
      // A failed HTTP response does not prove that a confirmation was rolled
      // back. Read the original request before deliberately retrying it.
      setError(err.status && err.status < 500 ? err.message : '暂未确认操作结果，请先刷新本申请状态，再决定是否重试。')
    } finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const title = isMailing ? (editing ? '更正配送信息' : '发货与顾客提醒') : '确认收到开票申请'
  return createPortal(<div className="fixed inset-0 z-[210] flex items-end justify-center bg-slate-950/45 p-2 backdrop-blur-sm sm:items-center sm:p-6" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <section role="dialog" aria-modal="true" aria-label={title} className="max-h-[calc(100dvh-1rem)] w-full max-w-lg overflow-y-auto overscroll-contain rounded-[28px] bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:p-6">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="text-lg font-bold text-slate-900">{title}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{storeName(record.storeKey)} · 申请 {requestId}</p></div><button type="button" onClick={onClose} disabled={busy} aria-label="关闭申请详情" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-slate-500 hover:bg-slate-100"><X className="h-5 w-5" /></button></div>
      <dl className="mt-4 space-y-2 rounded-2xl bg-slate-50 p-3 text-sm leading-6 text-slate-700 [overflow-wrap:anywhere]">
        {isMailing ? <><div><dt className="text-xs text-slate-400">收件资料</dt><dd>{record.recipient} · {record.phone}</dd><dd>{record.address}</dd></div><div><dt className="text-xs text-slate-400">配送方式</dt><dd>{record.method}</dd></div></> : <>
          <div><dt className="text-xs text-slate-400">发票抬头</dt><dd className="font-semibold">{record.companyName}</dd></div>
          {record.taxNo && <div><dt className="text-xs text-slate-400">税号</dt><dd>{record.taxNo}</dd></div>}
          <div><dt className="text-xs text-slate-400">金额与收票邮箱</dt><dd>¥{(Number(record.amountCents) / 100).toFixed(2)} · {record.email}</dd></div>
          <div><dt className="text-xs text-slate-400">开票记录</dt><dd>{record.status === 'done' ? '已开票（原有记录）' : '待开票'}</dd></div>
        </>}
      </dl>
      {loading && <p className="mt-4 flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />正在核对申请状态…</p>}
      {error && <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-3 text-sm leading-6 text-rose-700">{error}</p>}
      {success && <p role="status" className="mt-4 rounded-xl bg-emerald-50 p-3 text-sm leading-6 text-emerald-800">{success}</p>}
      {detail && <>
        <div className="mt-4 rounded-xl border border-slate-200 p-3 text-sm leading-6 text-slate-600">
          {confirmed ? <><p className="font-semibold text-slate-800">{isMailing ? '开发者已确认发货' : '公司已收到开票申请'}</p><p>{time(isMailing ? detail.shipmentConfirmedAt : detail.receiptConfirmedAt)}</p><p className="[overflow-wrap:anywhere]">确认人：{(isMailing ? detail.shipmentConfirmedBy : detail.receiptConfirmedBy) || '记录暂不可用'}</p></> : <p>{isMailing ? '尚未确认发货' : '尚未确认收到申请'}</p>}
          {!isMailing && <p className="mt-1">本次仅确认收到资料，后续由财务办理。不代表已开票、已发邮件或顾客已收到发票。</p>}
          {isMailing && <p className="mt-1">人工确认不代表承运方已揽收，页面不生成物流轨迹。</p>}
          {confirmed && isMailing && <p className="mt-2 [overflow-wrap:anywhere]">{detail.carrier} · {detail.trackingNo || detail.deliveryProof || '配送凭证暂不可用'}</p>}
        </div>
        <div className="mt-3 rounded-xl bg-budu-50/60 p-3 text-xs leading-6 text-slate-600"><p className="font-semibold">顾客提醒</p>
          {!detail.customerBound ? <p>此历史申请未关联小程序顾客，不能按手机号或邮箱发送微信提醒。</p> : notificationRows.length ? notificationRows.map((item, index) => <p key={item.id || index}>{notificationLabels[String(item.status).toUpperCase()] || '发送状态待核验'}{item.acceptedAt || item.createdAt ? ` · ${time(item.acceptedAt || item.createdAt)}` : ''}</p>) : <p>尚无通知任务，确认后再查看发送状态。</p>}
          <p>平台受理不代表顾客已读；结果不确定时不会盲目重发。</p>
        </div>
        <form onSubmit={submit} className="mt-4 space-y-3">
          {isMailing && (!confirmed || editing) && <>
            <label className="block text-sm font-semibold text-slate-700">{flash ? '配送服务' : '快递公司'}<input className="input mt-2 min-h-11 w-full" aria-label={flash ? '配送服务' : '快递公司'} autoComplete="off" maxLength={30} required value={form.carrier} onChange={(event) => setForm((old) => ({ ...old, carrier: event.target.value }))} /></label>
            {flash ? <label className="block text-sm font-semibold text-slate-700">顾客可用的配送凭证<textarea className="input mt-2 min-h-24 w-full resize-y" aria-label="顾客可用的配送凭证" required maxLength={200} value={form.deliveryProof} onChange={(event) => setForm((old) => ({ ...old, deliveryProof: event.target.value }))} /><span className="mt-1 block text-xs font-normal leading-5 text-slate-500">填写顾客能核对的配送凭证或查询说明。没有快递运单号时不虚构单号。</span></label>
              : <label className="block text-sm font-semibold text-slate-700">可查件运单号<input className="input mt-2 min-h-11 w-full" aria-label="可查件运单号" autoComplete="off" required maxLength={80} value={form.trackingNo} onChange={(event) => setForm((old) => ({ ...old, trackingNo: event.target.value }))} /><span className="mt-1 block text-xs font-normal leading-5 text-slate-500">请填写承运方可查询的运单号，不是内部寄件订单编号。</span></label>}
            {editing && <label className="block text-sm font-semibold text-slate-700">更正原因<textarea className="input mt-2 min-h-20 w-full" aria-label="更正原因" required maxLength={200} value={form.reason} onChange={(event) => setForm((old) => ({ ...old, reason: event.target.value }))} /></label>}
          </>}
          {(!confirmed || editing) && <button type="submit" disabled={!canSubmit} className="btn-primary min-h-12 w-full justify-center disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{busy ? '正在保存…' : editing ? '保存更正，不重复提醒' : isMailing ? '确认已发货并通知顾客' : '确认已收到并通知顾客'}</button>}
          {confirmed && isMailing && !editing && <button type="button" onClick={() => setEditing(true)} className="btn-secondary min-h-11 w-full">更正配送信息</button>}
        </form>
      </>}
      <button type="button" onClick={load} disabled={busy || loading} className="btn-secondary mt-3 min-h-11 w-full"><RefreshCw className="h-4 w-4" />刷新申请状态</button>
    </section>
  </div>, document.body)
}

export default function StoreServiceAction({ record, type, currentUser, onUpdated }) {
  const [open, setOpen] = useState(false)
  if (currentUser?.role !== 'developer' || !record.serviceRequestId || !record.customerBound) return null
  return <>
    <button type="button" onClick={(event) => { event.stopPropagation(); setOpen(true) }} className="btn-primary min-h-11 w-full justify-center px-3 text-xs sm:w-auto">
      {type === 'MAILING' ? <PackageCheck className="h-4 w-4 shrink-0" /> : <CheckCircle2 className="h-4 w-4 shrink-0" />}
      {type === 'MAILING' ? '发货与顾客提醒' : '接收确认与顾客提醒'}
    </button>
    {open && <ServiceDialog record={record} type={type} onClose={() => { setOpen(false); onUpdated?.() }} />}
  </>
}
