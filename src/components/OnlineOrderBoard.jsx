import { useCallback, useEffect, useMemo, useState } from 'react'
import { X, Truck, PackageCheck, Search } from 'lucide-react'
import { api } from '../utils/api'
import { formatCents } from '../utils/pos'

/**
 * 订单工作台（BUDU-MP-CONSOLE-001 / P1）
 *
 * 列表 + 右侧详情抽屉 + 发货动作。
 * 状态由后端派生：TO_SHIP / SHIPPED / COMPLETED / REFUNDED / CANCELLED / PENDING。
 * 自提授权即已完成；邮寄发货满 7 天自动已完成（均为派生，不写库）。
 */

const PAGE_SIZE = 20

const STATE_STYLE = {
  TO_SHIP: 'bg-amber-50 text-amber-700 border-amber-200',
  SHIPPED: 'bg-budu-50 text-budu-700 border-budu-200',
  COMPLETED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  REFUNDED: 'bg-rose-50 text-rose-700 border-rose-200',
  CANCELLED: 'bg-slate-100 text-slate-500 border-slate-200',
  PENDING: 'bg-slate-100 text-slate-500 border-slate-200',
}

const FILTERS = [
  { key: '', label: '全部' },
  { key: 'TO_SHIP', label: '待发货' },
  { key: 'SHIPPED', label: '已发货' },
  { key: 'COMPLETED', label: '已完成' },
  { key: 'REFUNDED', label: '已退款' },
  { key: 'CANCELLED', label: '已取消' },
]

function fmtDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function StatePill({ state, label }) {
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] ${STATE_STYLE[state] || STATE_STYLE.PENDING}`}>{label}</span>
}

export default function OnlineOrderBoard({ initialState = '', title = '订单', showFilters = true }) {
  const [state, setState] = useState(initialState)
  const [keyword, setKeyword] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [fulfilling, setFulfilling] = useState(false)
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState({ method: 'DELIVERY', carrierCode: 'SF', trackingNo: '' })

  useEffect(() => { setState(initialState); setPage(1) }, [initialState])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams()
      if (state) params.set('state', state)
      if (query) params.set('q', query)
      if (page > 1) params.set('page', String(page))
      const res = await api(`/v2/online-catalog/orders?${params.toString()}`)
      setRows(res.orders || [])
      setTotal(res.total || 0)
    } catch (err) {
      setError(err.message || '加载订单失败')
    } finally {
      setLoading(false)
    }
  }, [state, query, page])

  useEffect(() => { load() }, [load])

  const openDetail = async (id) => {
    setDrawerOpen(true)
    setDetail(null)
    setDetailLoading(true)
    setNotice('')
    try {
      const res = await api(`/v2/online-catalog/orders/${id}`)
      setDetail(res.order)
    } catch (err) {
      setError(err.message || '加载订单详情失败')
      setDrawerOpen(false)
    } finally {
      setDetailLoading(false)
    }
  }

  const submitFulfill = async () => {
    if (!detail) return
    setFulfilling(true)
    setNotice('')
    try {
      const body = detail.state === 'TO_SHIP' && detail.payment
        ? { method: form.method, carrierCode: form.carrierCode, trackingNo: form.trackingNo }
        : { method: form.method }
      const res = await api(`/v2/online-catalog/orders/${detail.id}/fulfill`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const syncNote = res.shippingSync?.ok === false ? `；微信同步待重试（${res.shippingSync.error || '未知原因'}）` : ''
      setNotice(`已发货${syncNote}`)
      await load()
      const fresh = await api(`/v2/online-catalog/orders/${detail.id}`)
      setDetail(fresh.order)
    } catch (err) {
      setError(err.message || '发货失败')
    } finally {
      setFulfilling(false)
    }
  }

  const canFulfill = detail?.state === 'TO_SHIP'
  const empty = useMemo(() => !loading && !rows.length, [loading, rows.length])

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {showFilters ? (
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((item) => (
              <button
                key={item.key || 'all'}
                type="button"
                onClick={() => { setState(item.key); setPage(1) }}
                className={`h-7 rounded-full border px-3 text-xs ${state === item.key ? 'border-budu-200 bg-budu-50 font-medium text-budu-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <label className="flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5">
            <Search size={14} className="text-slate-400" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { setQuery(keyword.trim()); setPage(1) } }}
              placeholder="订单号 / 顾客 ID"
              className="w-40 border-0 bg-transparent text-xs outline-none"
            />
          </label>
          <button type="button" onClick={() => { setQuery(keyword.trim()); setPage(1) }} className="h-8 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-slate-50">搜索</button>
          <button type="button" onClick={load} className="h-8 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-slate-50">刷新</button>
        </div>
      </div>

      {error ? <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">{error}</div> : null}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[880px]">
          <thead>
            <tr className="border-b border-slate-100 bg-[#FEFDFC] text-left text-[11px] text-slate-500">
              <th className="w-[210px] px-4 py-2.5 font-medium">订单号</th>
              <th className="px-3 py-2.5 font-medium">顾客</th>
              <th className="px-3 py-2.5 font-medium">商品</th>
              <th className="w-[110px] px-3 py-2.5 font-medium">金额</th>
              <th className="px-3 py-2.5 font-medium">状态</th>
              <th className="px-3 py-2.5 font-medium">时间</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7}><div className="px-4 py-14 text-center text-xs text-slate-400">加载中…</div></td></tr>
            ) : empty ? (
              <tr><td colSpan={7}><div className="px-4 py-14 text-center text-xs text-slate-400">没有符合条件的订单</div></td></tr>
            ) : rows.map((row) => (
              <tr key={row.id} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-[#FEFCFB]" onClick={() => openDetail(row.id)}>
                <td className="px-4 py-3">
                  <div className="max-w-[190px] truncate font-mono text-[12px] text-slate-700" title={row.orderNo}>{row.orderNo}</div>
                  <div className="mt-0.5 text-[11px] text-slate-400">{row.payment}</div>
                </td>
                <td className="px-3 py-3 text-xs text-slate-600">{row.customer.name}</td>
                <td className="px-3 py-3">
                  <div className="max-w-[280px] truncate text-xs text-slate-600">{row.lines.map((line) => `${line.name}×${line.quantity}`).join('，')}</div>
                  <div className="mt-0.5 text-[11px] text-slate-400">共 {row.lineCount} 件</div>
                </td>
                <td className="px-3 py-3 text-sm font-medium text-slate-700">{formatCents(row.totalCents)}</td>
                <td className="px-3 py-3"><StatePill state={row.state} label={row.stateLabel} /></td>
                <td className="px-3 py-3 text-[11px] text-slate-400">{fmtDate(row.createdAt)}</td>
                <td className="px-4 py-3 text-right">
                  <span className="text-xs text-budu-600">{row.state === 'TO_SHIP' ? '发货 / 详情' : '详情'}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-[11px] text-slate-400">
          <span>共 {total} 笔</span>
          {(() => {
            const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
            return (
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 disabled:cursor-not-allowed disabled:opacity-40 hover:bg-slate-50"
                >上一页</button>
                <span>第 {Math.min(page, pages)} / {pages} 页</span>
                <button
                  type="button"
                  disabled={page >= pages || loading}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 disabled:cursor-not-allowed disabled:opacity-40 hover:bg-slate-50"
                >下一页</button>
              </span>
            )
          })()}
        </div>
      </div>

      {drawerOpen ? (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-slate-900/30" onClick={() => setDrawerOpen(false)} />
          <div className="relative flex h-full w-[720px] max-w-[94vw] flex-col bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-6 py-4">
              <div>
                <div className="max-w-[520px] truncate text-base font-semibold text-slate-800" title={detail?.orderNo}>{detail?.orderNo || '订单'}</div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                  {detail ? <StatePill state={detail.state} label={detail.stateLabel} /> : null}
                  <span>{detail?.customer?.name || ''}</span>
                </div>
              </div>
              <button type="button" onClick={() => setDrawerOpen(false)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"><X size={18} /></button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              {detailLoading ? <div className="py-16 text-center text-xs text-slate-400">加载中…</div> : null}
              {detail ? (
                <>
                  <section className="mb-5">
                    <h3 className="mb-2 text-[11px] font-medium text-slate-400">商品明细</h3>
                    <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                      {detail.lines.map((line, index) => (
                        <div key={`${line.skuId}-${index}`} className="flex items-center justify-between px-3 py-2 text-xs">
                          <div>
                            <div className="text-slate-700">{line.name}</div>
                            <div className="mt-0.5 text-[11px] text-slate-400">
                              {line.spec || '—'}{line.comboFlavors ? ` · 口味 ${line.comboFlavors.join(' / ')}` : ''}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-slate-700">{formatCents(line.amountCents)}</div>
                            <div className="text-[11px] text-slate-400">×{line.quantity}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="mb-5 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-slate-200 p-3 text-xs">
                      <div className="mb-1 text-[11px] text-slate-400">金额</div>
                      <div className="flex justify-between py-0.5"><span className="text-slate-500">商品</span><span>{formatCents(detail.merchandiseCents)}</span></div>
                      <div className="flex justify-between py-0.5"><span className="text-slate-500">配送</span><span>{formatCents(detail.shippingCents)}</span></div>
                      <div className="mt-1 flex justify-between border-t border-dashed border-slate-200 pt-1 font-medium"><span>实付</span><span>{formatCents(detail.totalCents)}</span></div>
                    </div>
                    <div className="rounded-xl border border-slate-200 p-3 text-xs">
                      <div className="mb-1 text-[11px] text-slate-400">支付</div>
                      {detail.tenders.length ? detail.tenders.map((tender, index) => (
                        <div key={index} className="flex justify-between py-0.5"><span className="text-slate-500">{tender.label}</span><span>{formatCents(tender.amountCents)}</span></div>
                      )) : <div className="text-slate-400">—</div>}
                      <div className="mt-1 border-t border-dashed border-slate-200 pt-1 text-[11px] text-slate-400">下单 {fmtDate(detail.createdAt)}</div>
                    </div>
                  </section>

                  <section className="mb-5">
                    <h3 className="mb-2 text-[11px] font-medium text-slate-400">履约</h3>
                    <div className="rounded-xl border border-slate-200 p-3 text-xs">
                      {detail.fulfillment ? (
                        <div className="flex items-center gap-2 text-slate-600">
                          <PackageCheck size={15} className="text-emerald-500" />
                          {detail.fulfillment.method === 'PICKUP'
                            ? `顾客已取货 · ${fmtDate(detail.fulfillment.shippedAt)}`
                            : `已发货 · ${detail.fulfillment.carrierCode || ''} ${detail.fulfillment.trackingNo || ''} · ${fmtDate(detail.fulfillment.shippedAt)}`}
                        </div>
                      ) : detail.state === 'TO_SHIP' ? (
                        <div className="space-y-2">
                          <div className="flex gap-1.5">
                            {[{ key: 'DELIVERY', label: '快递' }, { key: 'PICKUP', label: '自提' }].map((item) => (
                              <button
                                key={item.key}
                                type="button"
                                onClick={() => setForm((f) => ({ ...f, method: item.key }))}
                                className={`h-7 rounded-full border px-3 text-[11px] ${form.method === item.key ? 'border-budu-200 bg-budu-50 text-budu-700' : 'border-slate-200 bg-white text-slate-500'}`}
                              >{item.label}</button>
                            ))}
                          </div>
                          {form.method === 'DELIVERY' ? (
                            <div className="flex gap-2">
                              <input value={form.carrierCode} onChange={(e) => setForm((f) => ({ ...f, carrierCode: e.target.value }))} placeholder="物流公司代码（SF）" className="h-8 w-32 rounded-lg border border-slate-200 px-2 text-xs outline-none focus:border-budu-300" />
                              <input value={form.trackingNo} onChange={(e) => setForm((f) => ({ ...f, trackingNo: e.target.value }))} placeholder="运单号" className="h-8 flex-1 rounded-lg border border-slate-200 px-2 text-xs outline-none focus:border-budu-300" />
                              <button type="button" disabled={fulfilling || !form.trackingNo.trim()} onClick={submitFulfill} className="inline-flex h-8 items-center gap-1 rounded-lg bg-budu-500 px-3 text-xs font-medium text-white disabled:opacity-50">
                                <Truck size={13} />{fulfilling ? '提交中…' : '确认发货'}
                              </button>
                            </div>
                          ) : (
                            <button type="button" disabled={fulfilling} onClick={submitFulfill} className="inline-flex h-8 items-center gap-1 rounded-lg bg-budu-500 px-3 text-xs font-medium text-white disabled:opacity-50">
                              <PackageCheck size={13} />{fulfilling ? '提交中…' : '确认取货'}
                            </button>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-400">该订单当前不可发货</span>
                      )}
                      {notice ? <div className="mt-2 rounded-lg bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700">{notice}</div> : null}
                    </div>
                  </section>

                  <section>
                    <h3 className="mb-2 text-[11px] font-medium text-slate-400">时间线</h3>
                    <ol className="space-y-2">
                      {detail.timeline.map((event, index) => (
                        <li key={index} className="flex gap-2 text-xs">
                          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-budu-400" />
                          <div>
                            <div className="text-slate-600">{event.label}</div>
                            <div className="text-[11px] text-slate-400">{fmtDate(event.at)}</div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                </>
              ) : null}
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-100 px-6 py-3">
              <button type="button" onClick={() => setDrawerOpen(false)} className="h-9 rounded-xl border border-slate-200 px-4 text-sm text-slate-600">关闭</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
