import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronRight, ClipboardList, Home, Loader2, Lock, LogIn, LogOut,
  Minus, PackagePlus, Plus, RefreshCw, RotateCcw, Search, Store, Truck, User, UserRound, X,
} from 'lucide-react'
import wordmarkUrl from '../../brand/web/budu-wordmark.svg'
import {
  PARTNER_ORDER_STATUS_LABELS,
  adjustShortcutQuantity,
  buildPartnerSubmission,
  buildReorderDraft,
  displayQuantity,
  orderMatchesGroup,
  parseDisplayQuantity,
  partnerUnitLabel,
  quantityLabel,
  quantityValidationMessage,
} from '../utils/partnerReplenishmentPortal.js'
import { OverlayPanel, OverlayScrollRegion, OverlayViewport } from './overlay/OverlayPrimitives'

async function partnerApi(path, options = {}) {
  const { headers, ...requestOptions } = options
  const response = await fetch(`/api/partner${path}`, {
    credentials: 'same-origin',
    ...requestOptions,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...headers },
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw Object.assign(new Error(data?.message || data?.error || `请求失败（${response.status}）`), { status: response.status })
  return data
}

const tabFromPath = () => ({ replenish: 'replenish', orders: 'orders', profile: 'profile' })[window.location.pathname.replace(/\/+$/, '').split('/')[2] || ''] || 'home'
const pathForTab = (tab) => tab === 'home' ? '/partner' : `/partner/${tab}`
const money = (value) => `¥${(Number(value || 0) / 100).toFixed(2)}`
const newOrderKey = () => `partner-order-${globalThis.crypto.randomUUID()}`

function StatusPill({ status }) {
  const tone = ({ SUBMITTED: 'bg-amber-50 text-amber-700', APPROVED: 'bg-emerald-50 text-emerald-700', PARTIALLY_SHIPPED: 'bg-sky-50 text-sky-700', SHIPPED: 'bg-blue-50 text-blue-700', REJECTED: 'bg-rose-50 text-rose-700', CANCELLED: 'bg-slate-100 text-slate-600' })[status] || 'bg-slate-100 text-slate-600'
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-black ${tone}`}>{PARTNER_ORDER_STATUS_LABELS[status] || status}</span>
}

function OrderDetail({ order, afterSales, onClose, onReorder, onCancel, onAfterSales, busy }) {
  return (
    <OverlayViewport className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:p-4">
      <button type="button" aria-label="关闭订单详情遮罩" onClick={onClose} className="budu-overlay-backdrop absolute inset-0 bg-slate-950/45" />
      <OverlayPanel role="dialog" aria-modal="true" aria-label={`补货单详情 ${order.orderNo}`} className="relative flex max-h-[calc(100dvh-env(safe-area-inset-top))] w-full max-w-2xl flex-col overflow-hidden rounded-t-[28px] bg-white shadow-2xl sm:max-h-[92dvh] sm:rounded-[28px]">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-6">
          <div className="min-w-0"><p className="truncate text-lg font-black text-slate-900">{order.orderNo}</p><div className="mt-2"><StatusPill status={order.status} /></div></div>
          <button type="button" aria-label="关闭订单详情" onClick={onClose} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500"><X className="h-5 w-5" /></button>
        </div>
        <OverlayScrollRegion className="space-y-4 px-4 py-4 sm:px-6">
          <section className="rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">
            <p><strong className="text-slate-800">收货门店：</strong>{order.partnerStore.name}</p>
            <p><strong className="text-slate-800">收货地址：</strong>{order.partnerStore.province}{order.partnerStore.city}{order.partnerStore.district}{order.partnerStore.addressLine}</p>
            <p><strong className="text-slate-800">提交时间：</strong>{new Date(order.submittedAt).toLocaleString('zh-CN', { hour12: false })}</p>
          </section>
          <section className="space-y-3" aria-label="订单商品">
            {(order.items || []).map((item) => (
              <article key={item.inventoryItemId} className="rounded-2xl border border-slate-100 p-4 text-sm text-slate-600">
                <div className="flex items-start justify-between gap-3"><div><p className="font-black text-slate-800">{item.productNameSnapshot}</p><p className="mt-1 text-xs text-slate-400">{item.productCodeSnapshot || item.skuSnapshot || '—'} · {item.orderUnitSnapshot}</p></div><p className="shrink-0 font-black text-slate-800">{money(item.requestedLineAmountCents)}</p></div>
                <p className="mt-3">申请 {quantityLabel(item.requestedQuantityBase, item.orderUnitSnapshot, item.nativeUnitSnapshot)}{item.approvedQuantityBase != null && <> → budu 确认 <strong>{item.approvedQuantityBase === 0 ? '本次不发' : quantityLabel(item.approvedQuantityBase, item.orderUnitSnapshot, item.nativeUnitSnapshot)}</strong></>}</p>
                {item.approvedQuantityBase > 0 && <p className="mt-1">已发 {quantityLabel(item.shippedQuantityBase, item.orderUnitSnapshot, item.nativeUnitSnapshot)} · 待发 {quantityLabel(item.remainingQuantityBase, item.orderUnitSnapshot, item.nativeUnitSnapshot)}</p>}
                {item.reviewReason && <p className="mt-1 text-xs text-slate-400">说明：{item.reviewReason}</p>}
              </article>
            ))}
          </section>
          <section className="grid grid-cols-2 gap-3 rounded-2xl bg-budu-50 p-4 text-sm"><div><p className="text-xs text-slate-400">申请商品金额</p><p className="mt-1 font-black text-slate-800">{money(order.requestedTotalAmountCents)}</p></div><div><p className="text-xs text-slate-400">确认商品金额</p><p className="mt-1 font-black text-slate-800">{order.approvedTotalAmountCents == null ? '待审核' : money(order.approvedTotalAmountCents)}</p></div></section>
          {(order.shipments || []).length > 0 && <section className="space-y-3"><h3 className="flex items-center gap-2 font-black text-slate-800"><Truck className="h-5 w-5 text-budu-500" />物流记录</h3>{order.shipments.map((shipment) => <article key={shipment.id} className="rounded-2xl border border-sky-100 bg-sky-50/50 p-4 text-sm text-slate-600"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-slate-800">{shipment.carrier} · {shipment.trackingNumber}</strong><span>{shipment.freightType === 'COLLECT' ? '到付' : '寄付'}</span></div><p className="mt-1 text-xs text-slate-400">{new Date(shipment.shippedAt).toLocaleString('zh-CN', { hour12: false })} · {shipment.fulfillmentStoreName}</p><div className="mt-2">{shipment.items.map((item) => <p key={item.orderItemId}>{item.productNameSnapshot}：{quantityLabel(item.shippedQuantityBase, item.orderUnitSnapshot, item.nativeUnitSnapshot)}</p>)}</div></article>)}</section>}
          {afterSales.length > 0 && <section className="space-y-2"><h3 className="font-black text-slate-800">售后申请</h3>{afterSales.map((request) => <article key={request.id} className="rounded-2xl border border-amber-100 bg-amber-50/50 p-4 text-sm text-slate-600"><div className="flex justify-between gap-2"><strong className="text-slate-800">{{ DAMAGED: '破损', WRONG_ITEM: '错发', RETURN: '退货' }[request.type]} · {request.productName}</strong><span className="font-bold text-amber-700">{{ PENDING: '待处理', PROCESSING: '处理中', RESOLVED: '已解决', REJECTED: '已拒绝' }[request.status]}</span></div><p className="mt-1">{quantityLabel(request.quantityBase, request.orderUnit, request.nativeUnit)} · {request.description}</p>{request.resultNote && <p className="mt-1 text-xs text-slate-400">处理结果：{request.resultNote}</p>}</article>)}</section>}
          {order.status === 'REJECTED' && order.reviewReason && <p className="rounded-2xl bg-rose-50 p-4 text-sm font-semibold text-rose-700">驳回原因：{order.reviewReason}</p>}
        </OverlayScrollRegion>
        <div className="grid shrink-0 grid-cols-2 gap-3 border-t border-slate-100 bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-6"><button type="button" onClick={() => onReorder(order)} disabled={busy} className="btn-primary min-h-12"><RotateCcw className="h-4 w-4" />再次补货</button>{(order.shipments || []).length > 0 ? <button type="button" onClick={() => onAfterSales(order)} disabled={busy} className="btn-secondary min-h-12">申请售后</button> : order.status === 'SUBMITTED' ? <button type="button" onClick={() => onCancel(order)} disabled={busy} className="min-h-12 rounded-xl bg-slate-100 font-bold text-slate-600 disabled:opacity-40">取消申请</button> : <button type="button" onClick={onClose} className="btn-secondary min-h-12">完成</button>}</div>
      </OverlayPanel>
    </OverlayViewport>
  )
}

function AfterSalesForm({ order, onClose, onCreated }) {
  const shipmentItems = (order.shipments || []).flatMap((shipment) => shipment.items.map((item) => ({ ...item, shipmentLabel: `${shipment.carrier} · ${shipment.trackingNumber}` }))).filter((item) => item.id)
  const [shipmentItemId, setShipmentItemId] = useState(shipmentItems[0]?.id || '')
  const [type, setType] = useState('DAMAGED')
  const [quantity, setQuantity] = useState('')
  const [description, setDescription] = useState('')
  const [attachments, setAttachments] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selectedItem = shipmentItems.find((item) => item.id === shipmentItemId)
  const filesChanged = async (event) => {
    const files = [...event.target.files].slice(0, 3)
    try {
      const rows = await Promise.all(files.map((file) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, fileType: file.type, dataUrl: reader.result }); reader.onerror = reject; reader.readAsDataURL(file) })))
      setAttachments(rows); setError('')
    } catch { setError('图片读取失败，请重试') }
  }
  const submit = async () => {
    const quantityBase = parseDisplayQuantity(quantity, selectedItem?.orderUnitSnapshot)
    if (!quantityBase || quantityBase > Number(selectedItem?.shippedQuantityBase || 0)) { setError('售后数量必须是本批已发数量范围内的整数基础单位'); return }
    setBusy(true); setError('')
    try {
      await partnerApi('/after-sales', { method: 'POST', body: JSON.stringify({ orderId: order.id, shipmentItemId, type, quantityBase, description, attachments }) })
      await onCreated()
    } catch (nextError) { setError(nextError.message) } finally { setBusy(false) }
  }
  return <OverlayViewport className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center sm:p-4"><button type="button" aria-label="关闭售后申请遮罩" onClick={onClose} className="budu-overlay-backdrop absolute inset-0 bg-slate-950/45" /><OverlayPanel role="dialog" aria-modal="true" aria-label="申请售后" className="relative flex max-h-[calc(100dvh-env(safe-area-inset-top))] w-full max-w-xl flex-col overflow-hidden rounded-t-[28px] bg-white sm:max-h-[92dvh] sm:rounded-[28px]"><div className="flex items-center justify-between border-b border-slate-100 p-4"><div><p className="text-lg font-black text-slate-900">申请售后</p><p className="text-xs text-slate-400">{order.orderNo}</p></div><button type="button" aria-label="关闭售后申请" onClick={onClose} className="grid h-11 w-11 place-items-center rounded-xl bg-slate-100"><X className="h-5 w-5" /></button></div><OverlayScrollRegion className="space-y-4 p-4"><label className="block text-xs font-bold text-slate-500">售后类型<select aria-label="售后类型" value={type} onChange={(event) => setType(event.target.value)} className="mt-1 min-h-12 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm"><option value="DAMAGED">破损</option><option value="WRONG_ITEM">错发</option><option value="RETURN">退货</option></select></label><label className="block text-xs font-bold text-slate-500">本批发货商品<select aria-label="本批发货商品" value={shipmentItemId} onChange={(event) => { setShipmentItemId(event.target.value); setQuantity('') }} className="mt-1 min-h-12 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm">{shipmentItems.map((item) => <option key={item.id} value={item.id}>{item.productNameSnapshot} · {item.shipmentLabel} · 已发 {quantityLabel(item.shippedQuantityBase, item.orderUnitSnapshot, item.nativeUnitSnapshot)}</option>)}</select></label><label className="block text-xs font-bold text-slate-500">售后数量（{partnerUnitLabel(selectedItem?.orderUnitSnapshot, selectedItem?.nativeUnitSnapshot)}）<input aria-label="售后数量" type="number" inputMode={selectedItem?.orderUnitSnapshot === 'KG' ? 'decimal' : 'numeric'} step={selectedItem?.orderUnitSnapshot === 'KG' ? '0.001' : '1'} value={quantity} onChange={(event) => setQuantity(event.target.value)} className="mt-1 min-h-12 w-full rounded-xl border border-slate-200 px-3 text-base" /></label><label className="block text-xs font-bold text-slate-500">问题描述<textarea aria-label="问题描述" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} className="mt-1 min-h-24 w-full rounded-xl border border-slate-200 p-3 text-sm" /></label><label className="block text-xs font-bold text-slate-500">问题图片（最多 3 张）<input aria-label="问题图片" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={filesChanged} className="mt-1 min-h-12 w-full rounded-xl border border-slate-200 p-2 text-sm" /></label>{attachments.length > 0 && <p className="text-xs text-slate-400">已选择 {attachments.length} 张图片</p>}{error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700">{error}</p>}</OverlayScrollRegion><div className="border-t border-slate-100 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"><button type="button" disabled={busy || !shipmentItemId || !description.trim()} onClick={submit} className="btn-primary min-h-12 w-full disabled:opacity-40">{busy && <Loader2 className="h-4 w-4 animate-spin" />}提交售后申请</button></div></OverlayPanel></OverlayViewport>
}

function Login({ loading, busy, username, password, error, setUsername, setPassword, onSubmit }) {
  return (
    <main className="grid min-h-screen min-h-[100dvh] place-items-center overflow-x-hidden bg-canvas px-3 py-6" style={{ paddingTop: 'max(1.5rem, env(safe-area-inset-top))', paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}>
      <section className="w-full max-w-sm rounded-3xl border border-budu-100 bg-white p-6 shadow-card sm:p-8" aria-busy={loading || busy}>
        <header className="text-center"><img src={wordmarkUrl} alt="budu" className="mx-auto h-auto w-28" /><p className="mt-4 text-xs font-black tracking-[0.16em] text-budu-500">budu Partner</p><h1 className="mt-2 text-xl font-black text-slate-800">合作伙伴中心</h1></header>
        {loading ? <div className="grid min-h-48 place-items-center" aria-label="正在验证合作商登录状态"><Loader2 className="h-6 w-6 animate-spin text-budu-500" /></div> : <form onSubmit={onSubmit} className="mt-6 space-y-4"><label className="relative block"><span className="sr-only">用户名</span><User className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" /><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" placeholder="用户名" className="input min-h-11 pl-10" /></label><label className="relative block"><span className="sr-only">密码</span><Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder="密码" className="input min-h-11 pl-10" /></label>{error && <p className="text-sm font-medium text-rose-600" role="alert">{error}</p>}<button type="submit" disabled={busy || !username.trim() || password.length < 6} className="btn-primary min-h-11 w-full disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}登录合作伙伴中心</button></form>}
      </section>
    </main>
  )
}

function BottomNav({ view, navigate }) {
  const tabs = [{ key: 'home', label: '首页', icon: Home }, { key: 'replenish', label: '我要补货', icon: PackagePlus }, { key: 'orders', label: '补货订单', icon: ClipboardList }, { key: 'profile', label: '我的', icon: UserRound }]
  return <nav aria-label="合作伙伴中心导航" className="fixed inset-x-0 bottom-0 z-40 mx-auto grid w-full max-w-3xl grid-cols-4 border-t border-slate-200 bg-white/95 px-1 pt-1 backdrop-blur" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>{tabs.map(({ key, label, icon: Icon }) => <button key={key} type="button" aria-current={view === key ? 'page' : undefined} onClick={() => navigate(key)} className={`grid min-h-14 place-items-center rounded-xl py-1 text-[11px] font-bold ${view === key ? 'text-budu-600' : 'text-slate-400'}`}><Icon className="h-5 w-5" /><span>{label}</span></button>)}</nav>
}

export default function PartnerAccessPage() {
  const [principal, setPrincipal] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [dataError, setDataError] = useState('')
  const [dataLoading, setDataLoading] = useState(false)
  const [profile, setProfile] = useState(null)
  const [stores, setStores] = useState([])
  const [orders, setOrders] = useState([])
  const [afterSales, setAfterSales] = useState([])
  const [catalogue, setCatalogue] = useState([])
  const [catalogueLoading, setCatalogueLoading] = useState(false)
  const [catalogueError, setCatalogueError] = useState('')
  const [view, setView] = useState(tabFromPath)
  const [selectedOrder, setSelectedOrder] = useState(null)
  const [afterSalesOrder, setAfterSalesOrder] = useState(null)
  const [orderGroup, setOrderGroup] = useState('all')
  const [selectedStoreId, setSelectedStoreId] = useState('')
  const [selected, setSelected] = useState({})
  const [quantityInputs, setQuantityInputs] = useState({})
  const [quotes, setQuotes] = useState({})
  const [quotedSignature, setQuotedSignature] = useState('')
  const [draftMessages, setDraftMessages] = useState([])
  const [orderKey, setOrderKey] = useState(newOrderKey)

  const loadPortal = useCallback(async () => {
    setDataLoading(true); setDataError('')
    try {
      const [profileData, storeData, orderData, afterSalesData] = await Promise.all([partnerApi('/profile'), partnerApi('/stores'), partnerApi('/replenishment-orders'), partnerApi('/after-sales').catch(() => ({ rows: [] }))])
      setProfile(profileData.partner); setStores(storeData.rows || []); setOrders(orderData.rows || [])
      setAfterSales(afterSalesData.rows || [])
      setSelectedStoreId((current) => current || (storeData.rows || []).find((store) => store.status === 'ACTIVE')?.id || '')
    } catch (nextError) { setDataError(nextError.message) } finally { setDataLoading(false) }
  }, [])

  // Keep the callback independent of its result: an empty directory is a completed load.
  const loadCatalogue = useCallback(async () => {
    setCatalogueLoading(true); setCatalogueError('')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)
    try {
      const data = await partnerApi('/catalogue', { signal: controller.signal })
      if (!Array.isArray(data?.rows)) throw new Error('商品目录响应异常，请重试')
      setCatalogue(data.rows)
      return data.rows
    } catch (error) {
      const message = error.name === 'AbortError' ? '商品目录加载超时，请重试' : error.message
      setCatalogueError(message)
      throw new Error(message)
    } finally { clearTimeout(timeout); setCatalogueLoading(false) }
  }, [])

  useEffect(() => { partnerApi('/auth/me').then((data) => setPrincipal(data.principal)).catch(() => setPrincipal(null)).finally(() => setAuthLoading(false)) }, [])
  useEffect(() => { if (principal) loadPortal(); else { setProfile(null); setStores([]); setOrders([]); setAfterSales([]); setCatalogue([]); setCatalogueError('') } }, [principal, loadPortal])
  useEffect(() => { if (principal && view === 'replenish') loadCatalogue().catch(() => {}) }, [principal, view, loadCatalogue])
  useEffect(() => { const back = () => setView(tabFromPath()); window.addEventListener('popstate', back); return () => window.removeEventListener('popstate', back) }, [])

  const navigate = (nextView) => { setView(nextView); window.history.pushState({}, '', pathForTab(nextView)); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  const login = async (event) => { event.preventDefault(); setBusy(true); setError(''); try { const data = await partnerApi('/auth/login', { method: 'POST', body: JSON.stringify({ username: username.trim(), password }) }); setPrincipal(data.principal); setPassword('') } catch { setError('用户名、密码或合作商账号状态不正确') } finally { setBusy(false) } }
  const logout = async () => { setBusy(true); await partnerApi('/auth/logout', { method: 'POST' }).catch(() => {}); setPrincipal(null); window.history.replaceState({}, '', '/partner'); setView('home'); setBusy(false) }

  const activeStores = stores.filter((store) => store.status === 'ACTIVE')
  const selectionSignature = useMemo(() => JSON.stringify({ selectedStoreId, selected, quantityInputs }), [selectedStoreId, selected, quantityInputs])
  const selectedProducts = catalogue.filter((product) => Number(selected[product.productId]) > 0)
  const hasInvalidQuantityInput = catalogue.some((product) => {
    const raw = quantityInputs[product.productId]
    return typeof raw === 'string' && raw.trim() !== '' && !parseDisplayQuantity(raw, product.orderUnit)
  })
  const updateQuantity = (product, raw) => {
    const quantityBase = parseDisplayQuantity(raw, product.orderUnit)
    setQuantityInputs((value) => ({ ...value, [product.productId]: raw }))
    setSelected((value) => ({ ...value, [product.productId]: quantityBase || 0 }))
    setQuotedSignature(''); setQuotes({}); setDraftMessages([])
  }
  const quote = async () => {
    setBusy(true); setDraftMessages([])
    try {
      if (hasInvalidQuantityInput) throw new Error('请先修正无效的补货数量')
      buildPartnerSubmission({ partnerStoreId: selectedStoreId, selected, catalogue })
      const rows = await Promise.all(selectedProducts.map(async (product) => {
        const quantityBase = Number(selected[product.productId])
        const quantity = product.orderUnit === 'KG' ? { quantityGrams: quantityBase } : product.orderUnit === 'PCS' ? { quantityPieces: quantityBase } : { quantityUnits: quantityBase }
        const body = { productId: product.productId, orderUnit: product.orderUnit, ...quantity }
        const data = await partnerApi('/catalogue/quote', { method: 'POST', body: JSON.stringify(body) })
        return [product.productId, data.quote]
      }))
      setQuotes(Object.fromEntries(rows)); setQuotedSignature(selectionSignature)
    } catch (nextError) { setQuotedSignature(''); setQuotes({}); setDraftMessages([nextError.message]) } finally { setBusy(false) }
  }
  const submit = async () => {
    if (quotedSignature !== selectionSignature) { setDraftMessages(['数量或门店已变化，请重新获取预计金额']); return }
    setBusy(true); setDraftMessages([])
    try {
      const body = buildPartnerSubmission({ partnerStoreId: selectedStoreId, selected, catalogue })
      await partnerApi('/replenishment-orders', { method: 'POST', headers: { 'Idempotency-Key': orderKey }, body: JSON.stringify(body) })
      setSelected({}); setQuantityInputs({}); setQuotes({}); setQuotedSignature(''); setOrderKey(newOrderKey()); await loadPortal(); navigate('orders')
    } catch (nextError) { setDraftMessages([nextError.message]) } finally { setBusy(false) }
  }
  const reorder = async (order) => {
    setBusy(true)
    try {
      const currentCatalogue = await loadCatalogue()
      const draft = buildReorderDraft(order, currentCatalogue)
      setSelected(Object.fromEntries(draft.items.map((item) => [item.productId, item.quantityBase])))
      setQuantityInputs(Object.fromEntries(draft.items.map((item) => {
        const product = currentCatalogue.find((row) => row.productId === item.productId)
        return [item.productId, displayQuantity(item.quantityBase, product?.orderUnit)]
      })))
      setSelectedStoreId(activeStores.some((store) => store.id === draft.storeId) ? draft.storeId : activeStores[0]?.id || '')
      setDraftMessages(draft.issues); setQuotes({}); setQuotedSignature(''); setSelectedOrder(null); navigate('replenish')
    } catch (nextError) { setDraftMessages([nextError.message]) } finally { setBusy(false) }
  }
  const cancel = async (order) => { setBusy(true); try { await partnerApi(`/replenishment-orders/${order.id}/cancel`, { method: 'POST' }); setSelectedOrder(null); await loadPortal() } catch (nextError) { setDataError(nextError.message) } finally { setBusy(false) } }

  if (!principal) return <Login loading={authLoading} busy={busy} username={username} password={password} error={error} setUsername={setUsername} setPassword={setPassword} onSubmit={login} />

  const stats = { pending: orders.filter((row) => row.status === 'SUBMITTED').length, approved: orders.filter((row) => row.status === 'APPROVED').length, moving: orders.filter((row) => row.status === 'PARTIALLY_SHIPPED').length }
  const filteredOrders = orders.filter((order) => orderMatchesGroup(order, orderGroup))
  const quoteTotal = Object.values(quotes).reduce((sum, row) => sum + Number(row.finalAmountCents || 0), 0)

  return (
    <main className={`min-h-screen min-h-[100dvh] overflow-x-hidden bg-canvas ${view === 'replenish' ? 'pb-[calc(13rem+env(safe-area-inset-bottom))]' : 'pb-24'}`} style={{ paddingTop: 'env(safe-area-inset-top)' }} data-testid="partner-portal">
      <header className="sticky top-0 z-30 border-b border-slate-100 bg-white/95 px-4 py-3 backdrop-blur"><div className="mx-auto flex max-w-3xl items-center justify-between"><div><img src={wordmarkUrl} alt="budu" className="h-auto w-20" /><p className="mt-1 text-[10px] font-black tracking-[0.12em] text-budu-500">budu Partner · 合作伙伴中心</p></div><button type="button" onClick={loadPortal} aria-label="刷新合作伙伴中心" className="grid h-11 w-11 place-items-center rounded-xl bg-budu-50 text-budu-600"><RefreshCw className={`h-4 w-4 ${dataLoading ? 'animate-spin' : ''}`} /></button></div></header>
      <div className="mx-auto w-full max-w-3xl space-y-4 px-3 py-4 sm:px-4">
        {dataError && <div role="alert" className="rounded-2xl bg-rose-50 p-4 text-sm font-semibold text-rose-700"><p>{dataError}</p><button type="button" onClick={loadPortal} className="mt-3 min-h-11 rounded-xl bg-white px-4">重试</button></div>}
        {dataLoading && !profile ? <div className="grid min-h-64 place-items-center"><Loader2 className="h-7 w-7 animate-spin text-budu-500" /></div> : <>
          {view === 'home' && <HomeView profile={profile} principal={principal} orders={orders} stats={stats} navigate={navigate} openOrder={setSelectedOrder} setOrderGroup={setOrderGroup} />}
          {view === 'replenish' && <ReplenishView catalogue={catalogue} catalogueLoading={catalogueLoading} catalogueError={catalogueError} onReloadCatalogue={() => loadCatalogue().catch(() => {})} activeStores={activeStores} selectedStoreId={selectedStoreId} setSelectedStoreId={(id) => { setSelectedStoreId(id); setQuotedSignature(''); setQuotes({}) }} selected={selected} quantityInputs={quantityInputs} updateQuantity={updateQuantity} quotes={quotes} quoted={quotedSignature === selectionSignature} quoteTotal={quoteTotal} messages={draftMessages} busy={busy} hasInvalidQuantityInput={hasInvalidQuantityInput} onQuote={quote} onSubmit={submit} />}
          {view === 'orders' && <OrdersView orders={filteredOrders} orderGroup={orderGroup} setOrderGroup={setOrderGroup} openOrder={setSelectedOrder} />}
          {view === 'profile' && <ProfileView profile={profile} stores={stores} principal={principal} busy={busy} logout={logout} />}
        </>}
      </div>
      <BottomNav view={view} navigate={navigate} />
      {selectedOrder && <OrderDetail order={selectedOrder} afterSales={afterSales.filter((request) => request.orderId === selectedOrder.id)} onClose={() => setSelectedOrder(null)} onReorder={reorder} onCancel={cancel} onAfterSales={(order) => { setSelectedOrder(null); setAfterSalesOrder(order) }} busy={busy} />}
      {afterSalesOrder && <AfterSalesForm order={afterSalesOrder} onClose={() => setAfterSalesOrder(null)} onCreated={async () => { setAfterSalesOrder(null); await loadPortal() }} />}
    </main>
  )
}

function HomeView({ profile, principal, orders, stats, navigate, openOrder, setOrderGroup }) {
  return <section className="space-y-4" aria-label="合作伙伴首页"><div className="rounded-3xl bg-gradient-to-br from-budu-500 to-budu-700 p-5 text-white shadow-card"><p className="text-sm text-white/75">欢迎回来</p><h1 className="mt-1 text-2xl font-black">{profile?.name || principal.partner?.name}</h1><button type="button" onClick={() => navigate('replenish')} className="mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white font-black text-budu-700"><PackagePlus className="h-5 w-5" />发起补货</button></div><div className="grid grid-cols-3 gap-2"><button type="button" onClick={() => { setOrderGroup('pending'); navigate('orders') }} className="rounded-2xl bg-white p-3 text-left shadow-sm"><p className="text-2xl font-black text-amber-600">{stats.pending}</p><p className="mt-1 text-xs text-slate-500">待审核</p></button><button type="button" onClick={() => { setOrderGroup('fulfillment'); navigate('orders') }} className="rounded-2xl bg-white p-3 text-left shadow-sm"><p className="text-2xl font-black text-emerald-600">{stats.approved}</p><p className="mt-1 text-xs text-slate-500">待发货</p></button><button type="button" onClick={() => { setOrderGroup('fulfillment'); navigate('orders') }} className="rounded-2xl bg-white p-3 text-left shadow-sm"><p className="text-2xl font-black text-sky-600">{stats.moving}</p><p className="mt-1 text-xs leading-4 text-slate-500">部分发货<br />运输中</p></button></div><section><div className="mb-3 flex items-center justify-between"><h2 className="font-black text-slate-800">最近补货单</h2><button type="button" onClick={() => navigate('orders')} className="text-sm font-bold text-budu-600">查看全部</button></div><div className="space-y-3">{orders.slice(0, 3).map((order) => <button key={order.id} type="button" onClick={() => openOrder(order)} className="flex min-h-20 w-full items-center justify-between gap-3 rounded-2xl bg-white p-4 text-left shadow-sm"><div className="min-w-0"><p className="truncate font-black text-slate-800">{order.orderNo}</p><p className="mt-1 text-xs text-slate-400">{order.partnerStore.name} · {money(order.requestedTotalAmountCents)}</p></div><StatusPill status={order.status} /></button>)}{orders.length === 0 && <div className="rounded-2xl bg-white p-8 text-center text-sm text-slate-400">还没有补货单，点击上方按钮开始。</div>}</div></section></section>
}

function ReplenishView({ catalogue, catalogueLoading, catalogueError, onReloadCatalogue, activeStores, selectedStoreId, setSelectedStoreId, selected, quantityInputs, updateQuantity, quotes, quoted, quoteTotal, messages, busy, hasInvalidQuantityInput, onQuote, onSubmit }) {
  const uncategorizedId = '__partner_uncategorized__'
  const [categoryId, setCategoryId] = useState('all')
  const [search, setSearch] = useState('')
  const categories = useMemo(() => {
    const byId = new Map()
    let hasUncategorized = false
    catalogue.forEach((product) => {
      if (product.productCategory?.id) byId.set(product.productCategory.id, product.productCategory)
      else hasUncategorized = true
    })
    const rows = [...byId.values()].sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id))
    if (hasUncategorized) rows.push({ id: uncategorizedId, name: '其他', sortOrder: Number.MAX_SAFE_INTEGER })
    return rows
  }, [catalogue])
  useEffect(() => {
    if (categoryId !== 'all' && !categories.some((category) => category.id === categoryId)) setCategoryId('all')
  }, [categories, categoryId])
  const normalizedSearch = search.trim().toLocaleLowerCase('zh-CN')
  const filteredCatalogue = catalogue.filter((product) => {
    const productCategoryId = product.productCategory?.id || uncategorizedId
    const inCategory = categoryId === 'all' || productCategoryId === categoryId
    const matchesSearch = !normalizedSearch || `${product.name} ${product.sku || ''}`.toLocaleLowerCase('zh-CN').includes(normalizedSearch)
    return inCategory && matchesSearch
  })
  const groupedCatalogue = categories
    .map((category) => ({ category, products: filteredCatalogue.filter((product) => (product.productCategory?.id || uncategorizedId) === category.id) }))
    .filter((group) => group.products.length > 0)
  const selectedProducts = catalogue.filter((product) => Number(selected[product.productId]) > 0)
  return (
    <section className="space-y-4" aria-label="我要补货">
      <header>
        <p className="text-xs font-black tracking-[0.12em] text-budu-500">REPLENISH</p>
        <h1 className="mt-1 text-2xl font-black text-slate-900">我要补货</h1>
        <p className="mt-2 text-sm text-slate-500">预计金额仅供确认，提交时服务端会重新读取当前价格、折扣与商品规则。</p>
      </header>
      <label className="block rounded-2xl bg-white p-4 text-xs font-bold text-slate-500 shadow-sm">
        收货门店
        <select aria-label="收货门店" value={selectedStoreId} onChange={(event) => setSelectedStoreId(event.target.value)} className="mt-2 min-h-12 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800">
          {activeStores.map((store) => <option key={store.id} value={store.id}>{store.name} · {store.province}{store.city}{store.district}</option>)}
        </select>
      </label>
      {catalogueLoading ? (
        <div role="status" aria-label="正在加载商品目录" className="grid min-h-48 place-items-center"><Loader2 className="h-6 w-6 animate-spin text-budu-500" /></div>
      ) : catalogueError ? (
        <div role="alert" className="space-y-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-800">
          <p>{catalogueError}</p><button type="button" onClick={onReloadCatalogue} className="btn-secondary min-h-12">重试加载商品</button>
        </div>
      ) : (
        <div className="space-y-4">
          {catalogue.length > 0 && <div className="space-y-3 rounded-2xl bg-white p-3 shadow-sm">
            <label className="relative block">
              <span className="sr-only">搜索商品</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input type="search" aria-label="搜索商品" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索商品名称或 SKU" className="min-h-12 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-3 text-base text-slate-800 outline-none focus:border-budu-300 focus:bg-white focus:ring-2 focus:ring-budu-100" />
            </label>
            <div data-testid="partner-category-strip" className="flex w-full gap-2 overflow-x-auto overscroll-x-contain pb-1" aria-label="商品分类">
              {[{ id: 'all', name: '全部' }, ...categories].map((category) => <button key={category.id} type="button" aria-pressed={categoryId === category.id} onClick={() => setCategoryId(category.id)} className={`min-h-11 shrink-0 rounded-xl px-4 text-sm font-bold ${categoryId === category.id ? 'bg-budu-500 text-white' : 'bg-slate-50 text-slate-600'}`}>{category.name}</button>)}
            </div>
          </div>}
          {groupedCatalogue.map(({ category, products }) => <section key={category.id} className="space-y-3" aria-labelledby={`partner-category-${category.id}`}>
            {categoryId === 'all' && <h2 id={`partner-category-${category.id}`} className="px-1 text-sm font-black text-slate-700">{category.name}</h2>}
            {products.map((product) => {
            const value = Number(selected[product.productId] || 0)
            const raw = quantityInputs[product.productId] ?? ''
            const invalidRaw = raw.trim() !== '' && !parseDisplayQuantity(raw, product.orderUnit)
            const validation = invalidRaw
              ? (product.orderUnit === 'KG' ? '请输入大于 0、最多 3 位小数的 kg 数量' : '请输入大于 0 的整数数量')
              : (value > 0 ? quantityValidationMessage(product, value) : '')
            const unit = partnerUnitLabel(product.orderUnit, product.nativeUnit)
            const adjust = (direction) => updateQuantity(product, displayQuantity(adjustShortcutQuantity(value, product.orderUnit, direction), product.orderUnit))
            return (
              <article data-testid={`partner-catalogue-card-${product.productId}`} key={product.productId} className={`rounded-2xl border bg-white p-4 shadow-sm ${value > 0 ? 'border-budu-200' : 'border-slate-100'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><p className="font-black text-slate-800">{product.name}</p><p className="mt-1 text-xs text-slate-400">{product.sku} · 按 {unit} 补货</p></div>
                  <span className="shrink-0 rounded-full bg-budu-50 px-2.5 py-1 text-xs font-black text-budu-700">{money(product.referencePriceCents)}/{unit}</span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
                  <p>标准价 <strong className="block text-slate-700">{money(product.basePriceCents)}/{unit}</strong></p>
                  <p>合作折扣 <strong className="block text-slate-700">{(product.discountBps / 100).toFixed(2)}%</strong></p>
                  <p className="col-span-2">数量规则 <strong className="block text-slate-700">大于 0；可手动输入，快捷按钮每次 {quantityLabel(product.shortcutIncrementBaseQty, product.orderUnit, product.nativeUnit)}</strong></p>
                </div>
                <label className="mt-3 block text-xs font-bold text-slate-500">
                  补货数量（{unit}）
                  <div className="mt-1 grid grid-cols-[3rem_1fr_3rem] gap-2">
                    <button type="button" aria-label={`${product.name}减少数量`} onClick={() => adjust(-1)} className="grid min-h-12 place-items-center rounded-xl bg-slate-100 text-slate-600"><Minus className="h-4 w-4" /></button>
                    <input aria-label={`${product.name}补货数量`} type="text" inputMode={product.orderUnit === 'KG' ? 'decimal' : 'numeric'} value={raw} onChange={(event) => updateQuantity(product, event.target.value)} placeholder="0" aria-invalid={invalidRaw || undefined} className="min-h-12 w-full rounded-xl border border-slate-200 px-3 text-base outline-none focus:border-budu-300 focus:ring-2 focus:ring-budu-100" />
                    <button type="button" aria-label={`${product.name}增加数量`} onClick={() => adjust(1)} className="grid min-h-12 place-items-center rounded-xl bg-budu-50 text-budu-700"><Plus className="h-4 w-4" /></button>
                  </div>
                </label>
                {validation && <p className="mt-2 text-xs font-semibold text-rose-600">{validation}</p>}
                {quotes[product.productId] && <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm font-black text-emerald-700">本行预计 {money(quotes[product.productId].finalAmountCents)}</p>}
              </article>
            )
          })}
          </section>)}
          {catalogue.length === 0 && <div className="rounded-2xl bg-white p-8 text-center text-sm text-slate-400">暂无可补货商品<button type="button" onClick={onReloadCatalogue} className="btn-secondary mx-auto mt-3 min-h-12">刷新商品目录</button></div>}
          {catalogue.length > 0 && filteredCatalogue.length === 0 && <div className="rounded-2xl bg-white p-8 text-center text-sm text-slate-400">{normalizedSearch ? '未找到相关商品' : '该分类暂无可补货商品'}</div>}
        </div>
      )}
      {messages.length > 0 && <div role="alert" className="space-y-1 rounded-2xl bg-amber-50 p-4 text-sm font-semibold text-amber-800">{messages.map((message) => <p key={message}>{message}</p>)}</div>}
      <div data-testid="partner-replenishment-actions" className="fixed inset-x-0 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-30 px-3 sm:px-4">
        <div className="mx-auto max-w-3xl space-y-3 rounded-2xl border border-slate-100 bg-white/95 p-4 shadow-xl backdrop-blur">
          <div className="flex items-end justify-between"><p className="text-xs text-slate-400">当前预计商品金额</p><p className="text-2xl font-black text-slate-900">{quoted ? money(quoteTotal) : '待重新计算'}</p></div>
          <div className="grid grid-cols-2 gap-3">
            <button type="button" onClick={onQuote} disabled={busy || catalogueLoading || Boolean(catalogueError) || hasInvalidQuantityInput || selectedProducts.length === 0} className="btn-secondary min-h-12 disabled:opacity-40">获取预计金额</button>
            <button type="button" onClick={onSubmit} disabled={busy || catalogueLoading || Boolean(catalogueError) || hasInvalidQuantityInput || !quoted || selectedProducts.length === 0} className="btn-primary min-h-12 disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />}提交补货</button>
          </div>
        </div>
      </div>
    </section>
  )
}

