import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, ClipboardCheck, PackageCheck, RefreshCw, Truck, X } from 'lucide-react'
import { api } from '../utils/api'
import { OverlayFooter, OverlayHeader, OverlayPanel, OverlayScrollRegion, OverlayViewport } from './overlay/OverlayPrimitives'

const FILTERS = [
  ['', '全部'],
  ['SUBMITTED', '待审核'],
  ['APPROVED', '待发货'],
  ['PARTIALLY_SHIPPED', '部分发货'],
  ['SHIPPED', '已发货'],
  ['REJECTED', '已驳回'],
  ['CANCELLED', '已取消'],
]
const STATUS_LABEL = { SUBMITTED: '待审核', APPROVED: '待发货', PARTIALLY_SHIPPED: '部分发货', SHIPPED: '已发货', REJECTED: '已驳回', CANCELLED: '已取消' }
const STATUS_TONE = {
  SUBMITTED: 'bg-amber-50 text-amber-700',
  APPROVED: 'bg-emerald-50 text-emerald-700',
  PARTIALLY_SHIPPED: 'bg-sky-50 text-sky-700',
  SHIPPED: 'bg-blue-50 text-blue-700',
  REJECTED: 'bg-rose-50 text-rose-700',
  CANCELLED: 'bg-slate-100 text-slate-600',
}
const money = (value) => `¥${(Number(value || 0) / 100).toFixed(2)}`
const unitLabel = (unit, nativeUnit = '') => unit === 'KG' ? 'kg' : unit === 'PCS' ? '颗' : nativeUnit || '单位'
const quantity = (value, unit, nativeUnit = '') => unit === 'KG' ? `${(Number(value || 0) / 1000).toFixed(3).replace(/\.?0+$/, '')} kg` : `${value} ${unitLabel(unit, nativeUnit)}`
const newKey = () => `review-${globalThis.crypto.randomUUID()}`
const newShipmentKey = () => `shipment-${globalThis.crypto.randomUUID()}`

