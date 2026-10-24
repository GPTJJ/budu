import { useEffect, useState } from 'react'
import { BarChart3, ChevronDown, Loader2, RefreshCw } from 'lucide-react'
import { api } from '../utils/api'
import { allStores } from '../utils/selectors'

const todayBeijing = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const count = (value) => value == null ? '—' : Number(value).toLocaleString('zh-CN')
const money = (value) => value == null ? '—' : `¥${(Number(value) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function StoreServiceConversion({ currentUser, initialType = '' }) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState(initialType)
  const [storeKey, setStoreKey] = useState('')
  const [from, setFrom] = useState(() => `${todayBeijing().slice(0, 7)}-01`)
  const [to, setTo] = useState(todayBeijing)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const authorized = currentUser?.role === 'developer'
  useEffect(() => {
    if (!open || !authorized) return
    if (!from || !to || from > to) { setError('请选择正确的日期范围'); setData(null); return }
    let active = true
    setBusy(true); setError(''); setData(null)
    const params = new URLSearchParams({ from, to })
    if (storeKey) params.set('storeKey', storeKey)
    if (type) params.set('type', type)
    api(`/v2/customer-requests/conversion?${params}`)
      .then((result) => { if (active) setData(result.data) })
      .catch((err) => { if (active) setError(err.message || '统计暂不可用') })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [open, authorized, from, to, storeKey, type, refresh])
  if (!authorized) return null
  return <section className="card min-w-0 overflow-hidden" data-testid="store-service-conversion">
    <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex min-h-14 w-full items-center gap-2 px-4 py-3 text-left text-sm font-bold text-slate-800 sm:px-5"><BarChart3 className="h-5 w-5 shrink-0 text-budu-500" />门店服务 · 关联购买观察<ChevronDown className={`ml-auto h-4 w-4 shrink-0 transition ${open ? 'rotate-180' : ''}`} /></button>
    {open && <div className="space-y-4 border-t border-slate-100 p-4 sm:p-5">
      <p className="text-xs leading-6 text-slate-500">按服务来源观察后续线上购买，不代表全部为新增销售或因果收益。以下日期均为北京时间。</p>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="min-w-0 text-xs font-semibold text-slate-600">开始日期<input aria-label="观察开始日期" type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="input mt-1 min-h-11 w-full min-w-0" /></label>
        <label className="min-w-0 text-xs font-semibold text-slate-600">结束日期<input aria-label="观察结束日期" type="date" value={to} onChange={(event) => setTo(event.target.value)} className="input mt-1 min-h-11 w-full min-w-0" /></label>
        <label className="min-w-0 text-xs font-semibold text-slate-600">来源门店<select aria-label="观察来源门店" value={storeKey} onChange={(event) => setStoreKey(event.target.value)} className="input mt-1 min-h-11 w-full"><option value="">全部门店</option>{allStores().map((store) => <option key={store.key} value={store.key}>{store.name}</option>)}</select></label>
        <label className="min-w-0 text-xs font-semibold text-slate-600">服务类型<select aria-label="观察服务类型" value={type} onChange={(event) => setType(event.target.value)} className="input mt-1 min-h-11 w-full"><option value="">全部服务</option><option value="MAILING">邮寄</option><option value="INVOICE">开票申请</option></select></label>
      </div>
      {busy && <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />正在读取统计…</p>}
      {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm leading-6 text-rose-600">{error}</p>}
      {data && <>
        <div className="grid grid-cols-1 gap-2 min-[340px]:grid-cols-2 lg:grid-cols-4">{[['scannedCustomers', '有效扫码人数'], ['submittedCustomers', '成功提交人数'], ['mallVisitors', '进入商城人数'], ['anonymousVisits', '未识别访问次数']].map(([key, label]) => <div key={key} className="min-w-0 rounded-2xl bg-slate-50 p-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-2 break-all text-xl font-bold tabular-nums text-slate-900">{key === 'anonymousVisits' && data[key] == null ? '未采集' : count(data[key])}</p></div>)}</div>
        <div className="grid gap-3 lg:grid-cols-2">{(data.windows || []).map((window) => <section key={window.days} className="min-w-0 rounded-2xl border border-slate-200 p-4">
          <h4 className="text-sm font-bold text-slate-800">提交后 {window.days} 日累计观察</h4>
          <dl className="mt-3 space-y-2 text-sm">{[['关联购买人数', count(window.customers)], ['已支付订单数', count(window.orders)], ['已支付金额', money(window.paidCents)], ['关联退款金额', money(window.refundCents)], ['首次线上购买', window.firstPurchaseCustomers == null ? '未知' : count(window.firstPurchaseCustomers)], ['已有线上购买', count(window.returningCustomers)], ['历史不足，类型未知', count(window.unknownHistoryCustomers)]].map(([label, value]) => <div key={label} className="flex flex-wrap justify-between gap-x-3 gap-y-1"><dt className="text-slate-500">{label}</dt><dd className="break-all font-semibold tabular-nums text-slate-800">{value}</dd></div>)}</dl>
          <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">{window.immatureApplications == null ? '样本成熟度未核验' : `${count(window.immatureApplications)} 笔申请尚未达到完整 ${window.days} 日观察期`}</p>
        </section>)}</div>
        <div className="rounded-xl bg-budu-50/60 p-3 text-xs leading-6 text-slate-600"><p>支付前窗口内最近一次符合条件的服务提交获得归因；同一订单在同一窗口只计一次。7 日与 30 日为累计窗口，不能相加。退款单列，不计为额外销售。</p><p>{data.coverageNote || '统计覆盖范围暂未说明，请核实后使用。'}</p>{data.asOf && <p>数据截至 {new Date(data.asOf).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</p>}</div>
      </>}
      <button type="button" disabled={busy} className="btn-secondary min-h-11" onClick={() => setRefresh((value) => value + 1)}><RefreshCw className="h-4 w-4" />刷新统计</button>
    </div>}
  </section>
}
