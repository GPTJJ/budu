import { useEffect, useState } from 'react'
import { api } from '../utils/api'
import { formatCents } from '../utils/pos'

/**
 * 数据 → 商品表现
 *
 * 按报价快照里的商品行汇总：销量（件）、销售额、出现订单数。
 * 与「交易分析」共用 /analytics 接口，只是取完整商品榜（productLimit=50）。
 */

const RANGES = [{ key: 7, label: '近 7 天' }, { key: 30, label: '近 30 天' }, { key: 90, label: '近 90 天' }]

export default function ProductPerformanceBoard() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setData(null)
    api(`/v2/online-catalog/analytics?days=${days}&productLimit=50`)
      .then((res) => { if (!cancelled) setData(res) })
      .catch((err) => { if (!cancelled) setError(err.message || '加载失败') })
    return () => { cancelled = true }
  }, [days])

  if (error) return <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
  if (!data) return <div className="rounded-2xl border border-slate-200 bg-white px-4 py-16 text-center text-sm text-slate-400">加载中…</div>

  const rows = data.top || []
  const totalUnits = rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0)
  const totalAmount = rows.reduce((sum, row) => sum + Number(row.amountCents || 0), 0)
  const maxAmount = Math.max(1, ...rows.map((row) => Number(row.amountCents || 0)))

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {RANGES.map((range) => (
          <button
            key={range.key}
            type="button"
            onClick={() => setDays(range.key)}
            className={`h-8 rounded-full border px-3 text-xs sm:h-7 ${days === range.key ? 'border-budu-200 bg-budu-50 font-medium text-budu-700' : 'border-slate-200 bg-white text-slate-600'}`}
          >
            {range.label}
          </button>
        ))}
        <span className="w-full text-[10px] text-slate-400 sm:ml-auto sm:w-auto sm:text-[11px]">
          共 {data.productCount || rows.length} 个商品有成交 · 合计 {totalUnits} 件 · {formatCents(String(totalAmount))}
        </span>
      </div>

      {!rows.length ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-14 text-center">
          <div className="text-sm text-slate-600">该区间还没有商品成交</div>
          <p className="mt-1 text-[11px] text-slate-400">商品数据按订单报价快照汇总，历史订单全部退款时仍会出现在这里。</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr className="border-b border-slate-100 bg-[#FEFDFC] text-left text-[11px] text-slate-500">
                  <th className="w-[48px] px-4 py-2.5 font-medium">#</th>
                  <th className="px-3 py-2.5 font-medium">商品</th>
                  <th className="w-[90px] px-3 py-2.5 font-medium">销量</th>
                  <th className="w-[120px] px-3 py-2.5 font-medium">销售额</th>
                  <th className="w-[180px] px-3 py-2.5 font-medium">占比</th>
                  <th className="w-[90px] px-4 py-2.5 font-medium">订单数</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 text-[11px] text-slate-400">{index + 1}</td>
                    <td className="px-3 py-3 text-sm font-medium text-slate-700">{row.name}</td>
                    <td className="px-3 py-3 text-xs text-slate-600">{row.quantity} 件</td>
                    <td className="px-3 py-3 text-sm font-medium text-slate-700">{formatCents(String(row.amountCents))}</td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                          <div className="h-full rounded-full bg-budu-400" style={{ width: `${Math.round((Number(row.amountCents) / maxAmount) * 100)}%` }} />
                        </div>
                        <span className="w-10 text-right text-[11px] text-slate-400">{Math.round((Number(row.amountCents) / Math.max(1, totalAmount)) * 100)}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{row.orders}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="divide-y divide-slate-100 md:hidden">
            {rows.map((row, index) => (
              <div key={row.id} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-slate-400">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{row.name}</span>
                  <span className="shrink-0 text-sm font-medium text-slate-700">{formatCents(String(row.amountCents))}</span>
                </div>
                <div className="mt-1 text-[11px] text-slate-400">{row.quantity} 件 · {row.orders} 笔订单</div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-[11px] text-slate-400">
            <span>共 {rows.length} 个商品</span>
            <span>按销售额排序</span>
          </div>
        </div>
      )}
    </div>
  )
}