function StatusPill({ value }) {
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-black ${STATUS_TONE[value] || STATUS_TONE.CANCELLED}`}>{STATUS_LABEL[value] || value}</span>
}

function ShipmentSection({ order, onShipped }) {
  const shippable = ['APPROVED', 'PARTIALLY_SHIPPED'].includes(order.status)
  const [stores, setStores] = useState([])
  const [storeKey, setStoreKey] = useState('guanshe')
  const [carrier, setCarrier] = useState('')
  const [trackingNumber, setTrackingNumber] = useState('')
  const [freightType, setFreightType] = useState('PREPAID')
  const [quantities, setQuantities] = useState(() => Object.fromEntries(order.items.map((item) => [item.id, '0'])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [idempotencyKey] = useState(newShipmentKey)

  useEffect(() => {
    if (!shippable) return
    api('/v2/partner-management/fulfillment-stores')
      .then((data) => { setStores(data.rows || []); setStoreKey(data.defaultStoreKey || 'guanshe') })
      .catch((nextError) => setError(nextError.data?.message || nextError.message))
  }, [shippable])

  const submit = async () => {
    const items = order.items.map((item) => ({ orderItemId: item.id, shippedQuantityBase: Number(quantities[item.id] || 0) })).filter((item) => item.shippedQuantityBase > 0)
    setBusy(true); setError('')
    try {
      const data = await api(`/v2/partner-management/replenishment-orders/${order.id}/shipments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ fulfillmentStoreKey: storeKey, carrier, trackingNumber, freightType, items }),
      })
      await onShipped(data.order)
    } catch (nextError) {
      setError(nextError.data?.message || nextError.message)
    } finally { setBusy(false) }
  }

  return (
    <section className="space-y-3 rounded-2xl border border-sky-100 bg-sky-50/40 p-4" aria-label="物流履约">
      <div className="flex items-center gap-2"><Truck className="h-5 w-5 text-sky-600" /><h3 className="font-black text-slate-800">物流履约</h3></div>
      {(order.shipments || []).map((shipment) => <article key={shipment.id} className="rounded-xl bg-white p-3 text-sm text-slate-600"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-slate-800">{shipment.carrier} · {shipment.trackingNumber}</strong><span className="text-xs text-slate-400">{shipment.freightType === 'COLLECT' ? '到付' : '寄付'}</span></div><p className="mt-1 text-xs text-slate-400">{new Date(shipment.shippedAt).toLocaleString('zh-CN', { hour12: false })} · {shipment.fulfillmentStoreName}</p><div className="mt-2 space-y-1">{shipment.items.map((item) => <p key={item.orderItemId}>{item.productNameSnapshot}：{quantity(item.shippedQuantityBase, item.orderUnitSnapshot, item.nativeUnitSnapshot)}</p>)}</div></article>)}
      {shippable && <div className="space-y-3 rounded-xl bg-white p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-bold text-slate-500">发货门店<select aria-label="发货门店" value={storeKey} onChange={(event) => setStoreKey(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm">{stores.map((store) => <option key={store.key} value={store.key}>{store.name}（{store.key}）</option>)}</select></label>
          <label className="text-xs font-bold text-slate-500">运费方式<select aria-label="运费方式" value={freightType} onChange={(event) => setFreightType(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm"><option value="PREPAID">寄付</option><option value="COLLECT">到付</option></select></label>
          <label className="text-xs font-bold text-slate-500">快递公司<input aria-label="快递公司" value={carrier} maxLength={80} onChange={(event) => setCarrier(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" /></label>
          <label className="text-xs font-bold text-slate-500">快递单号<input aria-label="快递单号" value={trackingNumber} maxLength={120} onChange={(event) => setTrackingNumber(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" /></label>
        </div>
        <div className="space-y-2">{order.items.filter((item) => item.approvedQuantityBase > 0).map((item) => <label key={item.id} className="grid items-center gap-2 rounded-xl bg-slate-50 p-3 text-xs font-bold text-slate-600 sm:grid-cols-[1fr_10rem]"><span>{item.productNameSnapshot}<span className="mt-1 block font-normal text-slate-400">已发 {quantity(item.shippedQuantityBase, item.orderUnitSnapshot, item.nativeUnitSnapshot)} · 待发 {quantity(item.remainingQuantityBase, item.orderUnitSnapshot, item.nativeUnitSnapshot)}</span></span><input aria-label={`${item.productNameSnapshot}本次发货数量`} type="number" min="0" max={item.remainingQuantityBase} step="1" disabled={item.remainingQuantityBase === 0} value={quantities[item.id] ?? '0'} onChange={(event) => setQuantities((value) => ({ ...value, [item.id]: event.target.value }))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm disabled:opacity-50" /></label>)}</div>
        <button type="button" disabled={busy || !carrier.trim() || !trackingNumber.trim() || !Object.values(quantities).some((value) => Number(value) > 0)} onClick={submit} className="btn-primary min-h-12 w-full disabled:opacity-40"><Truck className="h-4 w-4" />确认发货</button>
      </div>}
      {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700">{error}</p>}
    </section>
  )
}

function ReviewSheet({ order, onClose, onReviewed }) {
  const [draft, setDraft] = useState(() => Object.fromEntries(order.items.map((item) => [item.id, { quantity: item.requestedQuantityBase, reason: '' }])))
  const [reason, setReason] = useState(order.reviewReason || '')
  const [preview, setPreview] = useState(null)
  const [previewError, setPreviewError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [idempotencyKey] = useState(newKey)
  const editable = order.status === 'SUBMITTED'
  const reviewPayload = useMemo(() => ({
    version: order.version,
    reason,
    items: order.items.map((item) => ({
      itemId: item.id,
      approvedQuantityBase: Number(draft[item.id]?.quantity),
      reason: draft[item.id]?.reason || '',
    })),
  }), [draft, order, reason])

  useEffect(() => {
    if (!editable) return undefined
    const timer = setTimeout(() => {
      api(`/v2/partner-management/replenishment-orders/${order.id}/review-preview`, { method: 'POST', body: JSON.stringify(reviewPayload) })
        .then((data) => { setPreview(data.preview); setPreviewError('') })
        .catch((nextError) => { setPreview(null); setPreviewError(nextError.data?.message || nextError.message) })
    }, 250)
    return () => clearTimeout(timer)
  }, [editable, order.id, reviewPayload])

  const update = (itemId, patch) => setDraft((value) => ({ ...value, [itemId]: { ...value[itemId], ...patch } }))
  const submit = async (action) => {
    setBusy(true); setError('')
    try {
      const body = action === 'approve' ? reviewPayload : { version: order.version, reason }
      const data = await api(`/v2/partner-management/replenishment-orders/${order.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(body),
      })
      await onReviewed(data.order)
    } catch (nextError) {
      setError(nextError.data?.message || nextError.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <OverlayViewport className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:p-4">
      <button type="button" aria-label="关闭遮罩" onClick={onClose} className="budu-overlay-backdrop absolute inset-0 bg-slate-950/45 backdrop-blur-[2px]" />
      <OverlayPanel role="dialog" aria-modal="true" aria-label={`审核补货单 ${order.orderNo}`} className="relative flex max-h-[calc(100dvh-env(safe-area-inset-top))] w-full min-w-0 max-w-4xl flex-col overflow-hidden rounded-t-[28px] bg-white shadow-2xl sm:max-h-[92dvh] sm:rounded-[28px]">
        <OverlayHeader className="flex items-center justify-between border-b border-slate-100 px-4 py-4 sm:px-6">
          <div className="min-w-0"><p className="truncate text-lg font-black text-slate-900">{order.orderNo}</p><p className="mt-1 text-xs text-slate-400">{order.partnerNameSnapshot} · {order.partnerStore.name}</p></div>
          <button type="button" aria-label="关闭审核" onClick={onClose} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500"><X className="h-5 w-5" /></button>
        </OverlayHeader>
        <OverlayScrollRegion className="space-y-4 px-4 py-4 sm:px-6">
          <div className="grid gap-2 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600 sm:grid-cols-2">
            <p>提交来源：{order.createdByType === 'INTERNAL' ? 'budu 代下单' : '合作商提交'}</p>
            <p>申请金额：{money(order.requestedTotalAmountCents)}</p>
            <p className="sm:col-span-2">收货地址：{order.partnerStore.province}{order.partnerStore.city}{order.partnerStore.district}{order.partnerStore.addressLine}</p>
          </div>
          {order.items.map((item) => {
            const changed = Number(draft[item.id]?.quantity) !== item.requestedQuantityBase
            const previewLine = preview?.items?.find((row) => row.itemId === item.id)
            return (
              <article key={item.id} className="rounded-2xl border border-slate-100 p-4">
                <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-black text-slate-800">{item.productNameSnapshot}</p><p className="mt-1 text-xs text-slate-400">{item.productCodeSnapshot || item.skuSnapshot || '—'} · {item.orderUnitSnapshot}</p></div><p className="shrink-0 text-sm font-black text-slate-700">{money(item.requestedLineAmountCents)}</p></div>
                <div className="mt-3 grid gap-3 rounded-xl bg-budu-50/60 p-3 sm:grid-cols-2">
                  <p className="text-sm text-slate-600">原申请：<strong>{quantity(item.requestedQuantityBase, item.orderUnitSnapshot, item.nativeUnitSnapshot)}</strong></p>
                  {editable ? <label className="text-xs font-bold text-slate-500">确认数量（{item.orderUnitSnapshot === 'KG' ? '整数克' : `整数${unitLabel(item.orderUnitSnapshot, item.nativeUnitSnapshot)}`}）<input aria-label={`${item.productNameSnapshot}确认数量`} type="number" min="0" step="1" value={draft[item.id]?.quantity ?? ''} onChange={(event) => update(item.id, { quantity: event.target.value })} className="mt-1 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-budu-300 focus:ring-2 focus:ring-budu-100" /></label> : <p className="text-sm text-slate-600">确认数量：<strong>{item.approvedQuantityBase === 0 ? '本次不发' : quantity(item.approvedQuantityBase, item.orderUnitSnapshot, item.nativeUnitSnapshot)}</strong></p>}
                </div>
                {editable && changed && <label className="mt-3 block text-xs font-bold text-slate-500">调整说明（合作商可见）<input aria-label={`${item.productNameSnapshot}调整说明`} value={draft[item.id]?.reason || ''} onChange={(event) => update(item.id, { reason: event.target.value })} maxLength={300} className="mt-1 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-budu-300 focus:ring-2 focus:ring-budu-100" /></label>}
                <p className="mt-2 text-xs text-slate-400">冻结基价 {money(item.basePriceSnapshotCents)}/{unitLabel(item.orderUnitSnapshot, item.nativeUnitSnapshot)} · 折扣 {(item.discountBpsSnapshot / 100).toFixed(2)}% · 预计确认金额 {previewLine ? money(previewLine.approvedLineAmountCents) : '—'}</p>
              </article>
            )
          })}
          <label className="block text-xs font-bold text-slate-500">{editable ? '整单审核说明 / 驳回原因（合作商可见）' : '审核说明'}<textarea value={reason} readOnly={!editable} onChange={(event) => setReason(event.target.value)} maxLength={500} className="mt-1 min-h-20 w-full rounded-xl border border-slate-200 bg-white p-3 text-sm outline-none focus:border-budu-300 focus:ring-2 focus:ring-budu-100" /></label>
          {editable && <div className="rounded-2xl bg-slate-900 p-4 text-white"><p className="text-xs text-slate-300">服务端预计确认商品金额</p><p className="mt-1 text-2xl font-black">{preview ? money(preview.approvedTotalAmountCents) : '—'}</p><p className="mt-1 text-xs text-rose-300">{previewError}</p></div>}
          {!editable && order.approvedTotalAmountCents != null && <div className="rounded-2xl bg-emerald-50 p-4"><p className="text-xs text-emerald-600">最终确认商品金额</p><p className="mt-1 text-2xl font-black text-emerald-800">{money(order.approvedTotalAmountCents)}</p></div>}
          {!editable && order.approvedTotalAmountCents != null && <ShipmentSection order={order} onShipped={onReviewed} />}
          {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700">{error}</p>}
        </OverlayScrollRegion>
        {editable && <OverlayFooter className="grid shrink-0 grid-cols-2 gap-3 border-t border-slate-100 bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-6"><button type="button" disabled={busy || !reason.trim()} onClick={() => submit('reject')} className="min-h-12 rounded-xl bg-rose-50 font-bold text-rose-700 disabled:opacity-40">整单驳回</button><button type="button" disabled={busy || !preview} onClick={() => submit('approve')} className="btn-primary min-h-12 disabled:opacity-40"><Check className="h-4 w-4" />确认审核</button></OverlayFooter>}
      </OverlayPanel>
    </OverlayViewport>
  )
}

export default function PartnerReplenishmentReviewPage({ onBack }) {
  const [filter, setFilter] = useState('SUBMITTED')
  const [rows, setRows] = useState([])
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [authority, setAuthority] = useState(null)

  const load = async () => {
    setLoading(true); setError('')
    try {
      const data = await api(`/v2/partner-management/replenishment-orders${filter ? `?status=${filter}` : ''}`)
      setRows(data.rows || []); setAuthority(data.authority)
    } catch (nextError) {
      setRows([]); setError(nextError.data?.message || nextError.message)
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [filter])

  const open = async (id) => {
    setError('')
    try {
      const data = await api(`/v2/partner-management/replenishment-orders/${id}`)
      setSelected(data.order)
    } catch (nextError) { setError(nextError.data?.message || nextError.message) }
  }

  return (
    <section className="min-w-0 space-y-4" data-testid="partner-replenishment-review-page">
      <header className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><button type="button" onClick={onBack} className="grid h-11 w-11 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500"><ArrowLeft className="h-5 w-5" /></button><div><p className="text-xs font-black tracking-[0.12em] text-budu-500">PARTNER REPLENISHMENT</p><h2 className="text-xl font-black text-slate-900">补货订单</h2></div></div><button type="button" onClick={load} className="btn-secondary min-h-11"><RefreshCw className="h-4 w-4" />刷新</button></header>
      {authority && <p className="rounded-xl bg-budu-50 px-3 py-2 text-xs font-semibold text-budu-700">审核权限：{authority.type === 'GUANSHE_ON_DUTY' ? '官舍今日值班' : '开发者 / 管理员'} · 业务日期 {authority.businessDate}</p>}
      <div className="flex gap-2 overflow-x-auto pb-1" aria-label="补货订单筛选">{FILTERS.map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={`min-h-10 shrink-0 rounded-xl px-4 text-sm font-bold ${filter === value ? 'bg-budu-500 text-white' : 'bg-white text-slate-500 shadow-sm'}`}>{label}</button>)}</div>
      {error && <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm font-semibold text-rose-700">{error}</p>}
      {loading ? <div className="card p-8 text-center text-sm text-slate-400">加载补货订单…</div> : rows.length === 0 ? <div className="card grid min-h-56 place-items-center p-8 text-center"><div><ClipboardCheck className="mx-auto h-9 w-9 text-budu-300" /><p className="mt-3 text-sm text-slate-400">当前筛选下没有补货订单</p></div></div> : <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">{rows.map((order) => <button type="button" key={order.id} onClick={() => open(order.id)} className="w-full min-w-0 max-w-full overflow-hidden rounded-2xl border border-slate-100 bg-white p-4 text-left shadow-sm transition hover:border-budu-200"><div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-black text-slate-800">{order.orderNo}</p><p className="mt-1 truncate text-xs text-slate-400">{order.partnerNameSnapshot} · {order.partnerStore.name}</p></div><StatusPill value={order.status} /></div><div className="mt-4 flex min-w-0 items-end justify-between gap-3"><div className="min-w-0 text-xs text-slate-500"><p>{order.items.length} 项商品</p><p className="mt-1 truncate">{new Date(order.submittedAt).toLocaleString('zh-CN', { hour12: false })}</p></div><div className="shrink-0 text-right"><p className="text-xs text-slate-400">申请金额</p><p className="font-black text-slate-800">{money(order.requestedTotalAmountCents)}</p></div></div></button>)}</div>}
      {selected && <ReviewSheet order={selected} onClose={() => setSelected(null)} onReviewed={async () => { setSelected(null); await load() }} />}
      <div className="rounded-2xl border border-dashed border-slate-200 p-4 text-xs leading-5 text-slate-400"><PackageCheck className="mb-2 h-5 w-5 text-slate-300" />审核通过后可记录一批或多批物流；确认发货只保存履约事实，不扣库存、不预占库存、不创建付款记录。</div>
    </section>
  )
}
