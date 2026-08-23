import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Banknote, Check, ChevronDown, Gift, Minus, Package, Plus, ReceiptText, Search, ShoppingCart, Trash2, WalletCards, X } from 'lucide-react'
import { api } from '../utils/api'
import { allStores } from '../utils/selectors'
import { loadUserData } from '../utils/userData'
import CameraScanner from './CameraScanner'
import { isValidWechatAuthCode } from '../utils/cameraScanner'
import OrderRecordsPage from './OrderRecordsPage'
import useSwipeBack from '../hooks/useSwipeBack'
import {
  clearPosTransaction,
  changeCartQuantity,
  createCheckoutKey,
  formatCents,
  giftLineKey,
  getSelectedPosStore,
  loadPosStoreSession,
  migratePosCart,
  normalLineKey,
  parseLineKey,
  saveCheckoutKey,
  savePendingOrder,
  savePosCart,
  saveSuccessOrder,
  setSelectedPosStore,
} from '../utils/pos'

const paymentLabels = { wechat: '微信支付', alipay: '支付宝', cash: '现金' }
const PRODUCTS_CACHE_TTL = 60 * 1000
const productsCacheKey = (userId) => `budu-pos-products:${userId}`

function isIpadViewport() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const userAgent = navigator.userAgent || ''
  const ipadDevice = /iPad/i.test(userAgent) || (/Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1)
  return ipadDevice && window.innerWidth >= 768 && window.innerWidth <= 1366
}

function parseDiscountPercent(value) {
  const num = Number(String(value ?? '').trim())
  if (!Number.isFinite(num) || num < 0.1 || num > 10) return 100
  return Math.max(1, Math.min(100, Math.round(num * 10)))
}

function allowedStores(user) {
  const stores = allStores()
  if (user.role === 'developer' || user.role === 'finance' || user.role === 'admin') return stores
  const allowed = new Set(user.storeKeys || [])
  return stores.filter((store) => allowed.has(store.key))
}

