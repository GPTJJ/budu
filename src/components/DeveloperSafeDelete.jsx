import { useEffect, useState } from 'react'
import { AlertTriangle, RotateCcw, Trash2, X } from 'lucide-react'
import { api } from '../utils/api'
import { hasDeveloperSensitiveRecordDelete } from '../../shared/accountPermissions'

const reasonOptions = [
  ['test', '测试数据'], ['duplicate', '重复记录'], ['input_error', '录入错误'], ['other', '其他'],
]

function Overlay({ children, onClose }) {
  return <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/45 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="max-h-[92dvh] w-full overflow-y-auto rounded-t-[28px] bg-white pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:max-w-lg sm:rounded-[28px]">{children}</div></div>
}

export function DeveloperSafeDeleteButton({ user, type, record, onDeleted, className = '' }) {
  const [open, setOpen] = useState(false)
  const [reasonCode, setReasonCode] = useState('')
  const [reasonText, setReasonText] = useState('')
  const [secondPassword, setSecondPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!hasDeveloperSensitiveRecordDelete(user)) return null
  const highRisk = ['shipped', 'done', 'received'].includes(record?.status) || Number(record?.receivedAmountCents || 0) > 0
  const submit = async () => {
    if (!reasonCode || (reasonCode === 'other' && !reasonText.trim()) || !secondPassword) return setError('请完整填写删除原因和二级密码')
    setBusy(true); setError('')
    try {
      await api(`/v2/developer-sensitive-records/${type}/${record.id}/delete`, { method: 'POST', body: JSON.stringify({ reasonCode, reasonText, secondPassword }) })
      setOpen(false); setSecondPassword(''); await onDeleted?.()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return <>
    <button type="button" onClick={() => setOpen(true)} className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl bg-rose-50 px-3 text-xs font-bold text-rose-600 ${className}`}><Trash2 className="h-4 w-4" />安全删除</button>
    {open && <Overlay onClose={() => !busy && setOpen(false)}><div className="sticky top-0 flex items-center justify-between border-b border-slate-100 bg-white px-5 py-4"><div><h3 className="font-black text-slate-900">开发者安全删除</h3><p className="mt-0.5 text-xs text-slate-400">记录 ID：{record.id}</p></div><button type="button" aria-label="关闭" onClick={() => setOpen(false)} className="grid h-10 w-10 place-items-center rounded-full bg-slate-100"><X className="h-4 w-4" /></button></div><div className="space-y-4 p-5">
      <div className="rounded-2xl bg-slate-50 p-4"><p className="font-bold text-slate-800">{record.title || record.orderNo || record.companyName || record.recipient || record.id}</p><p className="mt-1 text-xs text-slate-500">{record.subtitle || `状态：${record.status || '—'}`}</p></div>
      <div className={`rounded-2xl p-4 text-sm ${highRisk ? 'bg-rose-100 text-rose-800' : 'bg-amber-50 text-amber-800'}`}><div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" /><p><strong>{highRisk ? '高风险业务记录' : '敏感操作'}</strong><br />删除后将从正常列表、统计、导出和后续操作中隐藏，但原记录及子记录不会被物理删除，可在开发者工具中恢复。</p></div></div>
      <fieldset><legend className="mb-2 text-xs font-bold text-slate-500">删除原因</legend><div className="grid grid-cols-2 gap-2">{reasonOptions.map(([value, label]) => <label key={value} className={`rounded-xl border p-3 text-sm font-bold ${reasonCode === value ? 'border-rose-400 bg-rose-50 text-rose-700' : 'border-slate-200 text-slate-600'}`}><input type="radio" className="sr-only" name={`delete-reason-${record.id}`} value={value} checked={reasonCode === value} onChange={() => setReasonCode(value)} />{label}</label>)}</div></fieldset>
      {reasonCode === 'other' && <label className="block text-xs font-bold text-slate-500">其他原因<textarea aria-label="其他删除原因" className="input mt-1 min-h-20 w-full resize-y" maxLength={200} value={reasonText} onChange={(e) => setReasonText(e.target.value)} /></label>}
      <label className="block text-xs font-bold text-slate-500">二级密码<input aria-label="安全删除二级密码" type="password" autoComplete="off" className="input mt-1 w-full" value={secondPassword} onChange={(e) => setSecondPassword(e.target.value)} /></label>
      {error && <p className="text-sm font-bold text-rose-600">{error}</p>}
      <button type="button" disabled={busy || !reasonCode || !secondPassword} onClick={submit} className="min-h-12 w-full rounded-xl bg-rose-600 text-sm font-black text-white disabled:opacity-40">{busy ? '验证并删除中…' : '验证二级密码并安全删除'}</button>
    </div></Overlay>}
  </>
}

export function DeletedRecordsCenter({ user }) {
  const [rows, setRows] = useState([])
  const [filters, setFilters] = useState({ type: '', start: '', end: '', deletedBy: '', reason: '' })
  const [detail, setDetail] = useState(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString()
    try { const result = await api(`/v2/developer-sensitive-records?${query}`); setRows(result.rows || []) } catch (err) { setError(err.message) }
  }
  useEffect(() => { if (hasDeveloperSensitiveRecordDelete(user)) load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  if (!hasDeveloperSensitiveRecordDelete(user)) return null
  const restore = async () => {
    if (!password) return setError('请输入二级密码')
    setBusy(true); setError('')
    try { await api(`/v2/developer-sensitive-records/${detail.type}/${detail.id}/restore`, { method: 'POST', body: JSON.stringify({ secondPassword: password }) }); setDetail(null); setPassword(''); await load() } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return <div className="card p-4 sm:p-6" data-testid="deleted-records-center"><div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-rose-600 text-white"><Trash2 className="h-5 w-5" /></div><div><h3 className="font-bold text-slate-800">开发者工具 · 已删除记录</h3><p className="text-xs text-slate-400">仅开发者可查看、审计及恢复</p></div></div><div className="mt-4 grid gap-2 sm:grid-cols-5"><select aria-label="记录类型" className="input" value={filters.type} onChange={(e) => setFilters((s) => ({ ...s, type: e.target.value }))}><option value="">全部类型</option><option value="mailing">门店邮寄</option><option value="invoice">开发票</option><option value="transfer">库存调拨</option><option value="purchase">采购申请</option><option value="partnerSupply">合作商供货</option></select><input aria-label="删除开始日期" type="date" className="input" value={filters.start} onChange={(e) => setFilters((s) => ({ ...s, start: e.target.value }))} /><input aria-label="删除结束日期" type="date" className="input" value={filters.end} onChange={(e) => setFilters((s) => ({ ...s, end: e.target.value }))} /><input aria-label="删除人筛选" className="input" placeholder="删除人 User.id" value={filters.deletedBy} onChange={(e) => setFilters((s) => ({ ...s, deletedBy: e.target.value }))} /><input aria-label="删除原因筛选" className="input" placeholder="原因关键词" value={filters.reason} onChange={(e) => setFilters((s) => ({ ...s, reason: e.target.value }))} /></div><button type="button" onClick={load} className="mt-2 min-h-10 rounded-xl bg-slate-800 px-4 text-xs font-bold text-white">筛选</button>{error && <p className="mt-3 text-sm font-bold text-rose-600">{error}</p>}<div className="mt-4 space-y-2">{rows.map((row) => <button type="button" key={`${row.type}-${row.id}`} onClick={async () => { try { const result = await api(`/v2/developer-sensitive-records/${row.type}/${row.id}`); setDetail(result) } catch (err) { setError(err.message) } }} className="flex w-full items-start justify-between gap-3 rounded-2xl bg-slate-50 p-3 text-left"><span className="min-w-0"><strong className="block truncate text-sm text-slate-800">{row.typeLabel} · {row.title}</strong><span className="mt-1 block text-xs text-slate-500">{row.deleteReason} · {new Date(row.deletedAt).toLocaleString('zh-CN')}</span></span><span className="shrink-0 text-xs font-bold text-budu-600">详情</span></button>)}{!rows.length && <p className="py-6 text-center text-sm text-slate-400">暂无已删除记录</p>}</div>
    {detail && <Overlay onClose={() => setDetail(null)}><div className="flex items-center justify-between border-b p-5"><div><h3 className="font-black">已删除记录详情</h3><p className="text-xs text-slate-400">{detail.record.typeLabel} · {detail.record.id}</p></div><button type="button" onClick={() => setDetail(null)} className="grid h-10 w-10 place-items-center rounded-full bg-slate-100"><X className="h-4 w-4" /></button></div><div className="space-y-4 p-5"><div className="rounded-2xl bg-slate-50 p-4"><p className="font-bold">{detail.record.title}</p><p className="mt-2 text-xs text-slate-500">{detail.record.subtitle}</p><p className="mt-2 text-xs text-rose-600">{detail.record.deleteReason}</p></div><div className="rounded-2xl border p-3 text-xs text-slate-500">{detail.audits.map((audit) => <p key={audit.id}>{audit.action === 'DELETE' ? '删除' : '恢复'} · {audit.actorUsername} · {new Date(audit.createdAt).toLocaleString('zh-CN')}</p>)}</div><label className="block text-xs font-bold text-slate-500">二级密码<input aria-label="恢复二级密码" type="password" autoComplete="off" className="input mt-1 w-full" value={password} onChange={(e) => setPassword(e.target.value)} /></label><button type="button" onClick={restore} disabled={busy || !password} className="btn-primary min-h-12 w-full"><RotateCcw className="h-4 w-4" />{busy ? '恢复中…' : '恢复原记录'}</button></div></Overlay>}
  </div>
}
