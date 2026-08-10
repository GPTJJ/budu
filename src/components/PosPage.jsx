import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Banknote, Check, ChevronDown, Minus, Package, Plus, Search, ShoppingCart, Trash2, WalletCards, X } from 'lucide-react'
import { api } from '../utils/api'
import { allStores } from '../utils/selectors'
import CameraScanner from './CameraScanner'
import {
  clearPosTransaction,
  cartTotalCents,
  changeCartQuantity,
  createCheckoutKey,
  formatCents,
  getSelectedPosStore,
  loadPosStoreSession,
  saveCheckoutKey,
  savePendingOrder,
  savePosCart,
  saveSuccessOrder,
  setSelectedPosStore,
} from '../utils/pos'

const paymentLabels = { wechat: '微信支付', alipay: '支付宝', cash: '现金' }

function allowedStores(user) {
  const stores = allStores()
  if (user.role === 'developer') return stores
  const allowed = new Set(user.storeKeys || [])
  return stores.filter((store) => allowed.has(store.key))
}

export default function PosPage({ user, onExit, scannerDecoderFactory }) {
  const stores = useMemo(() => allowedStores(user), [user])
  const [storeId, setStoreId] = useState(() => {
    const saved = getSelectedPosStore(user.id)
    return stores.some((store) => store.key === saved) ? saved : stores[0]?.key || ''
  })
  const [products, setProducts] = useState([])
  const [cart, setCart] = useState({})
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('全部')
  const [stage, setStage] = useState('loading')
  const [order, setOrder] = useState(null)
  const [payment, setPayment] = useState(null)
  const [checkoutKey, setCheckoutKeyState] = useState('')
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [loadingProducts, setLoadingProducts] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [paying, setPaying] = useState('')
  const [queryingPayment, setQueryingPayment] = useState(false)
  const [scannerChannel, setScannerChannel] = useState('')
  const [posConfig, setPosConfig] = useState(null)
  const [cashConfirm, setCashConfirm] = useState(false)
  const [cartOpen, setCartOpen] = useState(false)
  const [isDesktop, setIsDesktop] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 1024px)').matches
      : true
  ))
  const [error, setError] = useState('')

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const onChange = () => setIsDesktop(mq.matches)
    mq.addEventListener?.('change', onChange)
    setIsDesktop(mq.matches)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  useEffect(() => {
    let active = true
    api('/v2/pos/config')
      .then((data) => { if (active) setPosConfig(data) })
      .catch(() => { /* 配置读取失败时按订单模式回退 */ })
    api('/v2/pos/products')
      .then((data) => { if (active) setProducts(data.rows || []) })
      .catch((e) => { if (active) setError(e.message) })
      .finally(() => { if (active) setLoadingProducts(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!storeId && stores[0]) setStoreId(stores[0].key)
  }, [storeId, stores])

  useEffect(() => {
    if (!storeId) return
    let active = true
    setSessionLoaded(false)
    setSelectedPosStore(user.id, storeId)
    const session = loadPosStoreSession(user.id, storeId)
    setCart(session.cart && typeof session.cart === 'object' ? session.cart : {})
    setCheckoutKeyState(session.checkoutKey)
    setOrder(null)
    setPayment(null)
    setScannerChannel('')
    setError('')
    const restoreId = session.successOrderId || session.pendingOrderId
    if (!restoreId) {
      setStage('ordering')
      setSessionLoaded(true)
      return
    }
    setStage('loading')
    api(`/v2/pos/orders/${restoreId}`)
      .then((data) => {
        if (!active) return
        setOrder(data.order)
        setPayment(data.order.payments?.[0] || null)
        if (data.order.status === 'completed') {
          savePendingOrder(user.id, storeId, '')
          saveSuccessOrder(user.id, storeId, data.order.id)
          setCart({})
          setStage('success')
        } else {
          savePendingOrder(user.id, storeId, data.order.id)
          setStage('payment')
        }
      })
      .catch(() => {
        if (!active) return
        savePendingOrder(user.id, storeId, '')
        saveSuccessOrder(user.id, storeId, '')
        setStage('ordering')
      })
      .finally(() => { if (active) setSessionLoaded(true) })
    return () => { active = false }
  }, [storeId, user.id])

  useEffect(() => {
    if (sessionLoaded && storeId) savePosCart(user.id, storeId, cart)
  }, [cart, sessionLoaded, storeId, user.id])

  const productMap = useMemo(() => new Map(products.map((product) => [product.productId, product])), [products])
  const categories = useMemo(() => {
    const rank = new Map()
    for (const product of products) {
      const name = product.posCategory || '其他'
      rank.set(name, Math.min(rank.get(name) ?? Number.POSITIVE_INFINITY, product.sortOrder || 0))
    }
    return ['全部', ...[...rank].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], 'zh-CN')).map(([name]) => name)]
  }, [products])
  const visibleProducts = useMemo(() => {
    const q = query.trim().toLowerCase()
    return products.filter((product) => {
      if (category !== '全部' && product.posCategory !== category) return false
      return !q || [product.name, product.sku, product.barcode].some((value) => String(value || '').toLowerCase().includes(q))
    })
  }, [products, query, category])
  const cartLines = useMemo(() => Object.entries(cart)
    .map(([productId, quantity]) => ({ product: productMap.get(productId), quantity: Number(quantity) }))
    .filter((line) => line.product && Number.isInteger(line.quantity) && line.quantity > 0), [cart, productMap])
  const cartCount = cartLines.reduce((sum, line) => sum + line.quantity, 0)
  const cartTotal = cartTotalCents(cart, products)
  const mockMode = posConfig ? posConfig.mock : (order ? order.paymentMode === 'mock' : true)
  const channels = posConfig?.channels?.length ? posConfig.channels : (mockMode ? ['wechat', 'alipay', 'cash'] : ['cash'])

  const invalidateCheckout = () => {
    setCheckoutKeyState('')
    if (storeId) saveCheckoutKey(user.id, storeId, '')
  }
  const changeQuantity = (productId, delta) => {
    invalidateCheckout()
    setCart((current) => changeCartQuantity(current, productId, delta))
  }
  const removeLine = (productId) => {
    invalidateCheckout()
    setCart((current) => { const next = { ...current }; delete next[productId]; return next })
  }
  const clearCart = () => {
    if (cartCount && !window.confirm('确认清空当前订单中的全部商品吗？')) return
    invalidateCheckout()
    setCart({})
  }

  const checkout = async () => {
    if (!storeId || cartLines.length === 0 || submitting) return
    setSubmitting(true)
    setError('')
    let key = checkoutKey
    if (!key) {
      key = createCheckoutKey()
      setCheckoutKeyState(key)
      saveCheckoutKey(user.id, storeId, key)
    }
    try {
      const data = await api('/v2/pos/orders', {
        method: 'POST',
        body: JSON.stringify({
          storeId,
          checkoutKey: key,
          items: cartLines.map((line) => ({ productId: line.product.productId, quantity: line.quantity })),
        }),
      })
      setOrder(data.order)
      savePendingOrder(user.id, storeId, data.order.id)
      saveSuccessOrder(user.id, storeId, '')
      setStage(data.order.status === 'completed' ? 'success' : 'payment')
    } catch (e) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const completePayment = async (paymentMethod, authCode = '') => {
    if (!order || paying) return
    if (['wechat', 'alipay'].includes(paymentMethod) && !authCode) {
      setError('请先扫描顾客付款码')
      return
    }
    setPaying(paymentMethod)
    setError('')
    try {
      const data = await api(`/v2/pos/orders/${order.id}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          channel: paymentMethod,
          requestKey: `${order.id}:${paymentMethod}:${createCheckoutKey()}`,
          ...(authCode ? { authCode } : {}),
        }),
      })
      setOrder(data.order)
      setPayment(data.payment)
      if (data.order.status === 'completed' && data.order.paymentStatus === 'paid') {
        setCart({})
        savePosCart(user.id, storeId, {})
        savePendingOrder(user.id, storeId, '')
        saveSuccessOrder(user.id, storeId, data.order.id)
        saveCheckoutKey(user.id, storeId, '')
        setCheckoutKeyState('')
        setStage('success')
      } else if (['failed', 'timeout'].includes(data.payment.status)) {
        setError(data.payment.failureMessage || '支付未成功，可以重新选择支付方式')
      } else {
        setError('支付处理中，请稍后查询支付结果')
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setPaying('')
    }
  }

  const startPayment = (paymentMethod) => {
    if (paying) return
    setError('')
    if (paymentMethod === 'cash') setCashConfirm(true)
    else setScannerChannel(paymentMethod)
  }

  const acceptScannedCode = (authCode) => {
    const paymentMethod = scannerChannel
    setScannerChannel('')
    if (paymentMethod) completePayment(paymentMethod, authCode)
  }

  const queryCurrentPayment = async () => {
    if (!payment || queryingPayment) return
    setQueryingPayment(true)
    setError('')
    try {
      const data = await api(`/v2/pos/payments/${payment.id}/query`, { method: 'POST' })
      setPayment(data.payment)
      setOrder(data.order)
      if (data.order.status === 'completed' && data.order.paymentStatus === 'paid') {
        setCart({})
        savePosCart(user.id, storeId, {})
        savePendingOrder(user.id, storeId, '')
        saveSuccessOrder(user.id, storeId, data.order.id)
        setStage('success')
      } else {
        setError(data.payment.failureMessage || `当前支付状态：${data.payment.status}`)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setQueryingPayment(false)
    }
  }

  const closeCurrentPayment = async () => {
    if (!payment || queryingPayment || paying) return
    setQueryingPayment(true)
    setError('')
    try {
      const data = await api(`/v2/pos/payments/${payment.id}/close`, { method: 'POST' })
      setPayment(data.payment)
      setOrder(data.order)
      setError(data.payment.status === 'closed'
        ? '当前支付已关闭，可以重新选择支付方式'
        : (data.payment.failureMessage || `当前支付状态：${data.payment.status}`))
    } catch (e) {
      setError(e.message)
    } finally {
      setQueryingPayment(false)
    }
  }

  // 支付处理中自动查询（防止回调延迟时员工重复扫码/重复扣款）
  useEffect(() => {
    if (stage !== 'payment' || !payment || !['created', 'pending'].includes(payment.status)) return
    let polls = 0
    const timer = window.setInterval(() => {
      polls += 1
      if (polls > 10) {
        window.clearInterval(timer)
        return
      }
      queryCurrentPayment()
    }, 3000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, payment?.id, payment?.status])

  const startNext = () => {
    clearPosTransaction(user.id, storeId)
    setCart({})
    setOrder(null)
    setPayment(null)
    setScannerChannel('')
    setCheckoutKeyState('')
    setQuery('')
    setCategory('全部')
    setStage('ordering')
  }

  if (stores.length === 0) {
    return <div className="grid min-h-[100dvh] place-items-center bg-slate-100 p-6"><div className="max-w-sm rounded-3xl bg-white p-8 text-center shadow-xl"><Package className="mx-auto h-10 w-10 text-slate-300" /><h2 className="mt-4 text-lg font-bold text-slate-800">没有可用门店</h2><p className="mt-2 text-sm text-slate-400">请先让开发者为账号绑定门店。</p><button onClick={onExit} className="mt-6 rounded-xl bg-budu-500 px-5 py-2.5 text-sm font-semibold text-white">返回系统</button></div></div>
  }

  if (stage === 'loading') {
    return <div className="grid min-h-[100dvh] place-items-center bg-slate-100 text-sm font-medium text-slate-400">正在恢复 POS 会话…</div>
  }

  if (stage === 'payment' && order) {
    const pendingPayment = payment && ['created', 'pending'].includes(payment.status)
    const channelButton = (channel, label, icon, colorClass) => {
      const enabled = channels.includes(channel)
      return (
        <button
          key={channel}
          disabled={Boolean(paying) || !enabled}
          onClick={() => startPayment(channel)}
          className={`rounded-2xl border px-3 py-6 font-bold disabled:opacity-40 ${colorClass}`}
        >
          {icon}
          {paying === channel ? '处理中…' : enabled ? label : `${label} · 暂未开通`}
        </button>
      )
    }
    return (
      <>
        <div className="flex min-h-[100dvh] items-center justify-center bg-slate-100 p-6" style={{ paddingTop: 'max(24px, env(safe-area-inset-top))', paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}>
          <div className="w-full max-w-2xl rounded-[32px] bg-white p-8 shadow-2xl">
            <button onClick={() => { setScannerChannel(''); setStage('ordering') }} className="flex items-center gap-2 text-sm font-semibold text-slate-400 hover:text-slate-700"><ArrowLeft className="h-4 w-4" />返回点单</button>
            <div className="mt-8 text-center"><p className="text-sm font-semibold text-slate-400">{mockMode ? '扫码模拟支付 · 不调用真实支付接口' : (channels.length === 1 && channels.includes('cash') ? '现金收款 · 当面确认后完成订单' : '请选择支付方式')}</p><h2 className="mt-3 text-2xl font-bold text-slate-900">应付金额</h2><p className="mt-4 text-5xl font-black tracking-tight text-budu-600">{formatCents(order.payableAmount)}</p><p className="mt-3 text-xs text-slate-400">订单号 {order.orderNo}</p></div>
            {error && <div className="mt-6 rounded-xl bg-rose-50 px-4 py-3 text-center text-sm text-rose-600">{error}</div>}
            {pendingPayment && (
              <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-center text-sm font-semibold text-amber-700">正在确认支付，请勿重复付款</div>
            )}
            {payment && !['success'].includes(payment.status) && (
              <div className="mx-auto mt-4 flex max-w-sm items-center justify-center gap-3">
                <button disabled={queryingPayment} onClick={queryCurrentPayment} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-500 hover:bg-slate-50 disabled:opacity-50">
                  {queryingPayment ? '查询中…' : '查询支付结果'}
                </button>
                {pendingPayment && (
                  <button disabled={queryingPayment} onClick={closeCurrentPayment} className="rounded-xl border border-rose-200 px-4 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50">
                    关闭当前支付
                  </button>
                )}
              </div>
            )}
            <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
              {channelButton('wechat', '微信扫码', <WalletCards className="mx-auto mb-3 h-8 w-8" />, 'border-emerald-200 bg-emerald-50 text-emerald-700')}
              {channelButton('alipay', '支付宝扫码', <WalletCards className="mx-auto mb-3 h-8 w-8" />, 'border-sky-200 bg-sky-50 text-sky-700')}
              {channelButton('cash', '现金收款', <Banknote className="mx-auto mb-3 h-8 w-8" />, 'border-amber-200 bg-amber-50 text-amber-700')}
            </div>
          </div>
        </div>
        {cashConfirm && (
          <div className="fixed inset-0 z-[110] grid place-items-center bg-slate-950/60 p-6 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="现金收款确认">
            <div className="w-full max-w-sm rounded-3xl bg-white p-7 text-center shadow-2xl">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-amber-100"><Banknote className="h-7 w-7 text-amber-600" /></div>
              <h3 className="mt-4 text-xl font-black text-slate-900">现金收款确认</h3>
              <p className="mt-2 text-sm text-slate-500">请当面确认已收到顾客现金</p>
              <p className="mt-5 text-4xl font-black tracking-tight text-slate-900">{formatCents(order.payableAmount)}</p>
              <p className="mt-2 text-xs text-slate-400">订单号 {order.orderNo}</p>
              <div className="mt-6 grid grid-cols-2 gap-3">
                <button onClick={() => setCashConfirm(false)} className="rounded-xl border border-slate-200 py-3 text-sm font-bold text-slate-500">取消</button>
                <button disabled={Boolean(paying)} onClick={() => { setCashConfirm(false); completePayment('cash') }} className="rounded-xl bg-budu-500 py-3 text-sm font-bold text-white disabled:opacity-50">{paying === 'cash' ? '确认中…' : '确认收款'}</button>
              </div>
            </div>
          </div>
        )}
        {scannerChannel && <CameraScanner channel={scannerChannel} onDetected={acceptScannedCode} onCancel={() => setScannerChannel('')} decoderFactory={scannerDecoderFactory} />}
      </>
    )
  }

  if (stage === 'success' && order) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-emerald-50 p-6" style={{ paddingTop: 'max(24px, env(safe-area-inset-top))', paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}>
        <div className="w-full max-w-lg rounded-[32px] bg-white p-9 text-center shadow-2xl"><div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-emerald-100"><Check className="h-10 w-10 text-emerald-600" strokeWidth={3} /></div><h2 className="mt-5 text-3xl font-black text-slate-900">支付成功</h2><p className="mt-2 text-sm text-slate-400">{order.paymentMethod === 'cash' ? '现金已收款，订单已完成' : (mockMode ? '本次为模拟支付，订单已保存为 completed' : '支付已确认，订单已完成')}</p><p className="mt-6 text-5xl font-black text-emerald-600">{formatCents(order.payableAmount)}</p><div className="mt-7 space-y-2 rounded-2xl bg-slate-50 p-5 text-left text-sm"><p className="flex justify-between"><span className="text-slate-400">订单号</span><span className="font-semibold text-slate-700">{order.orderNo}</span></p><p className="flex justify-between"><span className="text-slate-400">门店</span><span className="font-semibold text-slate-700">{order.storeName}</span></p><p className="flex justify-between"><span className="text-slate-400">支付方式</span><span className="font-semibold text-slate-700">{paymentLabels[order.paymentMethod] || order.paymentMethod}</span></p></div><button onClick={startNext} className="mt-7 w-full rounded-2xl bg-budu-500 py-4 text-base font-bold text-white shadow-lg shadow-budu-200">开始下一笔订单</button><button onClick={onExit} className="mt-3 px-4 py-2 text-sm font-semibold text-slate-400 hover:text-slate-700">退出 POS</button></div>
      </div>
    )
  }

  return (
    <div className="flex h-screen h-[100dvh] flex-col overflow-hidden bg-slate-100 text-slate-800" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', touchAction: 'manipulation' }}>
      <header className="flex h-[60px] shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 lg:h-[72px] lg:px-4">
        <button onClick={onExit} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500" aria-label="退出 POS"><X className="h-5 w-5" /></button>
        <strong className="hidden text-lg text-budu-600 sm:block">POS</strong>
        <label className="relative min-w-0 flex-1">
          <Search className="absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索商品名称 / SKU / 条码" className="w-full rounded-2xl bg-slate-100 py-3 pl-11 pr-4 text-sm outline-none ring-budu-200 focus:ring-2" />
        </label>
        <label className="relative shrink-0">
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)} className="h-11 max-w-[170px] appearance-none rounded-2xl border border-slate-200 bg-white pl-3 pr-8 text-sm font-semibold text-slate-700 outline-none" disabled={stores.length === 1}>{stores.map((store) => <option key={store.key} value={store.key}>{store.name}</option>)}</select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        </label>
      </header>

      <div className="flex min-h-0 flex-1">
        {isDesktop && <aside className="flex min-h-0 w-[148px] shrink-0 flex-col border-r border-slate-200 bg-white xl:w-[164px]">
          <div className="flex h-[72px] shrink-0 items-center border-b border-slate-100 px-3"><strong className="text-lg text-budu-600">POS</strong></div>
          <nav className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">{categories.map((item) => <button key={item} onClick={() => setCategory(item)} className={`w-full rounded-xl px-2 py-3 text-left text-sm font-semibold transition ${category === item ? 'bg-budu-500 text-white shadow-md shadow-budu-100' : 'text-slate-500 hover:bg-slate-100'}`}>{item}</button>)}</nav>
        </aside>}

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!isDesktop && <div className="flex shrink-0 gap-2 overflow-x-auto px-3 py-2" aria-label="商品分类">
            {categories.map((item) => <button key={item} onClick={() => setCategory(item)} className={`shrink-0 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-xs font-semibold transition ${category === item ? 'border-budu-400 bg-budu-500 text-white' : 'border-slate-200 bg-white text-slate-500'}`}>{item}</button>)}
          </div>}
          {error && <div className={`shrink-0 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600 ${isDesktop ? 'mx-4 mt-3' : 'mx-3 mt-2'}`}>{error}</div>}
          <div className="min-h-0 flex-1 overflow-y-auto p-3 lg:p-4">
            {loadingProducts ? <div className="grid h-full place-items-center text-sm text-slate-400">正在加载商品…</div> : visibleProducts.length === 0 ? <div className="grid h-full place-items-center text-center text-slate-400"><div><Package className="mx-auto h-10 w-10 text-slate-300" /><p className="mt-3 text-sm">暂无符合条件的上架商品</p></div></div> : <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-4">{visibleProducts.map((product) => { const quantity = Number(cart[product.productId] || 0); return <button key={product.productId} onClick={() => changeQuantity(product.productId, 1)} className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white text-left shadow-sm transition active:scale-[0.98] active:border-budu-400"><div className="aspect-[4/3] bg-slate-100">{product.image ? <img src={product.image} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center"><Package className="h-9 w-9 text-slate-300" /></div>}</div>{quantity > 0 && <span className="absolute right-2 top-2 grid min-w-7 place-items-center rounded-full bg-budu-500 px-2 py-1 text-xs font-bold text-white shadow">{quantity}</span>}<div className="p-3"><p className="truncate text-sm font-bold text-slate-800">{product.name}</p><div className="mt-2 flex items-end justify-between"><span className="text-base font-black text-budu-600">{formatCents(product.salePriceCents)}</span><span className="text-[11px] text-slate-400">/{product.unit}</span></div></div></button> })}</div>}
          </div>
        </main>

        {isDesktop && <aside className="flex min-h-0 w-[300px] shrink-0 flex-col border-l border-slate-200 bg-white xl:w-[340px]">
          <div className="flex h-[72px] shrink-0 items-center border-b border-slate-100 px-5"><ShoppingCart className="h-5 w-5 text-budu-600" /><h2 className="ml-2 font-bold">当前订单</h2><span className="ml-2 rounded-full bg-budu-50 px-2 py-0.5 text-xs font-bold text-budu-600">{cartCount}</span><button onClick={clearCart} disabled={!cartCount} className="ml-auto text-xs font-semibold text-slate-400 hover:text-rose-500 disabled:opacity-30">清空</button></div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">{cartLines.length === 0 ? <div className="grid h-full place-items-center text-center"><div><ShoppingCart className="mx-auto h-10 w-10 text-slate-200" /><p className="mt-3 text-sm font-semibold text-slate-400">点击商品加入购物车</p></div></div> : cartLines.map(({ product, quantity }) => <div key={product.productId} className="rounded-2xl border border-slate-100 bg-slate-50 p-3"><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-800">{product.name}</p><p className="mt-1 text-xs text-slate-400">{formatCents(product.salePriceCents)} / {product.unit}</p></div><button onClick={() => removeLine(product.productId)} className="p-1 text-slate-300 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button></div><div className="mt-3 flex items-center"><strong className="text-sm text-budu-600">{formatCents(BigInt(product.salePriceCents) * BigInt(quantity))}</strong><div className="ml-auto flex items-center overflow-hidden rounded-xl border border-slate-200 bg-white"><button onClick={() => changeQuantity(product.productId, -1)} className="grid h-9 w-9 place-items-center text-slate-500 active:bg-slate-100"><Minus className="h-4 w-4" /></button><span className="w-9 text-center text-sm font-bold">{quantity}</span><button onClick={() => changeQuantity(product.productId, 1)} className="grid h-9 w-9 place-items-center text-budu-600 active:bg-budu-50"><Plus className="h-4 w-4" /></button></div></div></div>)}</div>
          <div className="shrink-0 border-t border-slate-100 bg-white p-4" style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}><div className="mb-4 flex items-end justify-between"><div><p className="text-xs text-slate-400">合计 · {cartCount} 件</p><p className="mt-1 text-2xl font-black text-slate-900">{formatCents(cartTotal)}</p></div><p className="text-xs text-slate-400">优惠 ¥0.00</p></div><button onClick={checkout} disabled={!cartCount || submitting} className="w-full rounded-2xl bg-budu-500 py-4 text-base font-bold text-white shadow-lg shadow-budu-100 disabled:bg-slate-200 disabled:shadow-none">{submitting ? '正在创建订单…' : '结算'}</button></div>
        </aside>}
      </div>

      {!isDesktop && <div className="shrink-0 border-t border-slate-200 bg-white px-3 py-2" style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }} aria-label="结算栏">
        <div className="flex items-center gap-3">
          <button onClick={() => setCartOpen(true)} disabled={!cartCount} className="relative grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-slate-100 text-slate-600 disabled:opacity-40" aria-label="打开购物车">
            <ShoppingCart className="h-6 w-6" />
            {cartCount > 0 && <span className="absolute -right-1 -top-1 grid min-w-5 place-items-center rounded-full bg-budu-500 px-1.5 py-0.5 text-[10px] font-bold text-white">{cartCount}</span>}
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-slate-400">合计 · {cartCount} 件</p>
            <p className="truncate text-lg font-black text-slate-900">{formatCents(cartTotal)}</p>
          </div>
          <button onClick={checkout} disabled={!cartCount || submitting} className="shrink-0 rounded-2xl bg-budu-500 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-budu-100 disabled:bg-slate-200 disabled:shadow-none">{submitting ? '创建中…' : '结算'}</button>
        </div>
      </div>}

      {!isDesktop && cartOpen && (
        <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label="购物车">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setCartOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-3xl bg-white shadow-2xl" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
            <div className="flex shrink-0 items-center border-b border-slate-100 px-5 py-4">
              <ShoppingCart className="h-5 w-5 text-budu-600" />
              <h2 className="ml-2 font-bold">当前订单</h2>
              <span className="ml-2 rounded-full bg-budu-50 px-2 py-0.5 text-xs font-bold text-budu-600">{cartCount}</span>
              <button onClick={() => setCartOpen(false)} className="ml-auto grid h-9 w-9 place-items-center rounded-xl text-slate-400 hover:bg-slate-100" aria-label="关闭"><X className="h-5 w-5" /></button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {cartLines.length === 0 ? <div className="grid h-full place-items-center text-center"><div><ShoppingCart className="mx-auto h-10 w-10 text-slate-200" /><p className="mt-3 text-sm font-semibold text-slate-400">点击商品加入购物车</p></div></div> : cartLines.map(({ product, quantity }) => <div key={product.productId} className="rounded-2xl border border-slate-100 bg-slate-50 p-3"><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-800">{product.name}</p><p className="mt-1 text-xs text-slate-400">{formatCents(product.salePriceCents)} / {product.unit}</p></div><button onClick={() => removeLine(product.productId)} className="p-1 text-slate-300 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button></div><div className="mt-3 flex items-center"><strong className="text-sm text-budu-600">{formatCents(BigInt(product.salePriceCents) * BigInt(quantity))}</strong><div className="ml-auto flex items-center overflow-hidden rounded-xl border border-slate-200 bg-white"><button onClick={() => changeQuantity(product.productId, -1)} className="grid h-9 w-9 place-items-center text-slate-500 active:bg-slate-100"><Minus className="h-4 w-4" /></button><span className="w-9 text-center text-sm font-bold">{quantity}</span><button onClick={() => changeQuantity(product.productId, 1)} className="grid h-9 w-9 place-items-center text-budu-600 active:bg-budu-50"><Plus className="h-4 w-4" /></button></div></div></div>)}
            </div>
            <div className="shrink-0 border-t border-slate-100 p-4">
              <div className="mb-3 flex items-end justify-between">
                <div><p className="text-xs text-slate-400">合计 · {cartCount} 件</p><p className="mt-1 text-2xl font-black text-slate-900">{formatCents(cartTotal)}</p></div>
                <button onClick={clearCart} disabled={!cartCount} className="text-xs font-semibold text-slate-400 hover:text-rose-500 disabled:opacity-30">清空</button>
              </div>
              <button onClick={() => { setCartOpen(false); checkout() }} disabled={!cartCount || submitting} className="w-full rounded-2xl bg-budu-500 py-3.5 text-base font-bold text-white shadow-lg shadow-budu-100 disabled:bg-slate-200 disabled:shadow-none">{submitting ? '正在创建订单…' : '结算'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