function OrdersView({ orders, orderGroup, setOrderGroup, openOrder }) {
  return <section className="space-y-4" aria-label="补货订单"><header><p className="text-xs font-black tracking-[0.12em] text-budu-500">ORDERS</p><h1 className="mt-1 text-2xl font-black text-slate-900">补货订单</h1></header><div className="flex gap-2 overflow-x-auto pb-1" aria-label="合作商订单分类">{[['all', '全部'], ['pending', '待审核'], ['fulfillment', '履约中 / 已发货'], ['closed', '已取消 / 已驳回']].map(([key, label]) => <button key={key} type="button" aria-pressed={orderGroup === key} onClick={() => setOrderGroup(key)} className={`min-h-11 shrink-0 rounded-xl px-4 text-sm font-bold ${orderGroup === key ? 'bg-budu-500 text-white' : 'bg-white text-slate-500 shadow-sm'}`}>{label}</button>)}</div><div className="space-y-3">{orders.map((order) => <button key={order.id} type="button" onClick={() => openOrder(order)} className="w-full rounded-2xl border border-slate-100 bg-white p-4 text-left shadow-sm"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-black text-slate-800">{order.orderNo}</p><p className="mt-1 text-xs text-slate-400">{new Date(order.submittedAt).toLocaleString('zh-CN', { hour12: false })}</p></div><StatusPill status={order.status} /></div><div className="mt-4 flex items-end justify-between gap-3"><div className="min-w-0 text-sm text-slate-500"><p className="truncate">{order.partnerStore.name}</p><p className="mt-1">{order.items.length} 项商品</p></div><div className="flex items-center gap-1 font-black text-slate-800">{money(order.approvedTotalAmountCents ?? order.requestedTotalAmountCents)}<ChevronRight className="h-4 w-4 text-slate-300" /></div></div></button>)}{orders.length === 0 && <div className="rounded-2xl bg-white p-10 text-center"><ClipboardList className="mx-auto h-9 w-9 text-budu-200" /><p className="mt-3 text-sm text-slate-400">当前分类下没有补货订单</p></div>}</div></section>
}

function ProfileView({ profile, stores, principal, busy, logout }) {
  return <section className="space-y-4" aria-label="我的"><header><p className="text-xs font-black tracking-[0.12em] text-budu-500">MY ACCOUNT</p><h1 className="mt-1 text-2xl font-black text-slate-900">我的</h1></header><section className="rounded-2xl bg-white p-4 shadow-sm"><div className="flex items-center gap-3"><Store className="h-6 w-6 text-budu-500" /><div><p className="font-black text-slate-800">{profile?.companyName || profile?.name}</p><p className="text-sm text-slate-500">{profile?.contactName} · {profile?.contactPhone}</p></div></div><p className="mt-3 text-xs text-slate-400">合作状态：{profile?.status} · 合作折扣 {profile ? (profile.defaultDiscountBps / 100).toFixed(2) : '—'}%</p></section><section className="space-y-3">{stores.map((store) => <article key={store.id} className="rounded-2xl bg-white p-4 text-sm text-slate-600 shadow-sm"><div className="flex items-center justify-between"><p className="font-black text-slate-800">{store.name}</p><span className="text-xs text-slate-400">{store.status}</span></div><p className="mt-2 leading-6">{store.province}{store.city}{store.district}{store.addressLine}</p><p className="mt-1 text-xs text-slate-400">{store.contactName} · {store.phone}</p></article>)}</section><section className="rounded-2xl bg-white p-4 text-sm shadow-sm"><p className="text-xs text-slate-400">当前登录账号</p><p className="mt-1 font-black text-slate-800">{principal.account?.username || '合作商账号'}</p><p className="mt-2 text-xs text-slate-400">Partner 1.0 暂不支持自行创建子账号。</p></section><button type="button" onClick={logout} disabled={busy} className="btn-secondary min-h-12 w-full"><LogOut className="h-4 w-4" />退出登录</button></section>
}
