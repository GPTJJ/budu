import { useEffect, useState } from 'react'
import { api } from '../utils/api'
import { canManageOrderPurpose, isTestOrderPurpose, ORDER_PURPOSE_LABELS } from '../../shared/orderPurpose'
import { OverlayFooter, OverlayHeader, OverlayPanel, OverlayScrollRegion, OverlayViewport } from './overlay/OverlayPrimitives'

const typeLabel = type => type === 'partner' ? 'Partner 补货' : '内部调拨'
const effectLabels = { payments: '支付', refunds: '退款', sweetCardLedger: '甜意卡流水', externalSettlement: '财务结算', salesOrderReferences: '销售关联', stockLedger: '库存流水', notificationObligations: '通知记录/投递义务', shipments: '发货', afterSales: '售后' }
const actionLabels = { classify: '确认订单用途', 'correct-purpose': '更正订单用途', 'delete-test': '删除测试订单', create: '创建测试副本' }

export default function OrderPurposeCenter({ user }) {
  const [rows, setRows] = useState([])
  const [audits, setAudits] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [detail, setDetail] = useState(null)
  const [mode, setMode] = useState('')
  const [purpose, setPurpose] = useState('REAL')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [key, setKey] = useState('')
  const load = async () => {
    setLoading(true); setError('')
    try { const result = await api('/v2/order-purpose/orders'); setRows(result.rows || []); setAudits(result.audits || []) }
    catch (err) { setError(err.data?.message || err.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { if (canManageOrderPurpose(user)) void load() }, [user?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!canManageOrderPurpose(user)) return null
  const open = async row => {
    setBusy(true); setError('')
    try { setDetail(await api(`/v2/order-purpose/${row.type}/${row.id}`)); setMode(''); setReason('') }
    catch (err) { setError(err.data?.message || err.message) }
    finally { setBusy(false) }
  }
  const choose = action => { setMode(action); setPurpose(action === 'create' ? 'ACCEPTANCE_TEST' : 'REAL'); setReason(''); setError(''); setKey(crypto.randomUUID()) }
  const submit = async () => {
    setBusy(true); setError('')
    try {
      const order = detail.order
      const route = mode === 'create' ? `/v2/order-purpose/test-${order.type}` : `/v2/order-purpose/${order.type}/${order.id}/${mode}`
      await api(route, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ purpose, expectedPurpose: order.purpose, reason, sourceId: order.id }) })
      setDetail(null); await load()
    } catch (err) { setError(err.data?.message || err.message) }
    finally { setBusy(false) }
  }
  return <section className="min-w-0 space-y-4">
    <p className="text-sm leading-6 text-slate-500">逐单确认历史用途。已发货、有资金记录或通知义务的订单不能标为可删除测试单。真实业务订单保留完整历史。</p>
    <div className="flex flex-wrap gap-2"><select aria-label="订单用途筛选" className="input min-w-0 flex-1" value={filter} onChange={e => setFilter(e.target.value)}><option value="">全部用途</option>{Object.entries(ORDER_PURPOSE_LABELS).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select><button className="btn-secondary" onClick={load} disabled={loading}>刷新</button></div>
    {error && !detail && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
    {loading ? <p className="p-6 text-center text-slate-400">加载订单…</p> : rows.filter(r => !filter || r.purpose === filter).length === 0 ? <p className="p-6 text-center text-slate-400">暂无该用途订单</p> : rows.filter(r => !filter || r.purpose === filter).map(row => <button key={`${row.type}:${row.id}`} disabled={busy} onClick={() => open(row)} className="block w-full min-w-0 rounded-2xl border border-slate-100 bg-white p-4 text-left shadow-sm"><span className="text-xs text-budu-600">{typeLabel(row.type)} · {ORDER_PURPOSE_LABELS[row.purpose]}</span><strong className="mt-1 block break-all text-sm text-slate-800">{row.orderNo}</strong><span className="mt-2 block text-xs text-slate-500">{row.status} · {row.partner || `${row.fromStoreKey} → ${row.toStoreKey}`} · {row.items.length} 项</span><span className="mt-1 block text-xs text-slate-400">{row.safety.safe ? '未发现业务副作用' : row.safety.blockers.map(b => effectLabels[b]).join('、')}</span></button>)}
    {audits.length > 0 && <details className="rounded-2xl border bg-white p-4 text-xs text-slate-500"><summary>永久操作审计（最近 {audits.length} 条）</summary>{audits.map(a => <div key={a.id} className="mt-3 break-all border-t pt-2"><p>{typeLabel(a.orderType)} · {a.orderNo} · {a.action}</p><p>{a.actorRole} · {a.actorId} · {new Date(a.createdAt).toLocaleString('zh-CN')}</p><p>{a.reason}</p><p>{ORDER_PURPOSE_LABELS[a.beforePurpose] || '新建'} → {ORDER_PURPOSE_LABELS[a.afterPurpose] || '已删除'}</p></div>)}</details>}
    {detail && <OverlayViewport className="fixed inset-0 z-[240] flex items-end justify-center bg-slate-950/50 sm:items-center sm:p-4">
      <OverlayPanel role="dialog" aria-modal="true" aria-label="订单用途与测试清理" className="flex max-h-[92dvh] w-full min-w-0 max-w-xl flex-col overflow-hidden rounded-t-3xl bg-white sm:rounded-3xl">
        <OverlayHeader className="flex shrink-0 items-center justify-between border-b p-4"><h3 className="font-bold text-slate-800">{actionLabels[mode] || '订单用途与测试清理'}</h3><button aria-label="关闭订单用途" className="min-h-11 px-3" disabled={busy} onClick={() => setDetail(null)}>关闭</button></OverlayHeader>
        <OverlayScrollRegion className="min-h-0 space-y-4 overflow-y-auto p-4">
          <dl className="space-y-2 break-words rounded-2xl bg-slate-50 p-4 text-sm text-slate-600"><div>单号：<span className="break-all">{detail.order.orderNo}</span></div><div>业务类型：{typeLabel(detail.order.type)}</div><div>订单用途：{ORDER_PURPOSE_LABELS[detail.order.purpose]}</div><div>状态：{detail.order.status}</div><div>创建时间：{new Date(detail.order.createdAt).toLocaleString('zh-CN')}</div><div>创建人：{detail.order.createdBy || '—'}</div><div>主体：{detail.order.partner || `${detail.order.fromStoreKey} → ${detail.order.toStoreKey}`}</div><div>关联商品行：{detail.order.items.length}</div></dl>
          <div className="rounded-2xl border p-3 text-xs text-slate-600"><strong>真实副作用检查</strong>{Object.entries(detail.safety.counts).map(([k,v]) => <p key={k} className="mt-1">{effectLabels[k]}：{v}</p>)}<p className="mt-2">{detail.safety.safe ? '当前未发现副作用；提交时将重新检查。' : '存在副作用或通知义务，禁止永久删除。'}</p></div>
          {!mode && <div className="flex flex-wrap gap-2">{detail.order.purpose === 'LEGACY_UNCLASSIFIED' ? <button className="btn-primary min-h-11" onClick={() => choose('classify')}>确认订单用途</button> : <button className="btn-secondary min-h-11" onClick={() => choose('correct-purpose')}>更正订单用途</button>}{isTestOrderPurpose(detail.order.purpose) && <button className="min-h-11 rounded-xl bg-rose-50 px-3 font-semibold text-rose-700" onClick={() => choose('delete-test')}>删除测试订单</button>}<button className="btn-secondary min-h-11" onClick={() => choose('create')}>创建测试副本</button></div>}
          {mode && <div className="space-y-3">{mode === 'delete-test' ? <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">该操作只用于清理测试数据，不可通过业务页面恢复。删除审计永久保留。</p> : <label className="block text-sm">{mode === 'create' ? '新副本用途（模板原单不变）' : '确认用途'}<select aria-label="确认用途" value={purpose} onChange={e => setPurpose(e.target.value)} className="input mt-1 w-full">{['REAL','TEST','ACCEPTANCE_TEST'].filter(v => mode !== 'create' || v !== 'REAL').map(v => <option key={v} value={v}>{ORDER_PURPOSE_LABELS[v]}</option>)}</select></label>}{mode === 'create' && <p className="text-xs leading-5 text-slate-500">复用本单商品及门店选择，以当前商品规则重新计算。测试副本不发送真实企业微信通知；请勿进行真实履约。</p>}<label className="block text-sm">操作原因<textarea aria-label="操作原因" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} className="input mt-1 min-h-24 w-full" /></label></div>}
          {detail.audits.length > 0 && <details className="text-xs text-slate-500"><summary>用途与删除审计（{detail.audits.length}）</summary>{detail.audits.map(a => <div key={a.id} className="mt-2 break-words rounded-xl bg-slate-50 p-3"><p>{a.action} · {a.actorRole} · {a.actorId}</p><p>{new Date(a.createdAt).toLocaleString('zh-CN')}</p><p>{ORDER_PURPOSE_LABELS[a.beforePurpose] || '新建'} → {ORDER_PURPOSE_LABELS[a.afterPurpose] || '已删除'}</p><p>{a.reason}</p></div>)}</details>}
          {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
        </OverlayScrollRegion>
        {mode && <OverlayFooter className="grid shrink-0 grid-cols-2 gap-3 border-t bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"><button className="btn-secondary min-h-12" disabled={busy} onClick={() => { setMode(''); setError('') }}>返回</button><button className="btn-primary min-h-12 disabled:opacity-40" disabled={busy || !reason.trim() || (mode === 'delete-test' && !detail.safety.safe)} onClick={submit}>{busy ? '处理中…' : '确认操作'}</button></OverlayFooter>}
      </OverlayPanel>
    </OverlayViewport>}
  </section>
}
