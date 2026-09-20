import { useEffect, useState } from 'react'
import { api } from '../utils/api'
import { OverlayPanel, OverlayViewport } from './overlay/OverlayPrimitives'

export default function DailyHistoricalCorrection({ initialStore, initialDate, supplement = false, onClose, onSaved }) {
  const [date, setDate] = useState(initialDate)
  const [store, setStore] = useState(initialStore)
  const [target, setTarget] = useState(initialStore)
  const [context, setContext] = useState(null)
  const [income, setIncome] = useState('')
  const [orders, setOrders] = useState('')
  const [items, setItems] = useState([])
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [ready, setReady] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID())
  useEffect(() => {
    let active = true
    setReady(false); setContext(null); setError(''); setConfirmed(false)
    api(`/v2/daily-entry/correction?store=${encodeURIComponent(store)}&date=${date}`).then((data) => {
      if (!active) return
      setContext(data); setTarget(store)
      setIncome(data.entry ? (Number(data.sales.incCents) / 100).toFixed(2) : '')
      setOrders(data.entry ? String(data.sales.ord) : '')
      setItems(data.staff.map((row) => ({ employeeId: row.employeeId || undefined, participantUserId: row.participantUserId || undefined, staffName: row.staffName, actualHours: row.actualHours ?? '', attendanceStatus: row.attendanceStatus || 'normal', actualStartTime: row.actualStartTime || '', actualEndTime: row.actualEndTime || '', breakMinutes: row.breakMinutes || 0 })))
      if (supplement && data.entry) throw new Error('该门店当天已有记录，请从历史详情进入更正')
      setRequestKey(crypto.randomUUID()); setReady(true)
    }).catch((e) => { if (active) setError(e.message) })
    return () => { active = false }
  }, [store, date, supplement])
  const changed = () => { setConfirmed(false); setRequestKey(crypto.randomUUID()) }
  const save = async (event) => {
    event.preventDefault()
    if (!ready || saving || !confirmed) return
    setSaving(true); setError('')
    try {
      if (!/^\d+(\.\d{1,2})?$/.test(income)) throw new Error('营业额需为非负数，最多两位小数')
      const cents = Math.round(Number(income) * 100)
      await api('/v2/daily-entry/correction', { method: 'POST', body: JSON.stringify({ storeKey: store, targetStoreKey: target, date,
        token: context.token, requestKey, incCents: cents, ord: orders, reason,
        items: items.map(({ staffName, ...row }) => row) }) })
      await onSaved(date)
    } catch (e) {
      setError(e.message)
      if (/409|已被|已变化|重新打开|禁止覆盖/.test(e.message)) setReady(false)
    } finally { setSaving(false) }
  }
  return <OverlayViewport className="fixed inset-0 z-[120] flex items-end justify-center sm:items-center sm:p-4">
    <div className="budu-overlay-backdrop absolute inset-0 bg-slate-900/45" />
    <OverlayPanel role="dialog" aria-modal="true" aria-label={supplement ? '历史补录' : '更正记录'} className="relative flex max-h-[92dvh] w-full min-w-0 max-w-2xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-xl sm:rounded-3xl">
      <div className="flex items-center justify-between border-b p-4"><h3 className="font-bold">{supplement ? '历史补录' : '更正记录'}</h3><button type="button" disabled={saving} onClick={onClose} className="min-h-11 px-3">关闭</button></div>
      <form onSubmit={save} className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <p className="rounded-xl bg-budu-50 p-3 text-sm text-slate-600">更正将保存经营事实、值班人员与实际工时，并保留完整历史。已发工资条保持原样，不自动补发或扣回。</p>
        <label className="block text-sm">营业日期<input aria-label="更正营业日期" type="date" disabled={!supplement || saving} value={date} onChange={(e) => setDate(e.target.value)} className="input mt-1 min-h-11 w-full" /></label>
        <label className="block text-sm">{supplement ? '补录门店' : '更正后门店'}<select aria-label="更正门店" disabled={saving} value={supplement ? store : target} onChange={(e) => { supplement ? setStore(e.target.value) : setTarget(e.target.value); changed() }} className="input mt-1 min-h-11 w-full">{context?.stores.map((row) => <option key={row.key} value={row.key}>{row.name}</option>)}</select></label>
        {!context && !error && <p role="status">正在读取历史事实…</p>}
        {context && <>
          {context.sales.source !== 'manual' && <p className="rounded-xl bg-amber-50 p-3 text-sm">当前金额与订单数来自 POS 汇总。保存后以本次核对的每日事实为准，原 POS 订单与支付记录不会修改。</p>}
          <div className="grid grid-cols-2 gap-3"><label className="text-sm">营业额（元）<input aria-label="更正营业额" required inputMode="decimal" value={income} disabled={saving} onChange={(e) => { setIncome(e.target.value); changed() }} className="input mt-1 min-h-11 w-full" /></label><label className="text-sm">订单数<input aria-label="更正订单数" required type="number" min="0" step="1" value={orders} disabled={saving} onChange={(e) => { setOrders(e.target.value); changed() }} className="input mt-1 min-h-11 w-full" /></label></div>
          <section className="space-y-2"><h4 className="text-sm font-bold">实际值班人员与工时</h4>{items.map((row, index) => <div key={row.employeeId || row.participantUserId} className="flex min-w-0 items-center gap-2 rounded-xl bg-slate-50 p-2"><span className="min-w-0 flex-1 break-words text-sm">{row.staffName}</span><input aria-label={`${row.staffName}实际工时`} type="number" min="0" max="24" step="0.01" required value={row.actualHours} disabled={saving} onChange={(e) => { setItems(items.map((item, i) => i === index ? { ...item, actualHours: e.target.value } : item)); changed() }} className="input min-h-11 w-20" /><span className="text-xs">小时</span><button type="button" disabled={saving} onClick={() => { setItems(items.filter((_, i) => i !== index)); changed() }} className="min-h-11 px-2 text-sm text-rose-600">移除</button></div>)}
            <select aria-label="添加实际值班人员" value="" disabled={saving} onChange={(e) => { const employee = context.employees.find((row) => row.id === e.target.value); if (employee) { setItems([...items, { employeeId: employee.id, staffName: employee.name, actualHours: '', attendanceStatus: 'normal' }]); changed() } }} className="input min-h-11 w-full"><option value="">添加实际值班人员</option>{context.employees.filter((employee) => !items.some((row) => row.employeeId === employee.id)).map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.employeeNo}</option>)}</select>
          </section>
          <label className="block text-sm">更正 / 补录原因<textarea aria-label="更正原因" required maxLength={500} value={reason} disabled={saving} onChange={(e) => { setReason(e.target.value); changed() }} className="input mt-1 min-h-20 w-full" /></label>
          <label className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm"><input type="checkbox" checked={confirmed} disabled={saving} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />我已核对 {context.stores.find((row) => row.key === target)?.name} / {date} 的营业额、订单数、人员与实际工时</label>
          <button type="submit" disabled={!ready || !confirmed || saving || !reason.trim()} className="btn-primary min-h-12 w-full disabled:opacity-40">{saving ? '正在保存…' : '保存并记录更正历史'}</button>
          {context.audits.length > 0 && <section className="space-y-3"><h4 className="font-bold">更正历史</h4>{context.audits.map((audit) => <article key={audit.id} className="rounded-xl border p-3 text-xs leading-6"><p>{new Date(audit.createdAt).toLocaleString('zh-CN')} · {audit.operatorName} · {audit.afterValue?.actorRole}</p><p>原因：{audit.reason}</p><p>门店：{audit.afterValue?.storeBefore} → {audit.afterValue?.storeAfter}</p><p>营业额：{Number(audit.beforeValue?.sales?.incCents ?? audit.beforeValue?.entry?.incCents ?? 0) / 100} → {Number(audit.afterValue?.entry?.incCents || 0) / 100} 元；订单：{audit.beforeValue?.sales?.ord ?? audit.beforeValue?.entry?.ord ?? '缺失'} → {audit.afterValue?.entry?.ord}</p><p>原人员：{(audit.beforeValue?.participants || []).map((r) => `${r.staffNameSnapshot || r.staffName} ${r.actualHours}小时`).join('、') || '无'}</p><p>更正后：{(audit.afterValue?.participants || []).map((r) => `${r.staffName} ${r.actualHours}小时`).join('、')}</p><p>更正时工资状态：{audit.afterValue?.payrollState?.status === 'PAID' ? '已有已发工资条，保持原样' : '尚未发放'}</p></article>)}</section>}
        </>}
        {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
      </form>
    </OverlayPanel>
  </OverlayViewport>
}
