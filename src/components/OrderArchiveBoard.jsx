import { useCallback, useEffect, useState } from 'react'
import { X, Search, ChevronLeft, ChevronRight, Archive } from 'lucide-react'
import { api } from '../utils/api'
import { formatCents } from '../utils/pos'

/**
 * 历史订单（小程序）
 *
 * 只读归档：数据来自 CloudBase `orders`（小程序 1.0.x 下单落库），
 * 与 OS 的结算单是两套系统。这里只做检索核对，不参与发货与财务结算。
 */

const PAGE_SIZE = 20

// 同一会话内 60 秒只自动同步一次：切来切去不必反复拉云端
let lastAutoSyncAt = 0

const STATE_STYLE = {
  PENDING_PAYMENT: 'bg-slate-100 text-slate-500 border-slate-200',
  PENDING_SHIPMENT: 'bg-amber-50 text-amber-700 border-amber-200',
  PAID: 'bg-amber-50 text-amber-700 border-amber-200',
  SHIPPED: 'bg-budu-50 text-budu-700 border-budu-200',
  PENDING_REVIEW: 'bg-sky-50 text-sky-700 border-sky-200',
  COMPLETED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  REFUNDED: 'bg-rose-50 text-rose-700 border-rose-200',
  CANCELLED: 'bg-slate-100 text-slate-500 border-slate-200',
}

const FILTERS = [
  { key: '', label: '全部' },
  { key: 'PENDING_PAYMENT', label: '待付款' },
  { key: 'PENDING_SHIPMENT', label: '待发货' },
  { key: 'SHIPPED', label: '已发货' },
  { key: 'PENDING_REVIEW', label: '待评价' },
  { key: 'COMPLETED', label: '已完成' },
  { key: 'REFUNDED', label: '已退款' },
  { key: 'CANCELLED', label: '已取消' },
]

function fmtDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function StatePill({ state, label }) {
  return <span className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${STATE_STYLE[state] || STATE_STYLE.PENDING_PAYMENT}`}>{label}</span>
}

function maskPhone(phone) {
  const value = String(phone || '')
  if (value.length < 7) return value || '—'
  return `${value.slice(0, 3)}****${value.slice(-4)}`
}

export default function OrderArchiveBoard() {
  const [state, setState] = useState('')
  const [keyword, setKeyword] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState({ all: 0, paidOrders: 0, paidCents: '0', netOrders: 0, netCents: '0' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncedAt, setSyncedAt] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams()
      if (state) params.set('state', state)
      if (query) params.set('q', query)
      params.set('page', String(page))
      const res = await api(`/v2/online-catalog/order-archive?${params.toString()}`)
      setRows(res.orders || [])
      setTotal(res.total || 0)
      setStats(res.stats || { all: 0, paidOrders: 0, paidCents: '0', netOrders: 0, netCents: '0' })
    } catch (err) {
      setError(err.message || '加载历史订单失败')
    } finally {
      setLoading(false)
    }
  }, [state, query, page])

  useEffect(() => { load() }, [load])

  /** 打开页面先拉一次云端最新（静默，失败就用上次同步的数据） */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (Date.now() - lastAutoSyncAt > 60000) {
        lastAutoSyncAt = Date.now()
        try {
          await api('/v2/online-catalog/order-archive/sync', { method: 'POST' })
        } catch {
          /* 静默失败：后台 cron 每天也会兜底同步 */
        }
      }
      if (!cancelled) load()
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const syncNow = async () => {
    setSyncing(true)
    setError('')
    try {
      const res = await api('/v2/online-catalog/order-archive/sync', { method: 'POST' })
      await load()
      setSyncedAt(res.syncedAt || new Date().toISOString())
    } catch (err) {
      setError(err.message || '同步失败')
    } finally {
      setSyncing(false)
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const empty = !loading && rows.length === 0

  return (
    <div>
      <div className="mb-3 grid grid-cols-3 gap-2.5 lg:gap-3">
        {[
          { label: '历史订单', value: stats.all, hint: '上线以来全部' },
          { label: '已支付', value: stats.paidOrders, hint: '含已退款订单' },
          { label: '有效成交', value: formatCents(stats.netCents), hint: '已退款订单不计入' },
        ].map((item) => (
          <div key={item.label} className="rounded-2xl border border-slate-200 bg-white p-3 lg:p-4">
            <div className="text-[11px] text-slate-500">{item.label}</div>
            <div className="mt-1 truncate text-lg font-semibold tracking-tight text-slate-800 lg:text-2xl">{item.value}</div>
            <div className="mt-0.5 hidden text-[11px] text-slate-400 lg:block">{item.hint}</div>
          </div>
        ))}
      </div>

      <div className="mb-3 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 text-[11px] text-slate-500">
        <Archive size={13} className="shrink-0 text-slate-400" />
        <span>只读归档：来自小程序历史下单记录，用于查询核对，不影响结算、发货与退款。{syncedAt ? ` 本次同步 ${new Date(syncedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
      </div>

      <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-wrap lg:pb-0">
          {FILTERS.map((item) => (
            <button
              key={item.key || 'all'}
              type="button"
              onClick={() => { setState(item.key); setPage(1) }}
              className={`h-8 shrink-0 rounded-full border px-3 text-xs ${state === item.key ? 'border-budu-200 bg-budu-50 font-medium text-budu-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 lg:ml-auto">
          <label className="flex h-9 flex-1 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 lg:h-8 lg:flex-none">
            <Search size={14} className="text-slate-400" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { setQuery(keyword.trim()); setPage(1) } }}
              placeholder="订单号 / 顾客 / 手机号"
              className="w-full border-0 bg-transparent text-xs outline-none lg:w-44"
            />
          </label>
          <button type="button" onClick={() => { setQuery(keyword.trim()); setPage(1) }} className="h-9 shrink-0 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-slate-50 lg:h-8">搜索</button>
          <button type="button" onClick={syncNow} disabled={syncing} className="h-9 shrink-0 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50 lg:h-8">
            {syncing ? '同步中…' : '同步最新'}
          </button>
        </div>
      </div>

      {error ? <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div> : null}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[860px]">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/60 text-left text-[11px] text-slate-500">
                <th className="px-4 py-2.5 font-medium">订单号</th>
                <th className="px-2 py-2.5 font-medium">状态</th>
                <th className="px-2 py-2.5 font-medium">顾客</th>
                <th className="px-2 py-2.5 font-medium">商品</th>
                <th className="px-2 py-2.5 text-right font-medium">实付</th>
                <th className="px-2 py-2.5 font-medium">下单时间</th>
                <th className="px-4 py-2.5 font-medium">方式</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-14 text-center text-xs text-slate-400">加载中…</td></tr>
              ) : empty ? (
                <tr><td colSpan={7} className="px-4 py-14 text-center text-xs text-slate-400">没有符合条件的历史订单</td></tr>
              ) : rows.map((row) => (
                <tr key={row.id} onClick={() => setDetail(row)} className="cursor-pointer border-b border-slate-50 text-xs hover:bg-slate-50/70">
                  <td className="px-4 py-2.5 font-mono text-[11px] text-slate-700">{row.payNo || row.orderNo || row.id.slice(-8)}</td>
                  <td className="px-2 py-2.5"><StatePill state={row.state} label={row.stateLabel} /></td>
                  <td className="px-2 py-2.5 text-slate-600">{row.customer.name || '—'}<span className="ml-1 text-[11px] text-slate-400">{maskPhone(row.customer.phone)}</span></td>
                  <td className="max-w-[240px] truncate px-2 py-2.5 text-slate-500">{row.lines.map((line) => `${line.name}×${line.quantity}`).join('，') || '—'}</td>
                  <td className="px-2 py-2.5 text-right font-medium text-slate-800">{formatCents(row.paidCents || row.totalCents)}</td>
                  <td className="px-2 py-2.5 text-slate-500">{fmtDate(row.createdAt)}</td>
                  <td className="px-4 py-2.5 text-slate-500">{row.deliveryLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="divide-y divide-slate-100 md:hidden">
          {loading ? (
            <div className="px-4 py-14 text-center text-xs text-slate-400">加载中…</div>
          ) : empty ? (
            <div className="px-4 py-14 text-center text-xs text-slate-400">没有符合条件的历史订单</div>
          ) : rows.map((row) => (
            <button key={row.id} type="button" onClick={() => setDetail(row)} className="block w-full px-4 py-3 text-left active:bg-slate-50">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-700">{row.payNo || row.orderNo || row.id.slice(-8)}</span>
                <StatePill state={row.state} label={row.stateLabel} />
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs text-slate-600">{row.customer.name || '—'} · {fmtDate(row.createdAt)}</span>
                <span className="shrink-0 text-sm font-medium text-slate-800">{formatCents(row.paidCents || row.totalCents)}</span>
              </div>
              <div className="mt-1 truncate text-[11px] text-slate-400">
                {row.lines.map((line) => `${line.name}×${line.quantity}`).join('，')} · 共 {row.lineCount} 件 · {row.deliveryLabel}
              </div>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-2.5 text-[11px] text-slate-400">
          <span>共 {total} 笔 · 第 {page} / {pages} 页</span>
          <div className="flex items-center gap-1.5">
            <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))} className="inline-flex h-7 items-center gap-0.5 rounded-lg border border-slate-200 px-2 text-slate-600 disabled:opacity-40">
              <ChevronLeft size={13} />上一页
            </button>
            <button type="button" disabled={page >= pages || loading} onClick={() => setPage((p) => Math.min(pages, p + 1))} className="inline-flex h-7 items-center gap-0.5 rounded-lg border border-slate-200 px-2 text-slate-600 disabled:opacity-40">
              下一页<ChevronRight size={13} />
            </button>
          </div>
        </div>
      </div>

      {detail ? (
        <div className="fixed inset-0 z-50 flex justify-end">
          <button type="button" aria-label="关闭" onClick={() => setDetail(null)} className="absolute inset-0 bg-slate-900/30" />
          <div className="relative flex h-full w-full flex-col bg-white shadow-2xl sm:w-[560px] sm:max-w-[94vw]">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-800">{detail.payNo || detail.orderNo}</div>
                <div className="mt-0.5 text-[11px] text-slate-400">{fmtDate(detail.createdAt)} · {detail.deliveryLabel}</div>
              </div>
              <button type="button" onClick={() => setDetail(null)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100"><X size={16} /></button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4">
              <div className="mb-4 flex items-center gap-2">
                <StatePill state={detail.state} label={detail.stateLabel} />
                <span className="text-[11px] text-slate-400">只读归档</span>
              </div>

              <div className="mb-4 rounded-xl border border-slate-200 p-3">
                <div className="mb-2 text-[11px] text-slate-400">商品明细</div>
                {detail.lines.length ? detail.lines.map((line, index) => (
                  <div key={`${line.id}-${index}`} className="flex items-start justify-between gap-3 py-1 text-xs">
                    <div className="min-w-0">
                      <div className="truncate text-slate-700">{line.name}</div>
                      <div className="text-[11px] text-slate-400">{line.spec || '—'} × {line.quantity}</div>
                    </div>
                    <div className="shrink-0 text-slate-700">{formatCents(line.amountCents)}</div>
                  </div>
                )) : <div className="text-xs text-slate-400">无明细</div>}
                <div className="mt-2 space-y-1 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
                  <div className="flex justify-between"><span>商品金额</span><span>{formatCents(detail.goodsCents)}</span></div>
                  <div className="flex justify-between"><span>运费</span><span>{formatCents(detail.shippingCents)}</span></div>
                  <div className="flex justify-between font-medium text-slate-700"><span>实付</span><span>{formatCents(detail.paidCents || detail.totalCents)}</span></div>
                  {Number(detail.refundCents) > 0 ? <div className="flex justify-between text-rose-600"><span>已退款</span><span>{formatCents(detail.refundCents)}</span></div> : null}
                </div>
              </div>

              <div className="mb-4 rounded-xl border border-slate-200 p-3 text-xs">
                <div className="mb-2 text-[11px] text-slate-400">收货信息</div>
                <div className="text-slate-700">{detail.customer.name || '—'} · {detail.customer.phone || '—'}</div>
                <div className="mt-1 text-[11px] leading-relaxed text-slate-500">{detail.customer.address || '—'}</div>
                {detail.storeName ? <div className="mt-1 text-[11px] text-slate-500">门店：{detail.storeName}</div> : null}
                {detail.trackingNo ? <div className="mt-1 text-[11px] text-slate-500">物流：{detail.carrier || '—'} {detail.trackingNo}</div> : null}
              </div>

              <div className="rounded-xl border border-slate-200 p-3 text-xs">
                <div className="mb-2 text-[11px] text-slate-400">时间线</div>
                {[
                  ['下单', detail.createdAt],
                  ['支付', detail.paidAt],
                  ['发货', detail.shippedAt],
                  ['收货', detail.receivedAt],
                  ['取消', detail.cancelledAt],
                ].filter(([, at]) => Boolean(at)).map(([label, at]) => (
                  <div key={label} className="flex justify-between py-0.5 text-[11px] text-slate-500">
                    <span>{label}</span><span>{fmtDate(at)}</span>
                  </div>
                ))}
                {detail.transactionId ? <div className="mt-2 border-t border-slate-100 pt-2 text-[11px] text-slate-400">微信交易号 {detail.transactionId}</div> : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
