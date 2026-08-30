import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeft, BadgePercent, Ban, Banknote, Download, FileSpreadsheet, Package, ReceiptText, RotateCcw, Search, ShoppingBag, Trash2, WalletCards, X } from 'lucide-react'
import * as XLSX from 'xlsx'
import { api } from '../utils/api'
import { allStores } from '../utils/selectors'
import { centsToYuan, formatCents } from '../utils/pos'

const paymentLabels = { wechat: '微信支付', alipay: '支付宝', cash: '现金' }
const statusLabels = {
  draft: '草稿',
  pending_payment: '待支付',
  paid: '已支付',
  completed: '已完成',
  cancelled: '已作废',
  partially_refunded: '部分退款',
  refunded: '已退款',
}

const cancelReasons = ['重复下单', '点错商品', '选错门店', '顾客取消', '其他']

function localTime(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function beijingToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

const emptySummary = {
  recordCount: 0,
  paidOrderCount: 0,
  collectedAmount: '0',
  grossAmount: '0',
  refundAmount: '0',
  discountAmount: '0',
  itemQuantity: 0,
  averageAmount: '0',
}

const protectedDeleteStatuses = new Set(['paid', 'completed', 'partially_refunded', 'refunded', 'pending_payment'])

function isOrderDeletable(order) {
  return Boolean(order && !protectedDeleteStatuses.has(order.status) && (order.payments || []).length === 0)
}

export default function OrderRecordsPage({ user, onBack, onPay }) {
  const stores = useMemo(() => {
    const list = allStores()
    if (['developer', 'finance', 'admin'].includes(user.role)) return list
    const allowed = new Set(user.storeKeys || [])
    return list.filter((store) => allowed.has(store.key))
  }, [user])
  const [from, setFrom] = useState(beijingToday)
  const [to, setTo] = useState(beijingToday)
  const [store, setStore] = useState('all')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState(emptySummary)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [detail, setDetail] = useState(null)
  const [refundOrder, setRefundOrder] = useState(null)
  const [refundMode, setRefundMode] = useState('full')
  const [refundQty, setRefundQty] = useState({})
  const [refundReason, setRefundReason] = useState('')
  const [refunding, setRefunding] = useState(false)
  const [deleteOrder, setDeleteOrder] = useState(null)
  const [deleteConfirmed, setDeleteConfirmed] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [cancelOrder, setCancelOrder] = useState(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelNote, setCancelNote] = useState('')
  const [cancelling, setCancelling] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    const params = new URLSearchParams()
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    if (store && store !== 'all') params.set('store', store)
    if (paymentMethod) params.set('paymentMethod', paymentMethod)
    if (status) params.set('status', status)
    if (q.trim()) params.set('q', q.trim())
    try {
      const data = await api(`/v2/pos/orders?${params.toString()}`)
      setRows(data.rows || [])
      setTotal(data.total || 0)
      setSummary({ ...emptySummary, ...(data.summary || {}), recordCount: data.summary?.recordCount ?? data.total ?? 0 })
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // 查询条件（日期/门店/支付方式/状态/关键词）变化时实时重新拉取
  useEffect(() => { load() }, [from, to, store, paymentMethod, status, q]) // eslint-disable-line react-hooks/exhaustive-deps

  const exportExcel = () => {
    if (rows.length === 0) {
      setError('当前没有可导出的订单')
      return
    }
    const orderRows = rows.map((order) => [
      order.orderNo,
      localTime(order.createdAt),
      order.storeName,
      order.cashierNameSnapshot,
      order.items.length,
      order.items.reduce((sum, item) => sum + item.quantity, 0),
      order.items.map((item) => `${item.productNameSnapshot}×${item.quantity}`).join('、'),
      Number(centsToYuan(order.payableAmount)),
      paymentLabels[order.paymentMethod] || order.paymentMethod || '—',
      statusLabels[order.status] || order.status,
    ])
    const itemRows = []
    for (const order of rows) {
      for (const item of order.items || []) {
        itemRows.push([
          order.orderNo,
          item.productNameSnapshot,
          item.skuSnapshot,
          Number(centsToYuan(item.unitPrice)),
          item.quantity,
          Number(centsToYuan(item.lineAmount)),
        ])
      }
    }
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['订单号', '下单时间', '门店', '收银员', '商品种类', '商品数量', '商品明细', '应付金额（元）', '支付方式', '状态'],
      ...orderRows,
    ]), '订单列表')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['订单号', '商品名称', 'SKU', '单价（元）', '数量', '小计（元）'],
      ...itemRows,
    ]), '商品明细')
    XLSX.writeFile(wb, `budu订单记录_${from || '开始'}-${to || '结束'}.xlsx`)
  }

  const openDeleteConfirm = (order) => {
    if (user.role !== 'developer' || !isOrderDeletable(order)) return
    setDeleteOrder(order)
    setDeleteConfirmed(false)
    setError('')
  }

  const closeDeleteConfirm = () => {
    if (deleting) return
    setDeleteOrder(null)
    setDeleteConfirmed(false)
  }

  const removeOrder = async () => {
    if (!deleteOrder || !deleteConfirmed || deleting) return
    const order = deleteOrder
    setDeleting(true)
    setError('')
    try {
      await api(`/v2/pos/orders/${order.id}`, { method: 'DELETE' })
      if (detail?.id === order.id) setDetail(null)
      setDeleteOrder(null)
      setDeleteConfirmed(false)
      setNotice(`订单 ${order.orderNo} 已删除`)
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setDeleting(false)
    }
  }

  const openCancelConfirm = (order) => {
    if (!order || order.status !== 'pending_payment') return
    setCancelOrder(order)
    setCancelReason('')
    setCancelNote('')
    setError('')
  }

  const closeCancelConfirm = () => {
    if (cancelling) return
    setCancelOrder(null)
    setCancelReason('')
    setCancelNote('')
  }

  const voidOrder = async () => {
    if (!cancelOrder || !cancelReason || cancelling) return
    const reason = cancelReason === '其他' ? cancelNote.trim() : cancelReason
    if (reason.length < 2) {
      setError('请填写作废原因')
      return
    }
    const order = cancelOrder
    setCancelling(true)
    setError('')
    try {
      await api(`/v2/pos/orders/${order.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      })
      if (detail?.id === order.id) setDetail(null)
      setCancelOrder(null)
      setCancelReason('')
      setCancelNote('')
      setNotice(`订单 ${order.orderNo} 已作废`)
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setCancelling(false)
    }
  }

  const orderRefundedCents = (order) => (order.refunds || [])
    .filter((refund) => refund.status === 'completed')
    .reduce((sum, refund) => sum + BigInt(refund.amount), 0n)
  const orderReservedRefundCents = (order) => (order.refunds || [])
    .filter((refund) => ['pending', 'completed'].includes(refund.status))
    .reduce((sum, refund) => sum + BigInt(refund.amount), 0n)
  const orderRemainingCents = (order) => BigInt(order.payableAmount) - orderReservedRefundCents(order)
  const hasPendingRefund = (order) => (order.refunds || []).some((refund) => refund.status === 'pending')
  const itemRefundedQty = (order, orderItemId) => (order.refunds || [])
    .filter((refund) => refund.status === 'completed')
    .reduce((sum, refund) => sum + (refund.items || [])
      .filter((item) => item.orderItemId === orderItemId)
      .reduce((inner, item) => inner + item.quantity, 0), 0)

  const openRefund = (order) => {
    setRefundOrder(order)
    setRefundMode('full')
    setRefundQty({})
    setRefundReason('')
    setError('')
  }

  const partialTotal = refundOrder
    ? refundOrder.items.reduce((sum, item) => {
      const selected = Number(refundQty[item.id] || 0)
      if (selected <= 0) return sum
      const refundedBefore = itemRefundedQty(refundOrder, item.id)
      const lineActual = item.actualAmount == null
        ? (BigInt(item.unitPrice) * BigInt(item.quantity) * BigInt(refundOrder.discountPercent ?? 100) + 50n) / 100n
        : BigInt(item.actualAmount)
      const totalQuantity = BigInt(item.quantity)
      const before = lineActual * BigInt(refundedBefore) / totalQuantity
      const after = lineActual * BigInt(refundedBefore + selected) / totalQuantity
      return sum + after - before
    }, 0n)
    : 0n

  const submitRefund = async () => {
    if (!refundOrder || refunding) return
    if (refundMode === 'partial' && partialTotal <= 0n) {
      setError('请选择至少一个商品并填写退款数量')
      return
    }
    setRefunding(true)
    setError('')
    const items = refundMode === 'partial'
      ? refundOrder.items
        .map((item) => ({ orderItemId: item.id, quantity: Number(refundQty[item.id] || 0) }))
        .filter((row) => row.quantity > 0)
      : undefined
    const key = globalThis.crypto?.randomUUID?.() || `refund-${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      const data = await api(`/v2/pos/orders/${refundOrder.id}/refunds`, {
        method: 'POST',
        body: JSON.stringify({ items, reason: refundReason, requestKey: key }),
      })
      setRefundOrder(null)
      setNotice(data.refund?.status === 'pending' ? '微信退款申请已受理，系统正在查询最终退款结果' : '退款已完成')
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setRefunding(false)
    }
  }

  const queryRefund = async (refund) => {
    setError('')
    setNotice('')
    try {
      const data = await api(`/v2/pos/refunds/${refund.id}/query`, { method: 'POST' })
      setNotice(data.refund?.status === 'completed' ? '退款已完成' : data.refund?.status === 'failed' ? '退款未完成，请联系管理员处理' : '退款仍在处理中，系统会继续自动查询')
      if (detail?.id === data.order?.id) setDetail(data.order)
      await load()
    } catch (e) {
      setError(e.message)
    }
  }

  const inputClass = 'h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-budu-400 focus:ring-2 focus:ring-budu-100'
  const actionButtonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold transition only:col-span-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50'

  const renderOrderActions = (order, compact = false, showDetail = true) => (
    <div className={`grid gap-2 ${compact ? 'grid-cols-2 sm:flex sm:justify-end' : 'grid-cols-2 sm:flex sm:flex-wrap sm:justify-end'}`}>
      {order.status === 'pending_payment' && typeof onPay === 'function' && (
        <button onClick={() => onPay(order)} className={`${actionButtonClass} bg-emerald-600 text-white shadow-sm shadow-emerald-100 hover:bg-emerald-700`} aria-label={`去支付 ${order.orderNo}`}><WalletCards className="h-4 w-4" />去支付</button>
      )}
      {order.status === 'pending_payment' && (
        <button onClick={() => openCancelConfirm(order)} className={`${actionButtonClass} border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100`} aria-label={`作废 ${order.orderNo}`}><Ban className="h-4 w-4" />作废订单</button>
      )}
      {user.role !== 'public' && ['paid', 'completed', 'partially_refunded'].includes(order.status) && !hasPendingRefund(order) && orderRemainingCents(order) > 0n && (
        <button onClick={() => openRefund(order)} className={`${actionButtonClass} border border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100`} aria-label={`退款 ${order.orderNo}`}><Download className="h-4 w-4" />退款</button>
      )}
      {hasPendingRefund(order) && <span className={`${actionButtonClass} bg-amber-50 text-amber-700`}>退款处理中</span>}
      {showDetail && <button onClick={() => setDetail(order)} className={`${actionButtonClass} ${compact && order.status === 'pending_payment' ? 'col-span-2' : ''} border border-budu-200 bg-budu-50 text-budu-700 hover:bg-budu-100`} aria-label={`查看明细 ${order.orderNo}`}><Package className="h-4 w-4" />订单明细</button>}
      {user.role === 'developer' && isOrderDeletable(order) && (
        <button onClick={() => openDeleteConfirm(order)} className={`${actionButtonClass} border border-rose-200 bg-white text-rose-600 hover:bg-rose-50`} aria-label={`删除 ${order.orderNo}`}><Trash2 className="h-4 w-4" />删除</button>
      )}
    </div>
  )

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-slate-200/80 bg-slate-100/95 py-2 backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0">
        <button onClick={onBack} className="grid h-11 w-11 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:text-budu-600 active:scale-95" aria-label="返回">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h2 className="text-xl font-bold text-slate-900">订单记录</h2>
          <p className="mt-0.5 text-xs text-slate-400">按日期/门店/支付方式/状态查询 POS 订单与收款记录</p>
        </div>
        <button onClick={exportExcel} className="ml-auto flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50 active:scale-[0.98] sm:px-4">
          <FileSpreadsheet className="h-4 w-4" />导出 Excel
        </button>
      </div>

      {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</div>}

      <section className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-2 xl:grid-cols-6">
          <label className="text-xs font-semibold text-slate-500">开始日期<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`mt-1 w-full ${inputClass}`} /></label>
          <label className="text-xs font-semibold text-slate-500">结束日期<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`mt-1 w-full ${inputClass}`} /></label>
          <label className="text-xs font-semibold text-slate-500">门店<select value={store} onChange={(e) => setStore(e.target.value)} className={`mt-1 w-full ${inputClass}`}><option value="all">全部门店</option>{stores.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</select></label>
          <label className="text-xs font-semibold text-slate-500">支付方式<select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} className={`mt-1 w-full ${inputClass}`}><option value="">全部</option><option value="cash">现金</option><option value="wechat">微信</option><option value="alipay">支付宝</option></select></label>
          <label className="text-xs font-semibold text-slate-500">状态<select value={status} onChange={(e) => setStatus(e.target.value)} className={`mt-1 w-full ${inputClass}`}><option value="">默认（不含已作废）</option>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <div className="col-span-2 flex items-end gap-2 xl:col-span-1">
            <label className="relative flex-1 text-xs font-semibold text-slate-500">订单号<Search className="pointer-events-none absolute bottom-3 left-3 h-4 w-4 text-slate-400" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索订单号" className={`mt-1 w-full pl-9 ${inputClass}`} /></label>
            <button onClick={load} disabled={loading} className="h-11 shrink-0 rounded-xl bg-budu-500 px-5 text-sm font-semibold text-white transition active:scale-[0.98] disabled:opacity-50">{loading ? '查询中…' : '查询'}</button>
          </div>
        </div>
      </section>

      <section aria-label="订单汇总" className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        {[
          { label: '有效营收', value: formatCents(summary.collectedAmount), note: '仅无退款的支付成功订单', icon: Banknote, tone: 'bg-emerald-50 text-emerald-600' },
          { label: '有效订单', value: `${summary.paidOrderCount} 笔`, note: `全部记录 ${summary.recordCount} 笔`, icon: ShoppingBag, tone: 'bg-budu-50 text-budu-600' },
          { label: '商品数量', value: `${summary.itemQuantity} 件`, note: '仅有效订单商品', icon: Package, tone: 'bg-sky-50 text-sky-600' },
          { label: '客单价', value: formatCents(summary.averageAmount), note: '按有效订单计算', icon: ReceiptText, tone: 'bg-violet-50 text-violet-600' },
          { label: '优惠金额', value: formatCents(summary.discountAmount), note: '含折扣及赠送', icon: BadgePercent, tone: 'bg-amber-50 text-amber-600' },
          { label: '退款金额', value: formatCents(summary.refundAmount), note: '已完成退款', icon: RotateCcw, tone: 'bg-rose-50 text-rose-600' },
        ].map(({ label, value, note, icon: Icon, tone }) => (
          <article key={label} className="min-w-0 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm">
            <div className={`grid h-9 w-9 place-items-center rounded-xl ${tone}`}><Icon className="h-4 w-4" /></div>
            <p className="mt-3 text-xs font-semibold text-slate-400">{label}</p>
            <p className="mt-1 truncate text-xl font-black tabular-nums text-slate-900" title={value}>{value}</p>
            <p className="mt-1 truncate text-[11px] text-slate-400" title={note}>{note}</p>
          </article>
        ))}
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <p className="text-sm font-semibold text-slate-600">共 {total} 笔订单</p>
        </div>
        <div>
          <table className="block w-full text-left text-sm xl:table">
            <thead className="hidden border-b border-slate-100 bg-slate-50/80 text-xs font-semibold text-slate-400 xl:table-header-group">
              <tr>
                <th className="px-5 py-3">订单号</th>
                <th className="px-4 py-3">下单时间</th>
                <th className="px-4 py-3">门店</th>
                <th className="px-4 py-3">收银员</th>
                <th className="px-4 py-3 text-right">商品</th>
                <th className="px-4 py-3 text-right">金额（元）</th>
                <th className="px-4 py-3">支付方式</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-5 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="block space-y-3 bg-slate-50/70 p-3 xl:table-row-group xl:space-y-0 xl:divide-y xl:divide-slate-100 xl:bg-white xl:p-0">
              {loading ? (
                <tr className="block xl:table-row"><td colSpan="9" className="block px-5 py-14 text-center text-slate-400 xl:table-cell">正在加载订单…</td></tr>
              ) : rows.length === 0 ? (
                <tr className="block xl:table-row"><td colSpan="9" className="block px-5 py-14 text-center text-slate-400 xl:table-cell"><ReceiptText className="mx-auto mb-2 h-8 w-8 text-slate-300" />暂无符合条件的订单</td></tr>
              ) : rows.map((order) => (
                <tr key={order.id} className="block overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:border-budu-200 hover:shadow-md xl:table-row xl:rounded-none xl:border-0 xl:shadow-none xl:hover:bg-slate-50/70 xl:hover:shadow-none">
                  <td className="block border-b border-slate-100 px-4 py-3.5 font-mono text-xs font-bold text-slate-700 xl:table-cell xl:border-0 xl:px-5"><span className="mb-1 block font-sans text-[10px] font-semibold text-slate-400 xl:hidden">订单号</span><span>{order.orderNo}</span></td>
                  <td className="block px-4 pt-3 text-xs text-slate-500 xl:table-cell xl:px-4 xl:py-3.5 xl:text-sm"><span className="mr-2 font-semibold text-slate-400 xl:hidden">下单</span>{localTime(order.createdAt)}</td>
                  <td className="block px-4 pt-2 text-sm font-semibold text-slate-700 xl:table-cell xl:px-4 xl:py-3.5 xl:font-normal"><span className="mr-2 text-xs font-semibold text-slate-400 xl:hidden">门店</span>{order.storeName}</td>
                  <td className="hidden px-4 py-3.5 text-slate-600 xl:table-cell">{order.cashierNameSnapshot}</td>
                  <td className="hidden px-4 py-3.5 text-right text-slate-600 xl:table-cell">{order.items.reduce((sum, item) => sum + item.quantity, 0)} 件</td>
                  <td className="block px-4 pt-3 text-2xl font-black tabular-nums text-slate-900 xl:table-cell xl:px-4 xl:py-3.5 xl:text-right xl:text-sm xl:font-semibold"><span className="mr-2 text-xs font-semibold text-slate-400 xl:hidden">应付</span>¥{Number(centsToYuan(order.payableAmount)).toFixed(2)}</td>
                  <td className="inline-block px-4 pb-3 pt-2 xl:table-cell xl:px-4 xl:py-3.5">{order.paymentMethod ? <span className="rounded-full bg-budu-50 px-2.5 py-1 text-xs font-semibold text-budu-600">{paymentLabels[order.paymentMethod] || order.paymentMethod}</span> : <span className="text-xs text-slate-400">未支付</span>}</td>
                  <td className="inline-block px-0 pb-3 pt-2 xl:table-cell xl:px-4 xl:py-3.5"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${order.status === 'completed' ? 'bg-emerald-50 text-emerald-600' : order.status === 'cancelled' || order.status === 'refunded' ? 'bg-slate-100 text-slate-500' : 'bg-amber-50 text-amber-600'}`}>{statusLabels[order.status] || order.status}</span></td>
                  <td className="block border-t border-slate-100 p-3 text-right xl:table-cell xl:border-0 xl:px-5 xl:py-3.5">{renderOrderActions(order, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {refundOrder && (
        <div className="budu-overlay-viewport fixed inset-0 z-[95] grid place-items-center bg-slate-900/45 p-0 backdrop-blur-sm sm:p-4" role="dialog" aria-modal="true" aria-label="订单退款">
          <div className="budu-overlay-panel flex h-full min-h-0 w-full max-w-xl flex-col overflow-hidden bg-white shadow-2xl sm:my-6 sm:h-auto sm:max-h-[calc(100dvh-3rem)] sm:rounded-3xl">
            <div className="budu-overlay-header flex items-center border-b border-slate-100 bg-white px-4 py-4 sm:px-6">
              <div>
                <h3 className="text-lg font-bold text-slate-900">订单退款</h3>
                <p className="mt-0.5 font-mono text-xs text-slate-400">{refundOrder.orderNo}</p>
              </div>
              <button onClick={() => setRefundOrder(null)} className="ml-auto grid h-11 w-11 place-items-center rounded-xl text-slate-400 transition hover:bg-slate-100 active:scale-95" aria-label="关闭"><X className="h-5 w-5" /></button>
            </div>
            <div className="budu-overlay-scroll p-4 sm:p-6">
              <div className="grid grid-cols-3 gap-3 rounded-2xl bg-slate-50 p-4 text-center text-sm">
                <div><p className="text-xs text-slate-400">订单金额</p><p className="mt-1 font-bold tabular-nums text-slate-800">{formatCents(refundOrder.payableAmount)}</p></div>
                <div><p className="text-xs text-slate-400">已退款</p><p className="mt-1 font-bold tabular-nums text-rose-600">{formatCents(orderRefundedCents(refundOrder))}</p></div>
                <div><p className="text-xs text-slate-400">可退款</p><p className="mt-1 font-bold tabular-nums text-emerald-600">{formatCents(orderRemainingCents(refundOrder))}</p></div>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3">
                <button onClick={() => setRefundMode('full')} className={`rounded-xl border px-4 py-3 text-sm font-bold ${refundMode === 'full' ? 'border-budu-400 bg-budu-50 text-budu-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>整单退款</button>
                <button onClick={() => setRefundMode('partial')} className={`rounded-xl border px-4 py-3 text-sm font-bold ${refundMode === 'partial' ? 'border-budu-400 bg-budu-50 text-budu-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>部分退款</button>
              </div>

              {refundMode === 'full' ? (
                <div className="mt-5 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                  将退回剩余可退金额 <strong className="tabular-nums text-slate-900">{formatCents(orderRemainingCents(refundOrder))}</strong>
                </div>
              ) : (
                <div className="mt-5 overflow-x-auto rounded-2xl border border-slate-100">
                  <table className="w-full min-w-[520px] text-left text-sm">
                    <thead className="bg-slate-50/80 text-xs font-semibold text-slate-400">
                      <tr><th className="px-4 py-2.5">商品</th><th className="px-4 py-2.5 text-right">单价</th><th className="px-4 py-2.5 text-right">可退数量</th><th className="px-4 py-2.5 text-right">本次退款数量</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {refundOrder.items.filter((item) => !item.isGift).map((item) => {
                        const remaining = item.quantity - itemRefundedQty(refundOrder, item.id)
                        return (
                          <tr key={item.id}>
                            <td className="px-4 py-2.5 font-semibold text-slate-700">{item.productNameSnapshot}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{formatCents(item.unitPrice)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{remaining}</td>
                            <td className="px-4 py-2.5 text-right">
                              <input type="number" min="0" max={remaining} value={refundQty[item.id] || ''} onChange={(e) => setRefundQty((current) => ({ ...current, [item.id]: Math.min(remaining, Math.max(0, Number(e.target.value) || 0)) }))} className="h-9 w-20 rounded-lg border border-slate-200 px-2 text-right text-sm outline-none focus:border-budu-400" />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                    <tfoot className="border-t border-slate-100 bg-slate-50/60 text-sm font-bold text-slate-800">
                      <tr><td colSpan="3" className="px-4 py-2.5 text-right">本次退款（元）</td><td className="px-4 py-2.5 text-right tabular-nums">{formatCents(partialTotal)}</td></tr>
                    </tfoot>
                  </table>
                </div>
              )}

              <label className="mt-5 block text-xs font-semibold text-slate-500">退款原因（可填）<input value={refundReason} onChange={(e) => setRefundReason(e.target.value)} placeholder="例如：顾客退单 / 商品有误" className="mt-1 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-800 outline-none focus:border-budu-400 focus:ring-2 focus:ring-budu-100" /></label>

              {error && <div className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</div>}

              <div className="sticky bottom-0 -mx-4 mt-6 grid grid-cols-2 gap-3 border-t border-slate-100 bg-white/95 px-4 pb-[max(0px,env(safe-area-inset-bottom))] pt-4 backdrop-blur sm:-mx-6 sm:flex sm:justify-end sm:px-6">
                <button onClick={() => setRefundOrder(null)} disabled={refunding} className={`${actionButtonClass} border border-slate-200 text-slate-600`}>取消</button>
                <button onClick={submitRefund} disabled={refunding || (refundMode === 'partial' && partialTotal <= 0n)} className={`${actionButtonClass} bg-budu-500 text-white shadow-sm shadow-budu-100`}>{refunding ? '退款中…' : '确认退款'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {cancelOrder && (
        <div className="budu-overlay-viewport fixed inset-0 z-[110] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="作废订单确认">
          <div className="budu-overlay-scroll w-full max-w-md rounded-3xl bg-white shadow-2xl">
            <div className="p-5 sm:p-6">
              <div className="flex items-start gap-4">
                <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-rose-100"><Ban className="h-6 w-6 text-rose-600" /></div>
                <div className="min-w-0">
                  <h3 className="text-lg font-black text-slate-900">作废待支付订单</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-500">订单会保留审计记录，但不再等待付款，也不计入经营数据。</p>
                </div>
              </div>

              <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="font-mono text-xs font-bold text-slate-700">{cancelOrder.orderNo}</p>
                <div className="mt-2 flex items-end justify-between gap-3">
                  <div className="text-xs text-slate-500"><p>{cancelOrder.storeName}</p><p className="mt-1">{localTime(cancelOrder.createdAt)}</p></div>
                  <strong className="text-xl font-black tabular-nums text-slate-900">{formatCents(cancelOrder.payableAmount)}</strong>
                </div>
              </div>

              <fieldset className="mt-5">
                <legend className="text-xs font-bold text-slate-600">请选择作废原因</legend>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {cancelReasons.map((reason) => (
                    <button key={reason} type="button" onClick={() => setCancelReason(reason)} className={`min-h-11 rounded-xl border px-3 text-sm font-semibold transition ${cancelReason === reason ? 'border-rose-400 bg-rose-50 text-rose-700 ring-2 ring-rose-100' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>{reason}</button>
                  ))}
                </div>
              </fieldset>
              {cancelReason === '其他' && <label className="mt-3 block text-xs font-semibold text-slate-500">具体原因<input autoFocus value={cancelNote} onChange={(event) => setCancelNote(event.target.value.slice(0, 100))} maxLength={100} placeholder="请填写作废原因" className="mt-1 h-11 w-full rounded-xl border border-slate-200 px-3.5 text-sm text-slate-800 outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-100" /></label>}
              <p className="mt-4 rounded-xl bg-amber-50 px-3.5 py-3 text-xs leading-5 text-amber-700">若微信支付结果仍在核对中，系统会阻止作废，避免顾客已扣款但订单被误处理。</p>
            </div>
            <div className="grid grid-cols-2 gap-3 border-t border-slate-100 bg-slate-50/80 p-4 pb-[max(16px,env(safe-area-inset-bottom))] sm:px-6">
              <button onClick={closeCancelConfirm} disabled={cancelling} className={`${actionButtonClass} border border-slate-200 bg-white text-slate-600`}>返回</button>
              <button onClick={voidOrder} disabled={!cancelReason || (cancelReason === '其他' && cancelNote.trim().length < 2) || cancelling} className={`${actionButtonClass} bg-rose-600 text-white shadow-sm shadow-rose-200 hover:bg-rose-700`}><Ban className="h-4 w-4" />{cancelling ? '作废中…' : '确认作废'}</button>
            </div>
          </div>
        </div>
      )}

      {deleteOrder && (
        <div className="budu-overlay-viewport fixed inset-0 z-[110] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="删除订单确认">
          <div className="budu-overlay-scroll w-full max-w-md rounded-3xl bg-white shadow-2xl">
            <div className="p-5 sm:p-6">
              <div className="flex items-start gap-4">
                <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-rose-100"><AlertTriangle className="h-6 w-6 text-rose-600" /></div>
                <div className="min-w-0">
                  <h3 className="text-lg font-black text-slate-900">删除订单</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-500">此操作只对开发者开放，删除后无法恢复。</p>
                </div>
              </div>

              <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="font-mono text-xs font-bold text-slate-700">{deleteOrder.orderNo}</p>
                <div className="mt-2 flex items-end justify-between gap-3">
                  <div className="text-xs text-slate-500"><p>{deleteOrder.storeName}</p><p className="mt-1">{localTime(deleteOrder.createdAt)}</p></div>
                  <strong className="text-xl font-black tabular-nums text-slate-900">{formatCents(deleteOrder.payableAmount)}</strong>
                </div>
              </div>

              <label className="mt-5 flex min-h-12 cursor-pointer items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-3.5 text-sm font-semibold leading-5 text-rose-800">
                <input type="checkbox" checked={deleteConfirmed} onChange={(event) => setDeleteConfirmed(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-rose-600" />
                <span>我已确认订单号和金额，并了解删除后不可恢复</span>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3 border-t border-slate-100 bg-slate-50/80 p-4 pb-[max(16px,env(safe-area-inset-bottom))] sm:px-6">
              <button onClick={closeDeleteConfirm} disabled={deleting} className={`${actionButtonClass} border border-slate-200 bg-white text-slate-600`}>取消</button>
              <button onClick={removeOrder} disabled={!deleteConfirmed || deleting} className={`${actionButtonClass} bg-rose-600 text-white shadow-sm shadow-rose-200 hover:bg-rose-700`}><Trash2 className="h-4 w-4" />{deleting ? '删除中…' : '确认删除'}</button>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <div className="budu-overlay-viewport fixed inset-0 z-[90] grid place-items-center bg-slate-900/45 p-0 backdrop-blur-sm sm:p-4" role="dialog" aria-modal="true" aria-label="订单明细">
          <div className="budu-overlay-panel flex h-full min-h-0 w-full max-w-3xl flex-col overflow-hidden bg-white shadow-2xl sm:my-6 sm:h-auto sm:max-h-[calc(100dvh-3rem)] sm:rounded-3xl">
            <div className="budu-overlay-header flex items-center border-b border-slate-100 bg-white px-4 py-4 sm:px-6">
              <div>
                <h3 className="text-lg font-bold text-slate-900">订单明细</h3>
                <p className="mt-0.5 font-mono text-xs text-slate-400">{detail.orderNo}</p>
              </div>
              <button onClick={() => setDetail(null)} className="ml-auto grid h-11 w-11 place-items-center rounded-xl text-slate-400 transition hover:bg-slate-100 active:scale-95" aria-label="关闭"><X className="h-5 w-5" /></button>
            </div>
            <div className="budu-overlay-scroll grid gap-5 p-4 sm:p-6">
              <div className="grid grid-cols-2 gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-4 text-sm sm:grid-cols-4">
                <div><p className="text-xs text-slate-400">门店</p><p className="mt-1 font-semibold text-slate-700">{detail.storeName}</p></div>
                <div><p className="text-xs text-slate-400">收银员</p><p className="mt-1 font-semibold text-slate-700">{detail.cashierNameSnapshot}</p></div>
                <div><p className="text-xs text-slate-400">下单时间</p><p className="mt-1 font-semibold text-slate-700">{localTime(detail.createdAt)}</p></div>
                <div><p className="text-xs text-slate-400">状态</p><p className="mt-1 font-semibold text-slate-700">{statusLabels[detail.status] || detail.status}</p></div>
              </div>
              {BigInt(detail.discountAmount || 0) > 0n && <p className="text-xs text-slate-500">{(detail.discountPercent ?? 100) < 100 ? `折扣：${Number(detail.discountPercent) / 10} 折 · ` : ''}优惠（含赠送）{Number(centsToYuan(detail.discountAmount)).toFixed(2)} 元</p>}
              {detail.remark && <p className="text-xs text-slate-500">备注：{detail.remark}</p>}
              {detail.status === 'cancelled' && (
                <div className="rounded-2xl border border-rose-100 bg-rose-50/70 px-4 py-3 text-sm text-rose-800">
                  <p className="font-bold">订单已作废</p>
                  <p className="mt-1 text-xs leading-5">原因：{detail.cancelReason || '未记录'} · 操作人：{detail.cancelledBy || '—'} · 时间：{localTime(detail.cancelledAt)}</p>
                </div>
              )}
              <div>
                <h4 className="text-sm font-bold text-slate-800">商品明细</h4>
                <div className="mt-2 overflow-hidden rounded-2xl border border-slate-100">
                  <table className="block w-full text-left text-sm sm:table">
                    <thead className="hidden bg-slate-50/80 text-xs font-semibold text-slate-400 sm:table-header-group"><tr><th className="px-4 py-2.5">商品</th><th className="px-4 py-2.5">SKU</th><th className="px-4 py-2.5 text-right">单价（元）</th><th className="px-4 py-2.5 text-right">数量</th><th className="px-4 py-2.5 text-right">小计（元）</th></tr></thead>
                    <tbody className="block divide-y divide-slate-100 sm:table-row-group">
                      {(detail.items || []).map((item) => (
                        <tr key={item.id} className="grid grid-cols-[1fr_auto] gap-x-3 px-4 py-3 sm:table-row sm:p-0">
                          <td className="font-semibold text-slate-700 sm:table-cell sm:px-4 sm:py-2.5">{item.productNameSnapshot}{item.isGift && <span className="ml-1.5 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-500">赠送</span>}</td>
                          <td className="row-start-2 font-mono text-[11px] text-slate-400 sm:table-cell sm:px-4 sm:py-2.5 sm:text-xs sm:text-slate-500">{item.skuSnapshot}</td>
                          <td className="hidden text-right tabular-nums text-slate-600 sm:table-cell sm:px-4 sm:py-2.5">{item.isGift ? '0.00' : Number(centsToYuan(item.unitPrice)).toFixed(2)}</td>
                          <td className="row-start-2 text-right text-xs tabular-nums text-slate-500 sm:table-cell sm:px-4 sm:py-2.5 sm:text-sm">x {item.quantity}</td>
                          <td className="col-start-2 row-start-1 text-right font-bold tabular-nums text-slate-800 sm:table-cell sm:px-4 sm:py-2.5 sm:font-semibold">{item.isGift ? '¥0.00' : formatCents(item.lineAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="block border-t border-slate-100 bg-slate-50/60 text-sm font-bold text-slate-800 sm:table-footer-group"><tr className="flex items-center justify-between sm:table-row"><td colSpan="4" className="px-4 py-3 text-right">合计</td><td className="px-4 py-3 text-right text-lg tabular-nums text-budu-700 sm:text-sm">{formatCents(detail.payableAmount)}</td></tr></tfoot>
                  </table>
                </div>
              </div>
              {(detail.payments || []).length > 0 && (
                <div>
                  <h4 className="text-sm font-bold text-slate-800">支付记录</h4>
                  <div className="mt-2 space-y-2">
                    {(detail.payments || []).map((payment) => (
                      <div key={payment.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-slate-100 bg-slate-50 px-4 py-2.5 text-sm">
                        <span className="font-mono text-xs font-semibold text-slate-600">{payment.paymentNo}</span>
                        <span className="rounded-full bg-budu-50 px-2 py-0.5 text-xs font-semibold text-budu-600">{paymentLabels[payment.channel] || payment.channel}</span>
                        <span className="font-semibold tabular-nums text-slate-700">{Number(centsToYuan(payment.amount)).toFixed(2)} 元</span>
                        <span className={`text-xs ${payment.status === 'success' ? 'text-emerald-600' : 'text-slate-400'}`}>{payment.status === 'success' ? '支付成功' : payment.status}</span>
                        <span className="ml-auto text-xs text-slate-400">{localTime(payment.paidAt || payment.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {(detail.refunds || []).length > 0 && (
                <div>
                  <h4 className="text-sm font-bold text-slate-800">退款记录</h4>
                  <div className="mt-2 space-y-2">
                    {(detail.refunds || []).map((refund) => (
                      <div key={refund.id} className="rounded-xl border border-orange-100 bg-orange-50/60 px-4 py-2.5 text-sm">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                          <span className="font-mono text-xs font-semibold text-slate-600">{refund.refundNo}</span>
                          <span className="font-semibold tabular-nums text-orange-700">-{Number(centsToYuan(refund.amount)).toFixed(2)} 元</span>
                          <span className="text-xs text-slate-500">{refund.status === 'completed' ? '已退款' : refund.status === 'pending' ? '退款处理中' : refund.status === 'failed' ? '退款异常' : refund.status}</span>
                          <span className="ml-auto text-xs text-slate-400">{localTime(refund.completedAt || refund.createdAt)}</span>
                          {refund.status === 'pending' && <button onClick={() => queryRefund(refund)} className="rounded-lg border border-amber-200 bg-white px-2.5 py-1 text-xs font-semibold text-amber-700">查询退款结果</button>}
                        </div>
                        {refund.reason && <p className="mt-1 text-xs text-slate-500">原因：{refund.reason}</p>}
                        <p className="mt-1 text-xs text-slate-500">{(refund.items || []).map((item) => `${item.productName}×${item.quantity}`).join('、')}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="sticky bottom-0 -mx-4 space-y-2 border-t border-slate-100 bg-white/95 px-4 pb-[max(0px,env(safe-area-inset-bottom))] pt-4 backdrop-blur sm:-mx-6 sm:flex sm:flex-row-reverse sm:flex-wrap sm:items-center sm:gap-2 sm:space-y-0 sm:px-6">
                {renderOrderActions(detail, false, false)}
                <button onClick={() => setDetail(null)} className={`${actionButtonClass} w-full border border-slate-200 bg-white text-slate-600 sm:w-auto`}><X className="h-4 w-4" />完成</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
