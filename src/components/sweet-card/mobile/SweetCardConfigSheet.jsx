import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, Lock, Search, ShieldCheck } from 'lucide-react'
import { api } from '../../../utils/api'
import { buildAuditEntries, buildCardTailIndex } from '../../../utils/sweetCardAudit'

const SEGMENTS = [['stores', '可用门店'], ['rules', '核销规则'], ['audit', '操作审计']]
const fieldClass = 'w-full rounded-2xl border border-slate-200 bg-white px-3.5 py-2.5 text-[14px] outline-none placeholder:text-slate-300 focus:border-budu-300 focus:ring-2 focus:ring-budu-100'

function Segmented({ value, onChange }) {
  return (
    <div className="mx-4 mt-3 grid grid-cols-3 gap-1 rounded-2xl bg-slate-100 p-1" role="tablist" aria-label="配置中心分区">
      {SEGMENTS.map(([key, label]) => (
        <button key={key} role="tab" aria-selected={value === key} onClick={() => onChange(key)} className={`h-9 rounded-xl text-[13px] font-black transition ${value === key ? 'bg-white text-budu-600 shadow-sm' : 'text-slate-500'}`}>{label}</button>
      ))}
    </div>
  )
}

export default function SweetCardConfigSheet({ open, onClose, initialSegment = 'stores', rules, audit, cards, onSaveRules, onReload, saving }) {
  const [segment, setSegment] = useState(initialSegment)
  const [search, setSearch] = useState('')
  const [blocked, setBlocked] = useState([])
  const [availability, setAvailability] = useState(null)
  // 审计列表只做展示层翻译：事件码 → 中文动作、UUID → 业务身份、制卡多事件合并。
  const auditEntries = useMemo(() => buildAuditEntries(audit || [], {
    cardTailIndex: buildCardTailIndex(cards || []),
  }).slice(0, 60), [audit, cards])
  const [availabilityError, setAvailabilityError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => { if (open) { setSegment(initialSegment); setMessage('') } }, [open, initialSegment])
  useEffect(() => { if (open && rules) setBlocked(rules.categories.filter((row) => row.blocked).map((row) => row.id)) }, [open, rules])
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setAvailabilityError('')
    api('/v2/sweet-cards/availability').then((data) => { if (!cancelled) setAvailability(data) }).catch((e) => { if (!cancelled) setAvailabilityError(e.message) })
    return () => { cancelled = true }
  }, [open])

  const categories = rules?.categories || []
  const blockedRows = useMemo(() => categories.filter((row) => blocked.includes(row.id)), [categories, blocked])
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return query ? categories.filter((row) => String(row.name || '').toLowerCase().includes(query)) : categories
  }, [categories, search])
  const dirty = useMemo(() => {
    const original = categories.filter((row) => row.blocked).map((row) => row.id).sort().join(',')
    return original !== [...blocked].sort().join(',')
  }, [categories, blocked])

  const changeAvailability = async (path, enabled, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(true); setMessage('')
    try { setAvailability(await api(`/v2/sweet-cards/availability/${path}`, { method: 'PUT', body: JSON.stringify({ enabled }) })) }
    catch (e) { setMessage(e.message); }
    finally { setBusy(false) }
  }

  const saveRules = async () => {
    setBusy(true); setMessage('')
    try { await onSaveRules(blocked); setMessage('核销规则已保存') }
    catch (e) { setMessage(e.message) }
    finally { setBusy(false) }
  }

  if (!open) return null
  const working = busy || saving

  return (
    <div className="fixed inset-0 z-[140] flex flex-col bg-[#FBF7F8]" role="dialog" aria-modal="true" aria-label="配置中心">
      <div className="flex items-center gap-2 border-b border-rose-100/80 bg-white/90 px-2.5 py-3 backdrop-blur">
        <button type="button" onClick={onClose} aria-label="返回" className="grid h-9 w-9 place-items-center rounded-xl text-slate-500 active:bg-slate-100"><ArrowLeft className="h-[18px] w-[18px]" /></button>
        <h2 className="text-[16px] font-black text-slate-900">配置中心</h2>
        <button type="button" onClick={onReload} className="ml-auto rounded-xl px-3 py-1.5 text-[12px] font-bold text-slate-400">刷新</button>
      </div>

      <Segmented value={segment} onChange={setSegment} />

      <div className="mx-auto w-full max-w-[560px] flex-1 overflow-y-auto px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3">
        {message && <p role="status" className="mb-3 rounded-2xl bg-white px-3.5 py-2.5 text-[12px] font-bold text-slate-600 ring-1 ring-slate-200">{message}</p>}

        {segment === 'stores' && <section aria-label="可用门店" className="space-y-3">
          <div className="rounded-3xl bg-white p-4 ring-1 ring-slate-100">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-[15px] font-black text-slate-900">甜意卡总开关</h3>
                <p className="mt-1 text-[11px] leading-4 text-slate-400">停用后所有门店停止新的核销，历史订单退款不受影响。</p>
              </div>
              <button role="switch" aria-checked={Boolean(availability?.globalEnabled)} aria-label="甜意卡总开关" disabled={working || !availability} onClick={() => changeAvailability('global', !availability.globalEnabled, availability.globalEnabled ? '确认紧急停用全部甜意卡核销？门店配置保留，历史退款不受影响。' : '开启后，各门店将按已保存的门店开关恢复新的甜意卡核销。确认开启？')} className={`h-9 shrink-0 rounded-xl px-3.5 text-[12px] font-black disabled:opacity-50 ${availability?.globalEnabled ? 'bg-budu-500 text-white' : 'bg-slate-100 text-slate-500'}`}>
                {availability?.globalEnabled ? '已开启' : '已关闭'}
              </button>
            </div>
          </div>

          {availabilityError && <p role="alert" className="rounded-2xl bg-rose-50 px-3.5 py-2.5 text-[12px] font-bold text-rose-700">{availabilityError}</p>}
          {!availability && !availabilityError && <p className="px-1 py-6 text-center text-[12px] text-slate-400">正在读取门店配置…</p>}

          {(availability?.stores || []).map((store) => {
            const locked = !store.configurable
            return (
              <div key={store.id} className={`rounded-2xl p-3.5 ring-1 ${locked ? 'bg-slate-100/70 ring-slate-200' : 'bg-white ring-slate-100'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className={`min-w-0 ${locked ? 'text-slate-400' : ''}`}>
                    <h4 className="flex items-center gap-1.5 truncate text-[14px] font-black">{locked && <Lock className="h-3 w-3" />}{store.name}</h4>
                    <p className={`mt-1 text-[11px] ${locked ? 'text-slate-400' : 'text-slate-400'}`}>{store.active ? '营业中' : '门店停用'} · POS 操作员 {store.posOperatorCount} 人</p>
                  </div>
                  <button role="switch" aria-checked={Boolean(store.enabled)} aria-label={`${store.name}甜意卡开关`} disabled={working || locked || !availability.globalEnabled} onClick={() => changeAvailability(`stores/${encodeURIComponent(store.id)}`, !store.enabled, store.enabled ? '关闭后该门店无法进行新的甜意卡核销，历史退款不受影响。' : '启用后该门店拥有 POS 点单权限的账号均可核销甜意卡。')} className={`h-8 shrink-0 rounded-xl px-3 text-[11px] font-black disabled:opacity-45 ${locked ? 'bg-slate-200 text-slate-400' : store.enabled ? 'bg-budu-500 text-white' : 'bg-slate-100 text-slate-500'}`}>
                    {locked ? '锁定' : store.enabled ? '已启用' : '已停用'}
                  </button>
                </div>
              </div>
            )
          })}
        </section>}

        {segment === 'rules' && <section aria-label="核销规则" className="space-y-3">
          <div className="rounded-3xl bg-white p-4 ring-1 ring-slate-100">
            <div className="flex items-center gap-1.5 text-[11px] font-black tracking-wide text-slate-400"><ShieldCheck className="h-3.5 w-3.5 text-budu-500" />当前已排除的商品分类</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {blockedRows.length === 0 && <span className="text-[12px] text-slate-300">未排除任何分类</span>}
              {blockedRows.map((row) => (
                <span key={row.id} className="inline-flex items-center gap-1 rounded-full bg-budu-50 px-2.5 py-1 text-[11px] font-black text-budu-700 ring-1 ring-budu-100">
                  {row.name}
                  <button type="button" aria-label={`移除 ${row.name}`} onClick={() => setBlocked((list) => list.filter((id) => id !== row.id))} className="text-budu-400">×</button>
                </span>
              ))}
            </div>
          </div>

          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />
            <input aria-label="搜索商品分类" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索商品分类" className={`${fieldClass} pl-9`} />
          </label>

          <div className="overflow-hidden rounded-3xl bg-white ring-1 ring-slate-100">
            {filtered.length === 0 && <p className="px-4 py-8 text-center text-[12px] text-slate-400">{categories.length === 0 ? '当前暂无商品分类' : '没有匹配的分类'}</p>}
            {filtered.map((row) => {
              const checked = blocked.includes(row.id)
              return (
                <button key={row.id} type="button" aria-pressed={checked} onClick={() => setBlocked((list) => checked ? list.filter((id) => id !== row.id) : [...list, row.id])} className="flex w-full items-center gap-3 border-b border-slate-50 px-4 py-3 text-left last:border-0">
                  <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border ${checked ? 'border-budu-500 bg-budu-500 text-white' : 'border-slate-200 bg-white'}`}>{checked && <Check className="h-3 w-3" />}</span>
                  <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-slate-800">{row.name}</span>
                  {checked && <span className="shrink-0 text-[10px] font-black text-budu-500">已排除</span>}
                </button>
              )
            })}
          </div>

          <button type="button" disabled={working || !dirty} onClick={saveRules} className="h-12 w-full rounded-2xl bg-budu-500 text-[14px] font-black text-white disabled:opacity-45">{dirty ? '保存核销规则' : '规则已是最新'}</button>
        </section>}

        {segment === 'audit' && <section aria-label="操作审计" className="rounded-3xl bg-white p-4 ring-1 ring-slate-100">
          {auditEntries.length === 0 && <p className="py-8 text-center text-[12px] text-slate-400">暂无审计记录</p>}
          <ol className="relative ml-1.5 border-l border-slate-100">
            {auditEntries.map((entry) => (
              <li key={entry.id} className="relative pb-4 pl-4 last:pb-0">
                <span className="absolute -left-[3.5px] top-1.5 h-1.5 w-1.5 rounded-full bg-budu-400 ring-2 ring-white" aria-hidden="true" />
                <p className="flex flex-wrap items-baseline gap-x-1.5 text-[13px] font-black text-slate-800">
                  <span>{entry.label}</span>
                  {entry.summary && <span className="text-[11px] font-bold text-slate-400">{entry.summary}</span>}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  {entry.actor.text} · {new Date(entry.at).toLocaleString()}
                  {entry.mergedCount > 1 && <span className="text-slate-300"> · 合并 {entry.mergedCount} 条底层记录</span>}
                </p>
              </li>
            ))}
          </ol>
        </section>}
      </div>
    </div>
  )
}
