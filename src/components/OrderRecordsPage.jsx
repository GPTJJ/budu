import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Download, FileSpreadsheet, Package, ReceiptText, Search, Trash2, X } from 'lucide-react'
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
  cancelled: '已取消',
  partially_refunded: '部分退款',
  refunded: '已退款',
}

function localTime(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function monthStart() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

export default function OrderRecordsPage({ user, onBack }) {
  const stores = useMemo(() => {
    const list = allStores()
    if (user.role === 'developer') return list
    const allowed = new Set(user.storeKeys || [])
    return list.filter((store) => allowed.has(store.key))
  }, [user])
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [store, setStore] = useState('all')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState(null)
  const [refundOrder, setRefundOrder] = useState(null)
  const [refundMode, setRefundMode] = useState('full')
  const [refundQty, setRefundQty] = useState({})
  const [refundReason, setRefundReason] = useState('')
  const [refunding, setRefunding] = useState(false)

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
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  const removeOrder = async (order) => {
    if (!window.confirm(`确认删除订单 ${order.orderNo}？删除后不可恢复。`)) return
    setError('')
    try {
      await api(`/v2/pos/orders/${order.id}`, { method: 'DELETE' })
      setRows((current) => current.filter((row) => row.id !== order.id))
      setTotal((current) => Math.max(0, current - 1))
      if (detail?.id === order.id) setDetail(null)
    } catch (e) {
      setError(e.message)
    }
  }

  const orderRefundedCents = (order) => (order.refunds || [])
    .filter((refund) => refund.status === 'completed')
    .reduce((sum, refund) => sum + BigInt(refund.amount), 0n)
  const orderRemainingCents = (order) => BigInt(order.payableAmount) - orderRefundedCents(order)
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
    ? refundOrder.items.reduce((sum, item) => sum + BigInt(item.unitPrice) * BigInt(Number(refundQty[item.id] || 0)), 0n)
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
      await api(`/v2/pos/orders/${refundOrder.id}/refunds`, {
        method: 'POST',
        body: JSON.stringify({ items, reason: refundReason, requestKey: key }),
      })
      setRefundOrder(null)
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setRefunding(false)
    }
  }

  const inputClass = 'h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-budu-400 focus:ring-2 focus:ring-budu-100'

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={onBack} className="grid h-10 w-10 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 hover:text-budu-600" aria-label="返回">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h2 className="text-xl font-bold text-slate-900">订单记录</h2>
          <p className="mt-0.5 text-xs text-slate-400">按日期/门店/支付方式/状态查询 POS 订单与收款记录</p>
        </div>
        <button onClick={exportExcel} className="ml-auto flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50">
          <FileSpreadsheet className="h-4 w-4" />导出 Excel
        </button>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</div>}

      <section className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <label className="text-xs font-semibold text-slate-500">开始日期<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`mt-1 w-full ${inputClass}`} /></label>
          <label className="text-xs font-semibold text-slate-500">结束日期<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`mt-1 w-full ${inputClass}`} /></label>
          <label className="text-xs font-semibold text-slate-500">门店<select value={store} onChange={(e) => setStore(e.target.value)} className={`mt-1 w-full ${inputClass}`}><option value="all">全部门店</option>{stores.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</select></label>
          <label className="text-xs font-semibold text-slate-500">支付方式<select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} className={`mt-1 w-full ${inputClass}`}><option value="">全部</option><option value="cash">现金</option><option value="wechat">微信</option><option value="alipay">支付宝</option></select></label>
          <label className="text-xs font-semibold text-slate-500">状态<select value={status} onChange={(e) => setStatus(e.target.value)} className={`mt-1 w-full ${inputClass}`}><option value="">全部</option>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <div className="flex items-end gap-2">
            <label className="relative flex-1 text-xs font-semibold text-slate-500">订单号<Search className="pointer-events-none absolute bottom-3 left-3 h-4 w-4 text-slate-400" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索订单号" className={`mt-1 w-full pl-9 ${inputClass}`} /></label>
            <button onClick={load} disabled={loading} className="h-10 shrink-0 rounded-xl bg-budu-500 px-5 text-sm font-semibold text-white disabled:opacity-50">{loading ? '查询中…' : '查询'}</button>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <p className="text-sm font-semibold text-slate-600">共 {total} 笔订单</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-slate-100 bg-slate-50/80 text-xs font-semibold text-slate-400">
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
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan="9" className="px-5 py-14 text-center text-slate-400">正在加载订单…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan="9" className="px-5 py-14 text-center text-slate-400"><ReceiptText className="mx-auto mb-2 h-8 w-8 text-slate-300" />暂无符合条件的订单</td></tr>
              ) : rows.map((order) => (
                <tr key={order.id} className="hover:bg-slate-50/70">
                  <td className="px-5 py-3.5 font-mono text-xs font-semibold text-slate-700">{order.orderNo}</td>
                  <td className="px-4 py-3.5 text-slate-500">{localTime(order.createdAt)}</td>
                  <td className="px-4 py-3.5 text-slate-700">{order.storeName}</td>
                  <td className="px-4 py-3.5 text-slate-600">{order.cashierNameSnapshot}</td>
                  <td className="px-4 py-3.5 text-right text-slate-600">{order.items.reduce((sum, item) => sum + item.quantity, 0)} 件</td>
                  <td className="px-4 py-3.5 text-right font-semibold tabular-nums text-slate-800">{Number(centsToYuan(order.payableAmount)).toFixed(2)}</td>
                  <td className="px-4 py-3.5">{order.paymentMethod ? <span className="rounded-full bg-budu-50 px-2.5 py-1 text-xs font-semibold text-budu-600">{paymentLabels[order.paymentMethod] || order.paymentMethod}</span> : <span className="text-xs text-slate-400">—</span>}</td>
                  <td className="px-4 py-3.5"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${order.status === 'completed' ? 'bg-emerald-50 text-emerald-600' : order.status === 'cancelled' || order.status === 'refunded' ? 'bg-slate-100 text-slate-500' : 'bg-amber-50 text-amber-600'}`}>{statusLabels[order.status] || order.status}</span></td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {user.role === 'developer' && (
                        <button onClick={() => removeOrder(order)} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-50" aria-label={`删除 ${order.orderNo}`}><Trash2 className="h-3.5 w-3.5" />删除</button>
                      )}
                      {(user.role === 'developer' || user.role === 'manager') && orderRemainingCents(order) > 0n && (
                        <button onClick={() => openRefund(order)} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-orange-600 hover:bg-orange-50" aria-label={`退款 ${order.orderNo}`}><Download className="h-3.5 w-3.5" />退款</button>
                      )}
                      <button onClick={() => setDetail(order)} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-budu-600 hover:bg-budu-50"><Package className="h-3.5 w-3.5" />明细</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {refundOrder && (
        <div className="fixed inset-0 z-[95] grid place-items-center overflow-y-auto bg-slate-900/45 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="订单退款">
          <div className="my-6 w-full max-w-xl rounded-3xl bg-white shadow-2xl">
            <div className="flex items-center border-b border-slate-100 px-6 py-4">
              <div>
                <h3 className="text-lg font-bold text-slate-900">订单退款</h3>
                <p className="mt-0.5 font-mono text-xs text-slate-400">{refundOrder.orderNo}</p>
              </div>
              <button onClick={() => setRefundOrder(null)} className="ml-auto grid h-9 w-9 place-items-center rounded-xl text-slate-400 hover:bg-slate-100" aria-label="关闭"><X className="h-5 w-5" /></button>
            </div>
            <div className="p-6">
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
                <div className="mt-5 overflow-hidden rounded-2xl border border-slate-100">
                  <table className="w-full text-left text-sm">
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

              <div className="mt-6 flex justify-end gap-3 border-t border-slate-100 pt-4">
                <button onClick={() => setRefundOrder(null)} disabled={refunding} className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-500">取消</button>
                <button onClick={submitRefund} disabled={refunding || (refundMode === 'partial' && partialTotal <= 0n)} className="rounded-xl bg-budu-500 px-6 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{refunding ? '退款中…' : '确认退款'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <div className="fixed inset-0 z-[90] grid place-items-center overflow-y-auto bg-slate-900/45 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="订单明细">
          <div className="my-6 w-full max-w-2xl rounded-3xl bg-white shadow-2xl">
            <div className="flex items-center border-b border-slate-100 px-6 py-4">
              <div>
                <h3 className="text-lg font-bold text-slate-900">订单明细</h3>
                <p className="mt-0.5 font-mono text-xs text-slate-400">{detail.orderNo}</p>
              </div>
              <button onClick={() => setDetail(null)} className="ml-auto grid h-9 w-9 place-items-center rounded-xl text-slate-400 hover:bg-slate-100" aria-label="关闭"><X className="h-5 w-5" /></button>
            </div>
            <div className="grid gap-5 p-6">
              <div className="grid grid-cols-2 gap-3 rounded-2xl bg-slate-50 p-4 text-sm md:grid-cols-4">
                <div><p className="text-xs text-slate-400">门店</p><p className="mt-1 font-semibold text-slate-700">{detail.storeName}</p></div>
                <div><p className="text-xs text-slate-400">收银员</p><p className="mt-1 font-semibold text-slate-700">{detail.cashierNameSnapshot}</p></div>
                <div><p className="text-xs text-slate-400">下单时间</p><p className="mt-1 font-semibold text-slate-700">{localTime(detail.createdAt)}</p></div>
                <div><p className="text-xs text-slate-400">状态</p><p className="mt-1 font-semibold text-slate-700">{statusLabels[detail.status] || detail.status}</p></div>
              </div>
              {(detail.discountPercent ?? 100) < 100 && <p className="text-xs text-slate-500">折扣：{Number(detail.discountPercent) / 10} 折 · 优惠 {Number(centsToYuan(detail.discountAmount)).toFixed(2)} 元</p>}
              {detail.remark && <p className="text-xs text-slate-500">备注：{detail.remark}</p>}
              <div>
                <h4 className="text-sm font-bold text-slate-800">商品明细</h4>
                <div className="mt-2 overflow-hidden rounded-2xl border border-slate-100">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50/80 text-xs font-semibold text-slate-400"><tr><th className="px-4 py-2.5">商品</th><th className="px-4 py-2.5">SKU</th><th className="px-4 py-2.5 text-right">单价（元）</th><th className="px-4 py-2.5 text-right">数量</th><th className="px-4 py-2.5 text-right">小计（元）</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {(detail.items || []).map((item) => (
                        <tr key={item.id}>
                          <td className="px-4 py-2.5 font-semibold text-slate-700">{item.productNameSnapshot}{item.isGift && <span className="ml-1.5 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-500">赠送</span>}</td>
                          <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{item.skuSnapshot}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{item.isGift ? '0.00' : Number(centsToYuan(item.unitPrice)).toFixed(2)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{item.quantity}</td>
                          <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-800">{item.isGift ? '0.00' : Number(centsToYuan(item.lineAmount)).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t border-slate-100 bg-slate-50/60 text-sm font-bold text-slate-800"><tr><td colSpan="4" className="px-4 py-2.5 text-right">合计（元）</td><td className="px-4 py-2.5 text-right tabular-nums">{Number(centsToYuan(detail.payableAmount)).toFixed(2)}</td></tr></tfoot>
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
                          <span className="text-xs text-slate-500">{refund.status === 'completed' ? '已退款' : refund.status}</span>
                          <span className="ml-auto text-xs text-slate-400">{localTime(refund.completedAt || refund.createdAt)}</span>
                        </div>
                        {refund.reason && <p className="mt-1 text-xs text-slate-500">原因：{refund.reason}</p>}
                        <p className="mt-1 text-xs text-slate-500">{(refund.items || []).map((item) => `${item.productName}×${item.quantity}`).join('、')}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-3 border-t border-slate-100 pt-4">
                <button onClick={() => setDetail(null)} className="flex items-center gap-2 rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-500"><Download className="h-4 w-4" />完成</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
