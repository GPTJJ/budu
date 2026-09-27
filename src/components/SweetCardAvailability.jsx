import { useEffect, useState } from 'react'
import { api } from '../utils/api'
import { sweetCardStoreTypeLabel } from '../utils/sweetCardLabels'

export default function SweetCardAvailability() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const load = () => api('/v2/sweet-cards/availability').then(setData).catch(e => setError(e.message))
  useEffect(() => { load() }, [])
  const change = async (path, enabled, message) => {
    if (!window.confirm(message)) return
    setSaving(true); setError('')
    try { setData(await api(`/v2/sweet-cards/availability/${path}`, { method: 'PUT', body: JSON.stringify({ enabled }) })) }
    catch (e) { setError(e.message); await load() }
    finally { setSaving(false) }
  }
  if (!data) return <p className="p-5 text-sm text-slate-500" role="status">{error || '正在读取可用门店…'}</p>
  const direct = data.stores.filter(s => s.configurable)
  return <section className="mt-4 space-y-4" aria-label="可用门店">
    <div className="rounded-3xl bg-white p-5 shadow-sm">
      <p className="text-xs font-bold text-budu-600">设置 · 可用门店</p>
      <h2 className="mt-2 text-xl font-black text-slate-900">甜意卡可用门店</h2>
      <div className="mt-4 flex flex-wrap gap-3 text-sm"><strong>甜意卡总开关：{data.globalEnabled ? '已开启' : '已关闭'}</strong><span>直营门店：{direct.length} 家</span><span>甜意卡已启用：{direct.filter(s => s.enabled).length} 家</span></div>
      <p className="mt-3 text-sm leading-6 text-slate-500">启用门店后，拥有该店 POS 点单权限的账号即可核销。门店或总开关停用后，历史订单退款仍可正常办理。</p>
      {!data.globalEnabled && <button disabled={saving || !data.runtimeEnabled} onClick={() => change('global', true, '开启后，各门店将按照之前保存的门店开关恢复新的甜意卡核销。确认开启？')} className="mt-4 min-h-11 rounded-xl bg-budu-500 px-4 font-bold text-white disabled:opacity-50">开启甜意卡核销</button>}
    </div>
    {error && <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-700">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button disabled={saving} onClick={() => change('all-direct', true, `即将启用 ${direct.length} 家直营门店的甜意卡核销能力。启用后，这些门店拥有 POS 点单权限的账号将自动可以核销甜意卡。`)} className="min-h-11 rounded-xl bg-budu-500 px-4 text-sm font-bold text-white disabled:opacity-50">全部直营店启用</button>
      <button disabled={saving} onClick={() => change('all-direct', false, `即将停用 ${direct.length} 家直营门店的新甜意卡核销。历史已完成订单的退款不受影响。`)} className="min-h-11 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-600 disabled:opacity-50">全部直营店停用</button>
      <button disabled={saving} onClick={load} className="min-h-11 rounded-xl border border-slate-200 bg-white px-4 text-sm text-slate-600">刷新状态</button>
    </div>
    <div className="grid gap-3 lg:grid-cols-2">{data.stores.map(store => <article key={store.id} className="rounded-3xl bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words font-black text-slate-900">{store.name}</h3><p className="mt-2 text-xs text-slate-500">{sweetCardStoreTypeLabel(store.operationType)} · {store.active ? '营业中' : '门店停用'}</p></div>
        <button role="switch" aria-checked={store.enabled} aria-label={`${store.name}甜意卡开关`} disabled={saving || !store.configurable} onClick={() => change(`stores/${encodeURIComponent(store.id)}`, !store.enabled, store.enabled ? '关闭后，该门店将无法进行新的甜意卡核销。历史已完成订单的退款不受影响。' : '启用后，该门店所有拥有正式 POS 点单权限的账号均可进行新的甜意卡核销。')} className={`min-h-11 shrink-0 rounded-xl px-4 text-sm font-bold disabled:opacity-50 ${store.enabled ? 'bg-budu-500 text-white' : 'bg-slate-100 text-slate-500'}`}>{!store.configurable ? '锁定' : store.enabled ? '已启用' : '已停用'}</button></div>
      <p className="mt-4 text-sm font-semibold text-slate-700">甜意卡：{!store.configurable ? '不可用' : !data.globalEnabled ? '总开关已关闭' : store.enabled ? '已启用' : '已停用'}</p>
      <p className="mt-2 text-sm text-slate-500">POS 操作员：{store.posOperatorCount} 人</p>
    </article>)}</div>
    <div className="rounded-3xl border border-rose-200 bg-rose-50 p-5"><h3 className="font-bold text-rose-800">紧急停用</h3><p className="mt-2 text-sm leading-6 text-rose-700">停止所有门店新的甜意卡核销，保留门店配置与历史退款能力。</p><button disabled={saving || !data.globalEnabled} onClick={() => change('global', false, '确认紧急停用全部甜意卡核销？所有门店将停止新的甜意卡核销，门店配置保留，历史订单退款不受影响。')} className="mt-4 min-h-11 rounded-xl bg-rose-700 px-4 text-sm font-bold text-white disabled:opacity-50">紧急停用全部甜意卡核销</button></div>
  </section>
}
