import { useEffect, useState } from 'react'
import { api } from '../utils/api'
import { formatCents } from '../utils/pos'

/**
 * 数据（BUDU-MP-CONSOLE-001 / P2 · 只读）
 * 全部来自结算与报价快照，不做任何写操作。
 */

const RANGES = [{ key: 7, label: '近 7 天' }, { key: 30, label: '近 30 天' }, { key: 90, label: '近 90 天' }]

function Kpi({ label, value, hint }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-slate-800">{value}</div>
      {hint ? <div className="mt-1 text-[11px] text-slate-400">{hint}</div> : null}
    </div>
  )
}

export default function AnalyticsBoard({ fixedDays = 0 }) {
  const [days, setDays] = useState(fixedDays || 30)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setData(null)
    api(`/v2/online-catalog/analytics?days=${fixedDays || days}`)
      .then((res) => { if (!cancelled) setData(res) })
      .catch((err) => { if (!cancelled) setError(err.message || '加载失败') })
    return () => { cancelled = true }
  }, [days, fixedDays])

  if (error) return <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
  if (!data) return <div className="rounded-2xl border border-slate-200 bg-white px-4 py-16 text-center text-sm text-slate-400">加载中…</div>

  const { totals, series, top } = data
  const maxPaid = Math.max(1, ...series.map((row) => row.paidCents))
  const maxOrders = Math.max(1, ...series.map((row) => row.orders))

  return (
    <div>
      <div className="mb-4 flex items-center gap-1.5">
        {RANGES.map((range) => (
          <button
            key={range.key}
            type="button"
            disabled={Boolean(fixedDays)}
            onClick={() => setDays(range.key)}
            className={`h-7 rounded-full border px-3 text-xs ${days === range.key ? 'border-budu-200 bg-budu-50 font-medium text-budu-700' : 'border-slate-200 bg-white text-slate-600'} disabled:opacity-60`}
          >
            {range.label}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-slate-400">数据更新于 {new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="净成交额" value={formatCents(totals.paidCents)} hint={`${totals.paidOrders} 笔已支付（已扣整单退款）`} />
        <Kpi label="订单数" value={totals.orders} hint={`取消 ${totals.cancelled} 笔`} />
        <Kpi label="客单价" value={formatCents(totals.avgOrderCents)} hint="按已支付订单计算" />
        <Kpi label="退款金额" value={formatCents(totals.refundCents)} hint={`退款率 ${totals.refundRate}%`} />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[1.4fr_1fr]">
        <div className="rounded-2xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-700">每日订单与净成交</h2>
            <span className="text-[11px] text-slate-400">柱高＝净成交，标注＝订单数</span>
          </div>
          <div className="px-4 pb-4 pt-6">
            {series.length ? (
              <div className="flex h-40 items-end gap-1.5 overflow-x-auto">
                {series.map((row) => (
                  <div key={row.date} className="group flex min-w-[18px] flex-1 flex-col items-center justify-end gap-1">
                    <span className="text-[9px] text-slate-400">{row.orders}</span>
                    <div
                      className="w-full max-w-[26px] rounded-t bg-gradient-to-t from-budu-500 to-budu-300"
                      style={{ height: `${Math.max(3, Math.round((row.paidCents / maxPaid) * 120))}px`, opacity: row.paidCents ? 1 : 0.25 }}
                      title={`${row.date} 订单 ${row.orders} · 净成交 ${formatCents(row.paidCents)}`}
                    />
                    <span className="rotate-0 text-[9px] text-slate-300">{row.date.slice(5)}</span>
                  </div>
                ))}
              </div>
            ) : <div className="py-14 text-center text-xs text-slate-400">该区间没有订单</div>}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-700">热销商品</h2>
          </div>
          <div className="px-4 py-3">
            {top.length ? top.map((item, index) => (
              <div key={item.id} className="flex items-center gap-2 border-b border-dashed border-slate-100 py-2 last:border-0">
                <span className="w-4 text-[11px] text-slate-300">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-slate-700">{item.name}</div>
                  <div className="mt-0.5 text-[10px] text-slate-400">{item.orders} 单 · {item.quantity} 件</div>
                </div>
                <div className="text-xs font-medium text-slate-700">{formatCents(item.amountCents)}</div>
              </div>
            )) : <div className="py-14 text-center text-xs text-slate-400">暂无商品数据</div>}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[11px] text-slate-500">
        口径：净成交＝已支付金额 − 整单退款；热销按订单快照行金额汇总，未区分退款。
      </div>
    </div>
  )
}
