import { useCallback, useEffect, useState } from 'react'
import { X, RotateCcw } from 'lucide-react'
import { api } from '../utils/api'
import { formatCents } from '../utils/pos'

/**
 * 售后台账（BUDU-MP-CONSOLE-001 / P2 · 只读）
 *
 * 先让历史退款可查、可对账；「发起退款」涉及微信原路退款，留到有真实可退订单时
 * 再开放，并在写入前加二次确认与财务权限校验。
 */

const STATUS_STYLE = {
  SETTLED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  PENDING: 'bg-amber-50 text-amber-700 border-amber-200',
  FAILED: 'bg-rose-50 text-rose-700 border-rose-200',
}

function fmtDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function AfterSalesBoard({ initialState = '' }) {
  const [status, setStatus] = useState(initialState)
  const [rows, setRows] = useState([])
  const [summary, setSummary] = useState({ total: 0, settled: 0, totalCents: '0' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState(null)
  const [open, setOpen] = useState(false)

  useEffect(() => { setStatus(initialState) }, [initialState])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams()
      if (status) params.set('status', status)
      const res = await api(`/v2/online-catalog/refunds?${params.toString()}`)
      setRows(res.refunds || [])
      setSummary({ total: res.total || 0, settled: res.settled || 0, totalCents: res.totalCents || '0' })
    } catch (err) {
      setError(err.message || '加载售后记录失败')
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => { load() }, [load])

  const openDetail = async (id) => {
    setOpen(true)
    setDetail(null)
    try {
      const res = await api(`/v2/online-catalog/refunds/${id}`)
      setDetail(res.refund)
    } catch (err) {
      setError(err.message || '加载退款详情失败')
      setOpen(false)
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex gap-1.5">
          {[{ key: '', label: '全部记录' }, { key: 'PENDING', label: '处理中' }, { key: 'SETTLED', label: '已到账' }].map((item) => (
            <button
              key={item.key || 'all'}
              type="button"
              onClick={() => setStatus(item.key)}
              className={`h-7 rounded-full border px-3 text-xs ${status === item.key ? 'border-budu-200 bg-budu-50 font-medium text-budu-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3 text-[11px] text-slate-500">
          <span>共 <b className="text-slate-700">{summary.total}</b> 笔</span>
          <span>已到账 <b className="text-emerald-700">{summary.settled}</b></span>
          <span>合计 <b className="text-slate-700">{formatCents(summary.totalCents)}</b></span>
        </div>
      </div>

      <div className="mb-3 rounded-xl border border-budu-100 bg-budu-50/60 px-4 py-2 text-[11px] leading-relaxed text-budu-700">
        当前为只读台账：历史退款可查、可对账。发起退款需要调用微信原路退款，将在有真实可退订单时开放，并加二次确认与财务权限。
      </div>

      {error ? <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">{error}</div> : null}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px]">
            <thead>
              <tr className="border-b border-slate-100 bg-[#FEFDFC] text-left text-[11px] text-slate-500">
                <th className="w-[180px] px-4 py-2.5 font-medium">退款单</th>
                <th className="px-3 py-2.5 font-medium">关联订单</th>
                <th className="px-3 py-2.5 font-medium">顾客</th>
                <th className="w-[110px] px-3 py-2.5 font-medium">金额</th>
                <th className="px-3 py-2.5 font-medium">原因</th>
                <th className="w-[100px] px-3 py-2.5 font-medium">状态</th>
                <th className="w-[120px] px-3 py-2.5 font-medium">时间</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7}><div className="px-4 py-14 text-center text-xs text-slate-400">加载中…</div></td></tr>
              ) : !rows.length ? (
                <tr><td colSpan={7}><div className="px-4 py-14 text-center text-xs text-slate-400">没有售后记录</div></td></tr>
              ) : rows.map((row) => (
                <tr key={row.id} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-[#FEFCFB]" onClick={() => openDetail(row.id)}>
                  <td className="px-4 py-3">
                    <div className="max-w-[170px] truncate font-mono text-[12px] text-slate-700" title={row.id}>{row.id}</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">第 {row.sequence} 笔</div>
                  </td>
                  <td className="max-w-[190px] truncate px-3 py-3 font-mono text-[11px] text-slate-500" title={row.orderNo}>{row.orderNo}</td>
                  <td className="px-3 py-3 text-xs text-slate-600">{row.customer.name}</td>
                  <td className="px-3 py-3 text-sm font-medium text-slate-700">{formatCents(row.totalCents)}</td>
                  <td className="max-w-[220px] truncate px-3 py-3 text-xs text-slate-500">{row.reason || '—'}</td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] ${STATUS_STYLE[row.status] || STATUS_STYLE.PENDING}`}>{row.statusLabel}</span>
                  </td>
                  <td className="px-3 py-3 text-[11px] text-slate-400">{fmtDate(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {open ? (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-slate-900/30" onClick={() => setOpen(false)} />
          <div className="relative flex h-full w-[680px] max-w-[94vw] flex-col bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-6 py-4">
              <div>
                <div className="max-w-[480px] truncate font-mono text-sm font-semibold text-slate-800" title={detail?.id}>{detail?.id || '退款详情'}</div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                  {detail ? <span className={`inline-flex rounded-full border px-2 py-0.5 ${STATUS_STYLE[detail.status] || STATUS_STYLE.PENDING}`}>{detail.statusLabel}</span> : null}
                  <span>{detail?.customer?.name || ''}</span>
                </div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"><X size={18} /></button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              {!detail ? <div className="py-16 text-center text-xs text-slate-400">加载中…</div> : (
                <>
                  <section className="mb-5 rounded-xl border border-slate-200 p-3 text-xs">
                    <div className="mb-1 text-[11px] text-slate-400">退款金额</div>
                    <div className="flex justify-between py-0.5"><span className="text-slate-500">合计</span><b>{formatCents(detail.totalCents)}</b></div>
                    <div className="flex justify-between py-0.5"><span className="text-slate-500">微信原路</span><span>{formatCents(detail.wechatCents)}</span></div>
                    <div className="flex justify-between py-0.5"><span className="text-slate-500">甜意卡</span><span>{formatCents(detail.sweetCardCents)}</span></div>
                    <div className="mt-1 flex justify-between border-t border-dashed border-slate-200 pt-1 text-[11px] text-slate-400"><span>订单实付</span><span>{formatCents(detail.orderTotalCents)}</span></div>
                  </section>

                  <section className="mb-5">
                    <h3 className="mb-2 text-[11px] font-medium text-slate-400">关联订单</h3>
                    <div className="rounded-xl border border-slate-200 px-3 py-2 text-xs">
                      <div className="max-w-[560px] truncate font-mono text-[11px] text-slate-600" title={detail.orderNo}>{detail.orderNo}</div>
                      <div className="mt-1 text-[11px] text-slate-400">下单支付 {fmtDate(detail.paidAt)} · 原因：{detail.reason || '—'}</div>
                    </div>
                  </section>

                  <section>
                    <h3 className="mb-2 text-[11px] font-medium text-slate-400">订单商品</h3>
                    <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                      {detail.lines.length ? detail.lines.map((line, index) => (
                        <div key={index} className="flex items-center justify-between px-3 py-2 text-xs">
                          <div>
                            <div className="text-slate-700">{line.name}</div>
                            <div className="mt-0.5 text-[11px] text-slate-400">{line.spec || '—'}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-slate-700">{formatCents(line.amountCents)}</div>
                            <div className="text-[11px] text-slate-400">×{line.quantity}</div>
                          </div>
                        </div>
                      )) : <div className="px-3 py-3 text-xs text-slate-400">快照中没有商品明细</div>}
                    </div>
                  </section>

                  <div className="mt-5 flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
                    <RotateCcw size={13} className="mt-0.5 shrink-0" />
                    退款已由结算侧完成，这里只做展示与对账，不提供修改入口。
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end border-t border-slate-100 px-6 py-3">
              <button type="button" onClick={() => setOpen(false)} className="h-9 rounded-xl border border-slate-200 px-4 text-sm text-slate-600">关闭</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
