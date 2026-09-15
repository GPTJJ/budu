import { useRef, useState } from 'react'
import { api } from '../utils/api'
import { formatCents, centsToYuan } from '../utils/pos'
import { OverlayPanel, OverlayViewport } from './overlay/OverlayPrimitives'

export function SalesFact({ title, entry }) {
  return <div className="min-w-0 rounded-xl bg-slate-50 p-3 text-sm">
    <p className="text-xs text-slate-500">{title}</p>
    {entry ? <><p className="mt-1 break-all">营业收入 {formatCents(entry.incCents)}</p><p>订单数 {entry.ord}</p></> : <p>原始快照暂无记录，不推测历史值</p>}
  </div>
}

export default function DailyPerformanceCorrection({ row, onClose, onSaved }) {
  const [income, setIncome] = useState(centsToYuan(row.incCents))
  const [orders, setOrders] = useState(String(row.ord))
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stale, setStale] = useState(false)
  const pending = useRef(null)
  const revisions = [...(row.audits || [])].filter(a => a.module === 'daily_revision' && a.beforeValue?.entry)
    .sort((a, b) => a.beforeValue.entry.version - b.beforeValue.entry.version)
  const original = revisions[0]?.beforeValue.entry || (row.revisionCount ? null : row)
  const prepare = () => {
    if (!/^\d+(\.\d{1,2})?$/.test(income) || !/^\d+$/.test(orders) || reason.trim().length < 2) {
      setError('请填写合法金额、整数订单数和至少两个字的更正原因'); return
    }
    const [whole, fraction = ''] = income.split('.')
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
    if (cents > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(Number(orders))) { setError('金额或订单数超出支持范围'); return }
    pending.current ||= { scope: 'sales', storeKey: row.storeKey, date: row.date, version: row.version,
      requestKey: crypto.randomUUID(), manualSales: { incCents: Number(cents), ord: Number(orders) }, reason: reason.trim() }
    setError(''); setConfirming(true)
  }
  const save = async () => {
    if (busy || !pending.current || stale) return
    setBusy(true); setError('')
    try {
      await api('/v2/daily-entry/revise', { method: 'POST', body: JSON.stringify(pending.current) })
    } catch (e) {
      setError(e.message); if (e.status === 409) setStale(true)
      setBusy(false); return
    }
    onSaved()
  }
  const edit = (setter) => event => { setter(event.target.value); pending.current = null }
  return <OverlayViewport className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/40 p-3">
    <OverlayPanel role="dialog" aria-modal="true" aria-label="更正每日业绩" className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <h3 className="font-bold text-slate-800">更正数据 · {row.storeName}</h3><p className="mb-3 text-sm text-slate-500">{row.date}</p>
      <div className="grid gap-2 sm:grid-cols-2"><SalesFact title="原始数据" entry={original} /><SalesFact title="当前有效数据" entry={row} /></div>
      {confirming ? <div className="mt-3 space-y-3"><SalesFact title="修改后的数据" entry={pending.current.manualSales} /><p className="break-words text-sm">更正原因：{pending.current.reason}</p><p className="text-sm text-slate-500">确认保存此更正？将保留修改前后值及操作审计。</p></div>
        : <div className="mt-3 space-y-3">
          <label className="block text-sm">修改后营业收入<input aria-label="修改后营业收入" className="input mt-1 w-full" inputMode="decimal" value={income} onChange={edit(setIncome)} /></label>
          <label className="block text-sm">修改后订单数<input aria-label="修改后订单数" className="input mt-1 w-full" inputMode="numeric" value={orders} onChange={edit(setOrders)} /></label>
          <label className="block text-sm">更正原因（必填）<textarea aria-label="更正原因" className="input mt-1 w-full" maxLength={300} value={reason} onChange={edit(setReason)} /></label>
        </div>}
      {error && <p role="alert" className="mt-3 text-sm text-rose-600">{error}{stale && '。请关闭窗口，刷新历史记录后重新核对。'}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button disabled={busy} onClick={onClose} className="min-h-11 rounded-xl border px-4">关闭</button>
        {confirming && !stale && <button disabled={busy} onClick={() => setConfirming(false)} className="min-h-11 rounded-xl border px-4">返回修改</button>}
        <button disabled={busy || stale} onClick={confirming ? save : prepare} className="min-h-11 rounded-xl bg-budu-600 px-4 text-white disabled:opacity-50">{busy ? '保存中…' : confirming ? '确认更正' : '核对更正'}</button>
      </div>
    </OverlayPanel>
  </OverlayViewport>
}