export default function PosPage({ user, onExit, scannerDecoderFactory, initialOrder = null }) {
  const stores = useMemo(() => allowedStores(user), [user])
  const [storeId, setStoreId] = useState(() => {
    if (initialOrder?.storeId && stores.some((store) => store.key === initialOrder.storeId)) return initialOrder.storeId
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
  const [showOrders, setShowOrders] = useState(false)
  const [resumedSession, setResumedSession] = useState(null)
  // Balls 礼盒搭配面板
  const [comboProduct, setComboProduct] = useState(null)
  const [comboSlots, setComboSlots] = useState([])
  const [comboActiveSlot, setComboActiveSlot] = useState(0)
  const [comboReady, setComboReady] = useState(false)
  const [discount, setDiscount] = useState('10')
  const [remark, setRemark] = useState('')
  const [isDesktop, setIsDesktop] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 1024px)').matches
      : true
  ))
  const [isIpad, setIsIpad] = useState(isIpadViewport)
  const [error, setError] = useState('')

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const onChange = () => setIsDesktop(mq.matches)
    mq.addEventListener?.('change', onChange)
    setIsDesktop(mq.matches)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  useEffect(() => {
    const updateIpadViewport = () => setIsIpad(isIpadViewport())
    window.addEventListener('resize', updateIpadViewport)
    window.addEventListener('orientationchange', updateIpadViewport)
    updateIpadViewport()
    return () => {
      window.removeEventListener('resize', updateIpadViewport)
      window.removeEventListener('orientationchange', updateIpadViewport)
    }
  }, [])

  // POS 配置与「当前所选门店」强绑定：切换门店立即重置为 fail-closed（仅现金），
  // 并按新门店重新拉取；过期响应由 active 守卫丢弃（门店切换后旧响应不得覆盖新配置）。
  useEffect(() => {
    let active = true
    setPosConfig(null)
    const query = storeId ? `?storeId=${encodeURIComponent(storeId)}` : ''
    api(`/v2/pos/config${query}`)
      .then((data) => { if (active) setPosConfig(data) })
      .catch(() => { /* 配置读取失败时 fail closed：只保留现金，绝不回退为可用的模拟微信支付 */ })
    return () => { active = false }
  }, [user.id, storeId])

  useEffect(() => {
    let active = true
    const cached = (() => {
      try {
        const raw = sessionStorage.getItem(productsCacheKey(user.id))
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.rows) && Date.now() - parsed.at < PRODUCTS_CACHE_TTL) return parsed.rows
      } catch { /* 缓存损坏时忽略 */ }
      return null
    })()
    if (cached) {
      setProducts(cached)
      setLoadingProducts(false)
    }
    api('/v2/pos/products')
      .then((data) => {
        if (!active) return
        setProducts(data.rows || [])
        try {
          sessionStorage.setItem(productsCacheKey(user.id), JSON.stringify({ at: Date.now(), rows: data.rows || [] }))
        } catch { /* 存储失败不影响功能 */ }
      })
      .catch((e) => { if (active) setError(e.message) })
      .finally(() => { if (active) setLoadingProducts(false) })
    return () => { active = false }
  }, [user.id])

  useEffect(() => {
    if (!storeId && stores[0]) setStoreId(stores[0].key)
  }, [storeId, stores])

  useEffect(() => {
    if (!storeId) return
    let active = true
    setSessionLoaded(false)
    setSelectedPosStore(user.id, storeId)
    const session = loadPosStoreSession(user.id, storeId)
    setCart(migratePosCart(session.cart && typeof session.cart === 'object' ? session.cart : {}))
    setDiscount('10')
    setRemark('')
    setCheckoutKeyState(session.checkoutKey)
    setOrder(null)
    setPayment(null)
    setScannerChannel('')
    setError('')
    const initialOrderId = initialOrder?.storeId === storeId ? initialOrder.id : ''
    const restoreId = initialOrderId || session.successOrderId || session.pendingOrderId
    if (!restoreId) {
      setStage('ordering')
      setSessionLoaded(true)
      return
    }
    if (initialOrderId) {
      const sameCheckout = session.pendingOrderId === initialOrderId
        || (session.checkoutKey && session.checkoutKey === initialOrder?.checkoutKey)
      setResumedSession(sameCheckout ? null : {
        cart: migratePosCart(session.cart && typeof session.cart === 'object' ? session.cart : {}),
        checkoutKey: session.checkoutKey || '',
      })
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
  }, [storeId, user.id, initialOrder?.id, initialOrder?.storeId])

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
  // Balls 礼盒：SKU 前缀识别 combo 商品；口味候选 = 同分类非 combo 商品
  const isComboProduct = (product) => /BUDU-CHOC-BALLS/i.test(String(product?.sku || ''))
  const comboFlavors = useMemo(() => products.filter((p) => p.posCategory === '巧克力豆' && !isComboProduct(p)), [products])
  const cartLines = useMemo(() => Object.entries(cart)
    .map(([key, quantity]) => {
      const { productId, gift } = parseLineKey(key)
      // combo 行 key 形如 `${productId}::n::bb,id1,id2,id3,id4`
      const comboPart = String(key).split('::')[2]
      const comboIds = comboPart && comboPart.startsWith('bb,') ? comboPart.split(',').slice(1) : []
      const comboNames = comboIds.map((id) => {
        const f = productMap.get(id)
        return f ? String(f.name).replace(/^巧克力豆\./, '') : id
      })
      return { key, product: productMap.get(productId), quantity: Number(quantity), gift, comboIds, comboNames }
    })
    .filter((line) => line.product && Number.isInteger(line.quantity) && line.quantity > 0), [cart, productMap])
  const cartCount = cartLines.reduce((sum, line) => sum + line.quantity, 0)
  const discountPercent = parseDiscountPercent(discount)
  const cartSubtotal = cartLines.reduce((sum, line) => (
    sum + BigInt(line.product.salePriceCents) * BigInt(line.quantity)
  ), 0n)
  const chargeableSubtotal = cartLines.reduce((sum, line) => (
    line.gift ? sum : sum + BigInt(line.product.salePriceCents) * BigInt(line.quantity)
  ), 0n)
  const cartTotal = (chargeableSubtotal * BigInt(discountPercent) + 50n) / 100n
  const cartDiscountAmount = cartSubtotal - cartTotal
  const mockMode = posConfig ? posConfig.mock : (order ? order.paymentMode === 'mock' : true)
  // 通道完全以服务端 /pos/config 为准；读取失败时 fail closed（仅现金）。
  const channels = posConfig?.channels?.length ? posConfig.channels : ['cash']

  const invalidateCheckout = () => {
    setCheckoutKeyState('')
    if (storeId) saveCheckoutKey(user.id, storeId, '')
  }
  const changeQuantity = (lineKey, delta) => {
    invalidateCheckout()
    setCart(changeCartQuantity(cart, lineKey, delta))
  }
  /** 商品点击加购：combo 商品（Balls 礼盒）打开搭配面板，其余直接 +1 */
  const addProduct = (product) => {
    if (isComboProduct(product)) {
      setComboProduct(product)
      setComboSlots(['', '', '', ''])
      setComboActiveSlot(0)
      setComboReady(false)
      return
    }
    changeQuantity(normalLineKey(product.productId), 1)
  }
  /** combo 行加减：同口味组合合并数量 */
  const changeComboQuantity = (line, delta) => {
    const key = comboLineKey(line.product.productId, line.comboIds)
    invalidateCheckout()
    setCart(changeCartQuantity(cart, key, delta))
  }
  /** combo 行 key：productId::n::bb,id1,id2,id3,id4 */
  const comboLineKey = (productId, ids) => `${productId}::n::bb,${(ids || []).join(',')}`
  const removeLine = (lineKey) => {
    invalidateCheckout()
    setCart((current) => { const next = { ...current }; delete next[lineKey]; return next })
  }
  const clearCart = () => {
    if (cartCount && !window.confirm('确认清空当前订单中的全部商品吗？')) return
    invalidateCheckout()
    setCart({})
  }
  const toggleGift = (line) => {
    invalidateCheckout()
    setCart((current) => {
      const quantity = Number(current[line.key] || 0)
      if (!quantity) return current
      const next = { ...current }
      delete next[line.key]
      const target = line.gift ? normalLineKey(line.product.productId) : giftLineKey(line.product.productId)
      next[target] = Math.min(999, Number(next[target] || 0) + quantity)
      return next
    })
  }
  const setDiscountValue = (value) => {
    invalidateCheckout()
    setDiscount(value)
  }
  const setRemarkValue = (value) => {
    invalidateCheckout()
    setRemark(value)
  }

  const renderCartLine = (line) => {
    const { product, quantity, gift, comboNames } = line
    const giftQty = gift ? quantity : 0
    const isGift = gift
    const isCombo = Array.isArray(line.comboIds) && line.comboIds.length > 0
    const lineAmount = gift ? 0n : BigInt(product.salePriceCents) * BigInt(quantity)
    return (
      <div key={line.key} className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-bold text-slate-800">
              {isCombo ? `Balls-礼盒（${(comboNames || []).join(' / ')}）` : product.name}
            </p>
            <p className="mt-1 text-xs text-slate-400">{formatCents(product.salePriceCents)} / {product.unit}{isGift && <span className="ml-1.5 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-500">赠 {giftQty}</span>}</p>
          </div>
          <button onClick={() => toggleGift(line)} className={`flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold transition ${isGift ? 'bg-rose-500 text-white' : 'bg-slate-100 text-slate-400 hover:text-rose-500'}`} aria-label={`赠送 ${product.name}`}><Gift className="h-3.5 w-3.5" />赠</button>
          <button onClick={() => removeLine(line.key)} className="p-1 text-slate-300 transition hover:text-rose-500"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
        <div className="mt-2 flex items-center">
          <strong className={`text-sm ${isGift ? 'text-rose-500' : 'text-budu-600'}`}>{isGift ? (giftQty === quantity ? '¥0.00 赠送' : `${formatCents(lineAmount)} 赠${giftQty}`) : formatCents(lineAmount)}</strong>
          <div className="ml-auto flex items-center overflow-hidden rounded-lg border border-slate-200 bg-white">
            <button onClick={() => (isCombo ? changeComboQuantity(line, -1) : changeQuantity(line.key, -1))} className="grid h-8 w-8 place-items-center text-slate-500 active:bg-slate-100"><Minus className="h-3.5 w-3.5" /></button>
            <span className="w-8 text-center text-sm font-bold">{quantity}</span>
            <button onClick={() => (isCombo ? changeComboQuantity(line, 1) : changeQuantity(line.key, 1))} className="grid h-8 w-8 place-items-center text-budu-600 active:bg-budu-50"><Plus className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      </div>
    )
  }

  const renderDesktopCartLine = (line, index) => {
    const { product, quantity, gift, comboNames } = line
    const giftQty = gift ? quantity : 0
    const isGift = gift
    const isCombo = Array.isArray(line.comboIds) && line.comboIds.length > 0
    const lineAmount = gift ? 0n : BigInt(product.salePriceCents) * BigInt(quantity)
    return (
      <div key={line.key} className="group grid grid-cols-[24px_minmax(0,1fr)_86px_120px] items-center gap-2 border-b border-slate-100 px-3 py-2.5 transition hover:bg-slate-50">
        <span className="text-center text-xs font-semibold text-slate-300">{index + 1}</span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="truncate text-[13px] font-bold text-slate-800">
              {isCombo ? `Balls-礼盒（${(comboNames || []).join(' / ')}）` : product.name}
            </p>
            {isGift && <span className="shrink-0 rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-500">赠 {giftQty}</span>}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-slate-400">{product.sku || '无 SKU'} · {formatCents(product.salePriceCents)}/{product.unit}</p>
        </div>
        <div className="flex h-8 items-center overflow-hidden rounded-lg border border-slate-200 bg-white">
          <button onClick={() => (isCombo ? changeComboQuantity(line, -1) : changeQuantity(line.key, -1))} className="grid h-full w-7 place-items-center text-slate-500 active:bg-slate-100" aria-label={`减少 ${product.name}`}><Minus className="h-3 w-3" /></button>
          <span className="min-w-7 flex-1 text-center text-xs font-black text-slate-700">{quantity}</span>
          <button onClick={() => (isCombo ? changeComboQuantity(line, 1) : changeQuantity(line.key, 1))} className="grid h-full w-7 place-items-center text-budu-600 active:bg-budu-50" aria-label={`增加 ${product.name}`}><Plus className="h-3 w-3" /></button>
        </div>
        <div className="flex items-center justify-end gap-1">
          <strong className={`min-w-0 truncate text-right text-xs ${isGift ? 'text-rose-500' : 'text-slate-800'}`}>{isGift ? (giftQty === quantity ? '¥0.00 赠送' : `${formatCents(lineAmount)} 赠${giftQty}`) : formatCents(lineAmount)}</strong>
          <button onClick={() => toggleGift(line)} className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg transition ${isGift ? 'bg-rose-500 text-white' : 'text-slate-300 hover:bg-rose-50 hover:text-rose-500'}`} aria-label={`赠送 ${product.name}`} title="赠送"><Gift className="h-3.5 w-3.5" /></button>
          <button onClick={() => removeLine(line.key)} className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-300 transition hover:bg-rose-50 hover:text-rose-500" aria-label={`删除 ${product.name}`} title="删除"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>
    )
  }

  const renderDiscountControls = () => (
    <div className="space-y-2.5">
      <div>
        <p className="text-xs text-slate-400">折扣</p>
        <div className="mt-1 flex items-center gap-1.5 overflow-x-auto">
          {[['10', '不打折'], ['9', '9折'], ['8.5', '8.5折'], ['8', '8折']].map(([value, label]) => (
            <button key={value} onClick={() => setDiscountValue(value)} className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold ${discount === value ? 'bg-budu-500 text-white' : 'bg-slate-100 text-slate-500'}`}>{label}</button>
          ))}
          <label className="relative shrink-0">
            <input value={discount} onChange={(e) => setDiscountValue(e.target.value)} inputMode="decimal" aria-label="折扣输入" className="h-8 w-16 rounded-lg border border-slate-200 bg-white pl-2 pr-6 text-xs font-semibold outline-none focus:border-budu-400" />
            <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-400">折</span>
          </label>
        </div>
      </div>
      <label className="block text-xs text-slate-400">备注<input value={remark} onChange={(e) => setRemarkValue(e.target.value)} placeholder="订单备注" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-budu-400" /></label>
    </div>
  )

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
          items: cartLines.map((line) => ({
            productId: line.product.productId,
            quantity: line.quantity,
            gift: line.gift,
            ...(Array.isArray(line.comboIds) && line.comboIds.length > 0 ? { comboFlavorIds: line.comboIds } : {}),
          })),
          discountPercent,
          remark,
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
        if (resumedSession === null) {
          setCart({})
          savePosCart(user.id, storeId, {})
        }
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
    if (!paymentMethod) return
    // 真实微信付款码仅接受 18 位数字（前缀 10-15）；mock 模式保持向后兼容
    if (paymentMethod === 'wechat' && !mockMode && !isValidWechatAuthCode(authCode)) {
      setError('付款码无效，请重新扫描顾客的微信付款码')
      setScannerChannel('wechat')
      return
    }
    completePayment(paymentMethod, authCode)
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
        if (resumedSession === null) {
          setCart({})
          savePosCart(user.id, storeId, {})
        }
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
    if (resumedSession !== null) {
      savePendingOrder(user.id, storeId, '')
      saveSuccessOrder(user.id, storeId, '')
      saveCheckoutKey(user.id, storeId, resumedSession.checkoutKey)
      savePosCart(user.id, storeId, resumedSession.cart)
      setCheckoutKeyState(resumedSession.checkoutKey)
      setCart(resumedSession.cart)
      setResumedSession(null)
      setOrder(null)
      setPayment(null)
      setScannerChannel('')
      setStage('ordering')
      return
    }
    clearPosTransaction(user.id, storeId)
    setCart({})
    setOrder(null)
    setPayment(null)
    setScannerChannel('')
    setCheckoutKeyState('')
    setQuery('')
    setCategory('全部')
    setStage('ordering')
    loadUserData().catch(() => {})
  }

  const handleExit = () => {
    // 未付款订单不残留：下次进入 POS 直接回到点单界面
    savePendingOrder(user.id, storeId, '')
    loadUserData().catch(() => {})
    onExit()
  }

  const confirmExit = () => {
    if (window.confirm('确定退出 POS 吗？')) {
      handleExit()
    }
  }

  const hasUnresolvedWechat = () =>
    Boolean(payment && payment.provider === 'wechat_pay' && ['created', 'pending'].includes(payment.status))

  const returnToOrdering = () => {
    if (hasUnresolvedWechat()) {
      setError('存在未核对的微信支付，请先完成核对（继续核对，或取消并核对）')
      return
    }
    savePendingOrder(user.id, storeId, '')
    setScannerChannel('')
    setCashConfirm(false)
    setResumedSession(null)
    setStage('ordering')
  }

  const resumePendingOrder = async (selectedOrder) => {
    if (!selectedOrder || selectedOrder.status !== 'pending_payment') return
    setShowOrders(false)
    setError('')
    savePendingOrder(user.id, selectedOrder.storeId, selectedOrder.id)
    saveSuccessOrder(user.id, selectedOrder.storeId, '')
    const targetSession = loadPosStoreSession(user.id, selectedOrder.storeId)
    const sameCheckout = targetSession.pendingOrderId === selectedOrder.id
      || (targetSession.checkoutKey && targetSession.checkoutKey === selectedOrder.checkoutKey)
    setResumedSession(sameCheckout ? null : {
      cart: migratePosCart(targetSession.cart && typeof targetSession.cart === 'object' ? targetSession.cart : {}),
      checkoutKey: targetSession.checkoutKey || '',
    })
    if (selectedOrder.storeId !== storeId) {
      setStoreId(selectedOrder.storeId)
      return
    }
    try {
      const data = await api(`/v2/pos/orders/${selectedOrder.id}`)
      setOrder(data.order)
      setPayment(data.order.payments?.[0] || null)
      setStage('payment')
    } catch (e) {
      savePendingOrder(user.id, selectedOrder.storeId, '')
      setResumedSession(null)
      setError(e.message)
    }
  }

  useSwipeBack({
    enabled: stage !== 'loading' && stores.length > 0,
    onBack: () => {
      if (scannerChannel) setScannerChannel('')
      else if (cashConfirm) setCashConfirm(false)
      else if (cartOpen) setCartOpen(false)
      else if (showOrders) setShowOrders(false)
      else if (stage === 'payment') returnToOrdering()
      else if (stage === 'success') startNext()
      else handleExit()
    },
  })

  if (stores.length === 0) {
    return <div className="grid min-h-[100dvh] place-items-center bg-slate-100 p-6"><div className="max-w-sm rounded-3xl bg-white p-8 text-center shadow-xl"><Package className="mx-auto h-10 w-10 text-slate-300" /><h2 className="mt-4 text-lg font-bold text-slate-800">没有可用门店</h2><p className="mt-2 text-sm text-slate-400">请先让开发者为账号绑定门店。</p><button onClick={handleExit} className="mt-6 rounded-xl bg-budu-500 px-5 py-2.5 text-sm font-semibold text-white">返回系统</button></div></div>
  }

  if (showOrders) {
    return (
      <div className="h-screen h-[100dvh] overflow-y-auto bg-slate-100" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="mx-auto w-full max-w-[1600px] p-3 sm:p-5 lg:p-6">
          <OrderRecordsPage user={user} onBack={() => setShowOrders(false)} onPay={resumePendingOrder} />
        </div>
      </div>
    )
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
            <button onClick={returnToOrdering} className="flex items-center gap-2 text-sm font-semibold text-slate-400 hover:text-slate-700"><ArrowLeft className="h-4 w-4" />返回点单</button>
            <div className="mt-8 text-center"><p className="text-sm font-semibold text-slate-400">{mockMode ? '扫码模拟支付 · 不调用真实支付接口' : (channels.length === 1 && channels.includes('cash') ? '现金收款 · 当面确认后完成订单' : '请选择支付方式')}</p><h2 className="mt-3 text-2xl font-bold text-slate-900">应付金额</h2><p className="mt-4 text-5xl font-black tracking-tight text-budu-600">{formatCents(order.payableAmount)}</p><p className="mt-3 text-xs text-slate-400">订单号 {order.orderNo}</p></div>
            {error && <div className="mt-6 rounded-xl bg-rose-50 px-4 py-3 text-center text-sm text-rose-600">{error}</div>}
            {pendingPayment && (
              <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-center text-sm font-semibold text-amber-700">
                {payment?.provider === 'wechat_pay'
                  ? '正在核对微信扣款结果，请勿再次扫码或改用其他支付方式'
                  : '正在确认支付，请勿重复付款'}
              </div>
            )}
            {payment && !['success'].includes(payment.status) && (
              <div className="mx-auto mt-4 flex max-w-sm items-center justify-center gap-3">
                <button disabled={queryingPayment} onClick={queryCurrentPayment} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-500 hover:bg-slate-50 disabled:opacity-50">
                  {queryingPayment ? '查询中…' : (payment?.provider === 'wechat_pay' ? '继续核对' : '查询支付结果')}
                </button>
                {pendingPayment && (
                  <button disabled={queryingPayment} onClick={closeCurrentPayment} className="rounded-xl border border-rose-200 px-4 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50">
                    {payment?.provider === 'wechat_pay' ? '取消并核对' : '关闭当前支付'}
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
        {scannerChannel && (
          <>
            <CameraScanner channel={scannerChannel} onDetected={acceptScannedCode} onCancel={() => setScannerChannel('')} decoderFactory={scannerDecoderFactory} />
            {scannerChannel === 'wechat' && (
              <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[120] flex justify-center">
                <p className="rounded-full bg-slate-900/85 px-5 py-2.5 text-sm font-semibold text-white shadow-xl">
                  请顾客输入微信支付密码，或等待扣款结果
                </p>
              </div>
            )}
          </>
        )}
      </>
    )
  }

  if (stage === 'success' && order) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-emerald-50 p-6" style={{ paddingTop: 'max(24px, env(safe-area-inset-top))', paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}>
        <div className="w-full max-w-lg rounded-[32px] bg-white p-9 text-center shadow-2xl"><div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-emerald-100"><Check className="h-10 w-10 text-emerald-600" strokeWidth={3} /></div><h2 className="mt-5 text-3xl font-black text-slate-900">支付成功</h2><p className="mt-2 text-sm text-slate-400">{order.paymentMethod === 'cash' ? '现金已收款，订单已完成' : (mockMode ? '本次为模拟支付，订单已保存为 completed' : '支付已确认，订单已完成')}</p><p className="mt-6 text-5xl font-black text-emerald-600">{formatCents(order.payableAmount)}</p><div className="mt-7 space-y-2 rounded-2xl bg-slate-50 p-5 text-left text-sm"><p className="flex justify-between"><span className="text-slate-400">订单号</span><span className="font-semibold text-slate-700">{order.orderNo}</span></p><p className="flex justify-between"><span className="text-slate-400">门店</span><span className="font-semibold text-slate-700">{order.storeName}</span></p><p className="flex justify-between"><span className="text-slate-400">支付方式</span><span className="font-semibold text-slate-700">{paymentLabels[order.paymentMethod] || order.paymentMethod}</span></p></div><button onClick={startNext} className="mt-7 w-full rounded-2xl bg-budu-500 py-4 text-base font-bold text-white shadow-lg shadow-budu-200">开始下一笔订单</button><button onClick={startNext} className="mt-3 px-4 py-2 text-sm font-semibold text-slate-400 hover:text-slate-700">返回 POS</button></div>
      </div>
    )
  }

  return (
    <div className="flex h-screen h-[100dvh] flex-col overflow-hidden bg-slate-100 text-slate-800" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', touchAction: 'manipulation' }}>
      <header className={`flex shrink-0 items-center gap-2 px-3 ${isDesktop ? 'h-14 bg-slate-900 text-white shadow-sm' : 'h-[60px] border-b border-slate-200 bg-white'}`}>
        <button onClick={confirmExit} className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl transition ${isDesktop ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-slate-100 text-slate-500'}`} aria-label="退出 POS"><X className="h-5 w-5" /></button>
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <strong className={isDesktop ? 'text-white' : 'text-budu-600'}>BUDU POS</strong>
          {isDesktop && <span className="rounded-md bg-budu-500/20 px-2 py-1 text-[10px] font-bold text-budu-200">点单</span>}
        </div>
        <label className="relative min-w-0 flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索商品名称 / SKU / 条码" className={`w-full py-2.5 pl-10 pr-4 text-sm outline-none ring-budu-200 focus:ring-2 ${isDesktop ? 'rounded-lg border border-white/10 bg-white/10 text-white placeholder:text-slate-400' : 'rounded-xl bg-slate-100 text-slate-800'}`} />
        </label>
        <label className="relative shrink-0">
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)} className={`h-10 max-w-[170px] appearance-none pl-3 pr-8 text-sm font-semibold outline-none ${isDesktop ? 'rounded-lg border border-white/10 bg-slate-800 text-white' : 'rounded-xl border border-slate-200 bg-white text-slate-700'}`} disabled={stores.length === 1}>{stores.map((store) => <option key={store.key} value={store.key}>{store.name}</option>)}</select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        </label>
        <button onClick={() => setShowOrders(true)} className={`flex shrink-0 items-center gap-1.5 px-3 py-2 text-xs font-semibold transition ${isDesktop ? 'rounded-lg bg-white/10 text-slate-100 hover:bg-white/20' : 'rounded-xl border border-slate-200 bg-white text-slate-600 hover:border-budu-300 hover:text-budu-600'}`} aria-label="订单记录">
          <ReceiptText className={`h-4 w-4 ${isDesktop ? 'text-budu-300' : 'text-budu-600'}`} />
          <span className="hidden sm:inline">订单记录</span>
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {isDesktop && <aside data-testid="pos-cart-panel" className="flex min-h-0 w-[40%] min-w-[390px] max-w-[500px] shrink-0 flex-col border-r border-slate-200 bg-white shadow-[4px_0_18px_rgba(15,23,42,0.04)]">
          <div className="flex h-14 shrink-0 items-center border-b border-slate-100 px-4">
            <ShoppingCart className="h-5 w-5 text-budu-600" />
            <h2 className="ml-2 text-base font-black text-slate-800">当前订单</h2>
            <span className="ml-2 rounded-full bg-budu-50 px-2 py-0.5 text-xs font-bold text-budu-600">{cartCount} 件</span>
            <button onClick={clearCart} disabled={!cartCount} className="ml-auto rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-400 transition hover:bg-rose-50 hover:text-rose-500 disabled:opacity-30">清空</button>
          </div>
          <div className="grid h-8 shrink-0 grid-cols-[24px_minmax(0,1fr)_86px_120px] items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 text-[10px] font-semibold text-slate-400">
            <span className="text-center">#</span><span>商品</span><span className="text-center">数量</span><span className="text-right">金额 / 操作</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {cartLines.length === 0 ? <div className="grid h-full place-items-center text-center"><div><div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-slate-50"><ShoppingCart className="h-8 w-8 text-slate-200" /></div><p className="mt-4 text-sm font-bold text-slate-400">还没有选择商品</p><p className="mt-1 text-xs text-slate-300">点击右侧商品开始点单</p></div></div> : cartLines.map(renderDesktopCartLine)}
          </div>
          <div className="shrink-0 border-t border-slate-200 bg-white p-3" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
            {renderDiscountControls()}
            <div className="mt-3 flex items-end justify-between border-t border-dashed border-slate-200 pt-3">
              <div className="text-xs text-slate-400"><p className="font-semibold text-slate-500">合计 · {cartCount} 件</p><p className="mt-1">商品小计 {formatCents(cartSubtotal)}</p>{cartDiscountAmount > 0n && <p className="mt-1 font-semibold text-rose-500">优惠 -{formatCents(cartDiscountAmount)}</p>}</div>
              <div className="text-right"><p className="text-[11px] font-semibold text-slate-400">应收金额</p><p className="text-2xl font-black tracking-tight text-budu-600">{formatCents(cartTotal)}</p></div>
            </div>
            <button onClick={checkout} disabled={!cartCount || submitting || cartTotal <= 0n} className="mt-3 w-full rounded-xl bg-budu-500 py-3 text-sm font-black text-white shadow-lg shadow-budu-100 transition hover:bg-budu-600 active:scale-[0.99] disabled:bg-slate-200 disabled:shadow-none">{submitting ? '正在创建订单…' : '结算'}</button>
          </div>
        </aside>}

        <main data-testid="pos-catalog-panel" className="flex min-h-0 min-w-0 flex-1 flex-col bg-slate-100">
          <div className={`flex shrink-0 items-center border-b border-slate-200 bg-white ${isDesktop ? 'h-14 px-3' : 'px-3 py-2.5'}`}>
            <div className={`flex min-w-0 flex-1 overflow-x-auto ${isIpad || !isDesktop ? 'gap-2' : 'gap-1.5'}`} aria-label="商品分类" data-swipe-back-ignore="true">
              {categories.map((item) => <button key={item} onClick={() => setCategory(item)} className={`shrink-0 whitespace-nowrap font-bold transition ${isIpad ? 'rounded-xl px-4 py-2.5 text-[13px]' : (isDesktop ? 'rounded-lg px-3.5 py-2 text-[13px]' : 'rounded-full border px-4 py-2 text-[13px]')} ${category === item ? 'border-budu-500 bg-budu-500 text-white shadow-sm' : 'border-slate-200 bg-slate-50 text-slate-500 hover:bg-slate-100 hover:text-slate-700'}`}>{item}</button>)}
            </div>
            {isDesktop && <span className="ml-3 shrink-0 text-xs font-semibold text-slate-400">{visibleProducts.length} 个商品</span>}
          </div>
          {error && <div className={`shrink-0 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600 ${isDesktop ? 'mx-4 mt-3' : 'mx-3 mt-2'}`}>{error}</div>}
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {loadingProducts ? (
              <div className="grid h-full place-items-center text-sm text-slate-400">正在加载商品…</div>
            ) : visibleProducts.length === 0 ? (
              <div className="grid h-full place-items-center text-center text-slate-400">
                <div>
                  <Package className="mx-auto h-8 w-8 text-slate-300" />
                  <p className="mt-2 text-sm">暂无符合条件的上架商品</p>
                </div>
              </div>
            ) : (
              <div
                data-testid="pos-product-grid"
                className={`grid gap-2 ${isIpad ? 'grid-cols-3' : (isDesktop ? '' : 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5')}`}
                style={isDesktop && !isIpad ? { gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' } : undefined}
              >
                {visibleProducts.map((product) => {
                  const quantity = Number(cart[product.productId] || 0)
                  const imageSrc = product.hasImage ? `/api/v2/pos/products/${product.productId}/image?v=${encodeURIComponent(product.updatedAt || '')}` : ''
                  return (
                    <button
                      key={product.productId}
                      data-testid="pos-product-card"
                      data-product-id={product.productId}
                      onClick={() => addProduct(product)}
                      className={`relative overflow-hidden border border-slate-200 bg-white text-left shadow-sm transition hover:border-budu-300 hover:shadow-md active:scale-[0.97] active:border-budu-400 ${isDesktop || isIpad ? `flex items-center ${isIpad ? 'min-h-24 rounded-xl p-2.5' : 'min-h-[82px] rounded-lg p-2'}` : 'rounded-xl'}`}
                    >
                      <div className={isDesktop || isIpad ? `${isIpad ? 'h-16 w-16 rounded-xl' : 'h-12 w-12 rounded-lg'} shrink-0 overflow-hidden bg-slate-100` : 'aspect-square bg-slate-100'}>
                        {imageSrc ? (
                          <img src={imageSrc} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none' }} className="h-full w-full object-cover" />
                        ) : (
                          <div className="grid h-full place-items-center"><Package className={`${isDesktop || isIpad ? 'h-5 w-5' : 'h-6 w-6'} text-slate-300`} /></div>
                        )}
                      </div>
                      {quantity > 0 && (
                        <span className="absolute right-1.5 top-1.5 grid min-w-5 place-items-center rounded-full bg-budu-500 px-1 py-0.5 text-[10px] font-bold text-white shadow">
                          {quantity}
                        </span>
                      )}
                      <div className={isDesktop || isIpad ? `min-w-0 flex-1 ${isIpad ? 'pl-2.5' : 'pl-2'}` : 'p-1.5'}>
                        <p
                          data-testid="pos-product-name"
                          title={product.name}
                          className={`font-bold text-slate-800 ${isIpad ? 'whitespace-normal break-words pr-5 text-[13px] leading-[1.35]' : (isDesktop ? 'truncate pr-4 text-xs leading-tight' : 'truncate text-[11px] leading-tight')}`}
                        >
                          {product.name}
                        </p>
                        <div className="mt-1 flex items-end justify-between gap-1">
                          <span className={`${isDesktop || isIpad ? 'text-sm' : 'text-[13px]'} truncate font-black text-budu-600`}>{formatCents(product.salePriceCents)}</span>
                          <span className="shrink-0 text-[10px] text-slate-400">/{product.unit}</span>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </main>
      </div>

      {!isDesktop && <div className="shrink-0 border-t border-slate-200 bg-white px-3 py-2" style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }} aria-label="结算栏">
        <div className="flex items-center gap-3">
          <button onClick={() => setCartOpen(true)} disabled={!cartCount} className="relative grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600 disabled:opacity-40" aria-label="打开购物车">
            <ShoppingCart className="h-6 w-6" />
            {cartCount > 0 && <span className="absolute -right-1 -top-1 grid min-w-5 place-items-center rounded-full bg-budu-500 px-1.5 py-0.5 text-[10px] font-bold text-white">{cartCount}</span>}
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-slate-400">合计 · {cartCount} 件</p>
            <p className="truncate text-base font-black text-slate-900">{formatCents(cartTotal)}</p>
          </div>
          <button onClick={checkout} disabled={!cartCount || submitting || cartTotal <= 0n} className="shrink-0 rounded-xl bg-budu-500 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-budu-100 disabled:bg-slate-200 disabled:shadow-none">{submitting ? '创建中…' : '结算'}</button>
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
              {cartLines.length === 0 ? <div className="grid h-full place-items-center text-center"><div><ShoppingCart className="mx-auto h-10 w-10 text-slate-200" /><p className="mt-3 text-sm font-semibold text-slate-400">点击商品加入购物车</p></div></div> : cartLines.map(renderCartLine)}
            </div>
            <div className="shrink-0 border-t border-slate-100 p-4">
              {renderDiscountControls()}
              <div className="mb-3 flex items-end justify-between">
                <div><p className="text-xs text-slate-400">合计 · {cartCount} 件</p><p className="mt-1 text-2xl font-black text-slate-900">{formatCents(cartTotal)}</p></div>
                <div className="text-right"><button onClick={clearCart} disabled={!cartCount} className="text-xs font-semibold text-slate-400 hover:text-rose-500 disabled:opacity-30">清空</button>{cartDiscountAmount > 0n && <p className="mt-1 text-xs font-semibold text-rose-500">优惠 -{formatCents(cartDiscountAmount)}</p>}</div>
              </div>
              <button onClick={() => { setCartOpen(false); checkout() }} disabled={!cartCount || submitting || cartTotal <= 0n} className="w-full rounded-xl bg-budu-500 py-3 text-sm font-bold text-white shadow-lg shadow-budu-100 disabled:bg-slate-200 disabled:shadow-none">{submitting ? '正在创建订单…' : '结算'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Balls 礼盒搭配面板（点单/支付任意阶段可用） */}
      {comboProduct && (
        <div className="fixed inset-0 z-[105] flex items-end justify-center bg-slate-950/60 p-0 backdrop-blur-sm sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label="Balls 礼盒搭配">
          <div className="max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-6 shadow-2xl sm:rounded-3xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-black text-slate-900">Balls-礼盒 · 自由搭配</h3>
                <p className="mt-1 text-xs text-slate-400">¥299 / 盒 · 请选满 4 款口味（可重复）</p>
              </div>
              <button onClick={() => setComboProduct(null)} className="grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400 hover:bg-slate-100" aria-label="关闭搭配面板"><X className="h-5 w-5" /></button>
            </div>

            {/* 4 个槽位 */}
            <div className="mt-4 grid grid-cols-4 gap-2">
              {comboSlots.map((slot, idx) => (
                <button
                  key={idx}
                  onClick={() => setComboActiveSlot(idx)}
                  className={`flex min-h-12 flex-col items-center justify-center rounded-xl border-2 transition ${
                    comboActiveSlot === idx ? 'border-budu-500 bg-budu-50' : 'border-slate-100 bg-slate-50'
                  } ${slot ? 'text-slate-800' : 'text-slate-300'}`}
                >
                  <span className="text-[10px] font-bold text-slate-400">口味 {idx + 1}</span>
                  <span className="mt-0.5 line-clamp-2 px-1 text-center text-[11px] font-semibold">{slot || '未选'}</span>
                </button>
              ))}
            </div>

            {/* 口味候选 */}
            <p className="mt-4 pb-1 text-xs font-semibold text-slate-400">选择口味（当前第 {comboActiveSlot + 1} 格）</p>
            <div className="grid max-h-[38dvh] grid-cols-2 gap-2 overflow-y-auto">
              {comboFlavors.map((f) => {
                const picked = comboSlots.filter((x) => x === String(f.name).replace(/^巧克力豆\./, '')).length
                const imageSrc = f.hasImage ? `/api/v2/pos/products/${f.productId}/image?v=${encodeURIComponent(f.updatedAt || '')}` : ''
                return (
                  <button
                    key={f.productId}
                    onClick={() => {
                      const name = String(f.name).replace(/^巧克力豆\./, '')
                      const slots = [...comboSlots]
                      slots[comboActiveSlot] = name
                      setComboSlots(slots)
                      setComboReady(slots.every((x) => !!x))
                      const nextEmpty = slots.findIndex((x, i) => i > comboActiveSlot && !x)
                      if (nextEmpty >= 0) setComboActiveSlot(nextEmpty)
                    }}
                    className={`flex items-center gap-2 rounded-xl border p-2 text-left transition ${
                      picked > 0 ? 'border-budu-300 bg-budu-50/60' : 'border-slate-100 bg-white hover:border-budu-200'
                    }`}
                  >
                    {imageSrc ? (
                      <img src={imageSrc} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" />
                    ) : (
                      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100"><Package className="h-4 w-4 text-slate-300" /></div>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-slate-700">{String(f.name).replace(/^巧克力豆\./, '')}</span>
                      <span className="block text-[10px] text-slate-400">{formatCents(f.salePriceCents)}/{f.unit}</span>
                    </span>
                    {picked > 0 && <span className="shrink-0 rounded bg-budu-500 px-1 py-0.5 text-[9px] font-bold text-white">x{picked}</span>}
                  </button>
                )
              })}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <button onClick={() => setComboProduct(null)} className="rounded-xl border border-slate-200 py-3 text-sm font-bold text-slate-500">取消</button>
              <button
                onClick={() => {
                  const ids = comboSlots.map((name) => {
                    const f = comboFlavors.find((x) => String(x.name).replace(/^巧克力豆\./, '') === name)
                    return f ? f.productId : ''
                  })
                  if (ids.some((id) => !id)) return
                  changeQuantity(comboLineKey(comboProduct.productId, ids), 1)
                  setComboProduct(null)
                }}
                disabled={!comboReady}
                className="rounded-xl bg-budu-500 py-3 text-sm font-bold text-white disabled:opacity-40"
              >
                {comboReady ? '加入购物车 · ¥299' : `请选满 4 款口味（${comboSlots.filter(Boolean).length}/4）`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
