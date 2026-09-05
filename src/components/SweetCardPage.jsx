import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Download, Gift, LockKeyhole, Plus, RefreshCw, ShieldCheck } from 'lucide-react'
import { api } from '../utils/api'
import { formatCents } from '../utils/pos'
import { hasSweetCardCapability, SWEET_CARD_CAPABILITIES } from '../../shared/accountPermissions'
import {
  SWEET_CARD_BINDING_MODE_OPTIONS,
  SWEET_CARD_CARRIER_TYPE_OPTIONS,
  SWEET_CARD_STATUS_OPTIONS,
  sweetCardBindingModeLabel,
  sweetCardBatchPurposeLabel,
  sweetCardCarrierTypeLabel,
  sweetCardStatusLabel,
} from '../utils/sweetCardLabels'

const tabs = [['overview', '总览'], ['batches', '批次'], ['cards', '卡片'], ['issue', '发卡'], ['rules', '规则'], ['usage', '使用记录'], ['audit', '审计']]
const fieldClass = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-budu-400 focus:ring-2 focus:ring-budu-100'

export default function SweetCardPage({ user, onBack }) {
  const [tab, setTab] = useState('overview')
  const [config, setConfig] = useState(null)
  const [data, setData] = useState({ overview: null, batches: [], cards: [], rules: null, usage: [], audit: [] })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')
  const [viewScope, setViewScope] = useState('COMMERCIAL')
  const [form, setForm] = useState({ name: '', purpose: '', businessPurpose: 'COMMERCIAL', cardCount: 1, faceValueCents: '50000', validityType: 'ONE_YEAR', carrierType: 'PHYSICAL', bindingMode: 'NONE', recipientType: '', recipientLabel: '', recipientCompany: '', recipientNote: '', giftingScenario: '', activateNow: false })
  const [cardFilter, setCardFilter] = useState({ search: '', batchId: '', status: '', faceValueCents: '' })

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const nextConfig = await api('/v2/sweet-cards/config')
      setConfig(nextConfig)
      if (!nextConfig.enabled) return
      const scopeQuery = viewScope === 'ARCHIVED' ? '?businessPurpose=ALL&archived=true' : `?businessPurpose=${viewScope}&archived=false`
      const [overview, batches, cards, rules, usage, audit] = await Promise.all([
        api(`/v2/sweet-cards/overview${scopeQuery}`), api(`/v2/sweet-cards/batches${scopeQuery}`), api(`/v2/sweet-cards/cards${scopeQuery}`), api('/v2/sweet-cards/rules'), api(`/v2/sweet-cards/usage${scopeQuery}`), api('/v2/sweet-cards/audit'),
      ])
      setData({ overview, batches: batches.batches || [], cards: cards.cards || [], rules, usage: usage.redemptions || [], audit: audit.events || [] })
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [viewScope])
  useEffect(() => { load() }, [load])
  const consumed = useMemo(() => data.overview ? BigInt(data.overview.initialAmountCents) - BigInt(data.overview.balanceCents) : 0n, [data.overview])
  const filteredCards = useMemo(() => data.cards.filter((card) => {
    const search = cardFilter.search.trim().toLowerCase()
    return (!search || [card.publicCardNo, card.recipientLabel, card.recipientCompany].some((value) => String(value || '').toLowerCase().includes(search)))
      && (!cardFilter.batchId || card.batchId === cardFilter.batchId)
      && (!cardFilter.status || card.status === cardFilter.status)
      && (!cardFilter.faceValueCents || card.initialAmountCents === cardFilter.faceValueCents)
  }), [cardFilter, data.cards])

  const createBatch = async (event) => {
    event.preventDefault(); setSaving(true); setError('')
    try {
      await api('/v2/sweet-cards/batches', { method: 'POST', body: JSON.stringify({ ...form, cardCount: Number(form.cardCount) }) })
      setForm((value) => ({ ...value, name: '', purpose: '', recipientType: '', recipientLabel: '', recipientCompany: '', recipientNote: '', giftingScenario: '' }))
      await load(); setTab('batches')
    } catch (e) { setError(e.message) } finally { setSaving(false) }
  }

  const saveRules = async () => {
    setSaving(true); setError('')
    try {
      await api('/v2/sweet-cards/rules', { method: 'PUT', body: JSON.stringify({
        eligibleStoreIds: data.rules.stores.filter((row) => row.eligible).map((row) => row.id),
        blockedCategoryIds: data.rules.categories.filter((row) => row.blocked).map((row) => row.id),
      }) }); await load()
    } catch (e) { setError(e.message) } finally { setSaving(false) }
  }

  const transition = async (id, action) => { setSaving(true); setError(''); try { await api(`/v2/sweet-cards/cards/${id}/${action}`, { method: 'POST' }); await load() } catch (e) { setError(e.message) } finally { setSaving(false) } }
  const archiveBatch = async (id, archived) => {
    if (archived && !window.confirm('归档后该批次将从日常运营列表隐藏，但不会删除卡片、余额、Ledger、订单或退款记录。')) return
    setSaving(true); setError('')
    try { await api(`/v2/sweet-cards/batches/${id}/${archived ? 'archive' : 'restore'}`, { method: 'POST', body: JSON.stringify({}) }); await load() }
    catch (e) { setError(e.message) } finally { setSaving(false) }
  }
  const voidCard = async (id) => {
    if (!window.confirm('作废后该卡将不能继续使用，当前 credential 会被撤销；余额、Ledger、订单和退款记录不会被删除。确认作废这张甜意卡？')) return
    setDetail(null)
    await transition(id, 'void')
  }
  const openDetail = async (id) => { setError(''); try { const result = await api(`/v2/sweet-cards/cards/${id}`); setDetail(result.card) } catch (e) { setError(e.message) } }
  const bindCard = async (id) => { const memberId = window.prompt('请输入已验证的 Member.id'); if (!memberId) return; setSaving(true); try { await api(`/v2/sweet-cards/cards/${id}/bind`, { method: 'POST', body: JSON.stringify({ memberId }) }); setDetail(null); await load() } catch (e) { setError(e.message) } finally { setSaving(false) } }
  const credentialAction = async (id, action) => { if (!window.confirm(action === 'lost' ? '确认挂失并永久撤销当前 credential？' : '确认生成补发 credential？价值账户、余额与历史不移动。')) return; setSaving(true); try { await api(`/v2/sweet-cards/cards/${id}/${action}`, { method: 'POST' }); setDetail(null); await load() } catch (e) { setError(e.message) } finally { setSaving(false) } }
  const toggleRule = (kind, id) => setData((current) => ({ ...current, rules: { ...current.rules, [kind]: current.rules[kind].map((row) => row.id === id ? { ...row, [kind === 'stores' ? 'eligible' : 'blocked']: !(kind === 'stores' ? row.eligible : row.blocked) } : row) } }))

  return <div className="min-h-full bg-slate-50 px-3 pb-28 pt-3 sm:px-6 sm:pt-6">
    <div className="mx-auto max-w-6xl">
      <header className="flex items-center gap-3 rounded-3xl border border-rose-100 bg-white p-4 shadow-sm sm:p-6">
        <button onClick={onBack} className="grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-slate-500" aria-label="返回"><ArrowLeft className="h-5 w-5" /></button>
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-budu-50 text-budu-600"><Gift className="h-6 w-6" /></div>
        <div className="min-w-0"><h1 className="text-xl font-black text-slate-900">budu 甜意卡</h1><p className="truncate text-xs font-semibold tracking-[0.16em] text-budu-500">A LITTLE SWEETNESS.</p></div>
        <button onClick={load} className="ml-auto grid h-10 w-10 place-items-center rounded-xl border border-slate-200 text-slate-500" aria-label="刷新"><RefreshCw className="h-4 w-4" /></button>
      </header>
      {error && <div className="mt-4 rounded-2xl bg-rose-50 p-4 text-sm text-rose-700">{error}</div>}
      {loading ? <div className="mt-6 rounded-3xl bg-white p-10 text-center text-sm text-slate-400">正在读取甜意卡权威数据…</div> : config?.enabled !== true ? <div className="mt-6 rounded-3xl border border-amber-200 bg-amber-50 p-8 text-center"><LockKeyhole className="mx-auto h-9 w-9 text-amber-500" /><h2 className="mt-3 font-black text-slate-800">Production capability 当前关闭</h2><p className="mt-2 text-sm text-slate-500">Candidate 已保留完整能力；开启前不会创建或核销任何真实价值。</p></div> : <>
        <nav className="mt-4 flex gap-2 overflow-x-auto pb-2">{tabs.map(([key, label]) => <button key={key} onClick={() => setTab(key)} className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold ${tab === key ? 'bg-budu-500 text-white' : 'bg-white text-slate-500 shadow-sm'}`}>{label}</button>)}</nav>
        {['overview', 'batches', 'cards', 'usage'].includes(tab) && <div className="mt-2 flex gap-2 overflow-x-auto" aria-label="甜意卡运营视图">{[['COMMERCIAL', '商业运营'], ['ACCEPTANCE_TEST', '测试/验收'], ['ARCHIVED', '已归档']].map(([key, label]) => <button key={key} type="button" aria-pressed={viewScope === key} onClick={() => { setViewScope(key); setCardFilter((value) => ({ ...value, batchId: '' })) }} className={`min-h-10 shrink-0 rounded-xl px-4 text-xs font-bold ${viewScope === key ? 'bg-slate-800 text-white' : 'bg-white text-slate-500 shadow-sm'}`}>{label}</button>)}</div>}
        {tab === 'overview' && data.overview && <section className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">{[
          ['已创建', data.overview.count], ['已激活', data.overview.statusCounts.ACTIVE || 0], ['未激活', data.overview.statusCounts.CREATED || 0], ['已发放', data.overview.issued || 0],
          ['已用尽', data.overview.statusCounts.EXHAUSTED || 0], ['已冻结', data.overview.statusCounts.FROZEN || 0], ['已挂失', data.overview.statusCounts.LOST || 0], ['已过期', data.overview.statusCounts.EXPIRED || 0],
          ['总发行额度', formatCents(data.overview.initialAmountCents)], ['已消费额度', formatCents(consumed)], ['剩余余额', formatCents(data.overview.balanceCents)],
        ].map(([label, value]) => <div key={label} className="rounded-3xl bg-white p-5 shadow-sm"><p className="text-xs font-semibold text-slate-400">{label}</p><p className="mt-2 break-words text-2xl font-black text-slate-900">{value}</p></div>)}</section>}
        {tab === 'batches' && <section className="mt-4 space-y-3">{data.batches.map((batch) => <article key={batch.id} className="rounded-3xl bg-white p-5 shadow-sm"><div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap gap-2"><span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black text-slate-500">{sweetCardBatchPurposeLabel(batch.businessPurpose)}</span>{batch.archivedAt && <span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-black text-amber-700">已归档</span>}</div><h3 className="mt-2 font-black text-slate-900">{batch.name}</h3><p className="mt-1 text-xs text-slate-400">{batch.cardCount} 张 · {formatCents(batch.faceValueCents)} · {sweetCardCarrierTypeLabel(batch.carrierType)} · {sweetCardBindingModeLabel(batch.bindingMode)}</p></div><a href={`/api/v2/sweet-cards/batches/${batch.id}/export`} className="inline-flex items-center gap-1 rounded-xl border border-budu-200 px-3 py-2 text-xs font-bold text-budu-600"><Download className="h-4 w-4" />QR 包</a></div><div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs"><span className="rounded-xl bg-slate-50 p-2">已激活 {batch.metrics.activated}</span><span className="rounded-xl bg-slate-50 p-2">已消费 {formatCents(batch.metrics.consumedCents)}</span><span className="rounded-xl bg-slate-50 p-2">余额 {formatCents(batch.metrics.balanceCents)}</span></div>{hasSweetCardCapability(user, SWEET_CARD_CAPABILITIES.MANAGE) && <details className="mt-3 border-t border-slate-100 pt-3 text-xs"><summary className="cursor-pointer select-none font-bold text-slate-500">批次操作</summary><button type="button" disabled={saving} onClick={() => archiveBatch(batch.id, !batch.archivedAt)} className="mt-3 min-h-10 rounded-xl border border-slate-200 px-3 font-bold text-slate-600 disabled:opacity-50">{batch.archivedAt ? '恢复归档' : '归档批次'}</button></details>}</article>)}</section>}
        {tab === 'cards' && <section className="mt-4">
          <div className="grid gap-2 rounded-3xl bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-4">
            <input aria-label="搜索卡号或赠送对象" placeholder="搜索卡号 / 赠送对象" value={cardFilter.search} onChange={(e) => setCardFilter({ ...cardFilter, search: e.target.value })} className={fieldClass} />
            <select aria-label="按批次筛选" value={cardFilter.batchId} onChange={(e) => setCardFilter({ ...cardFilter, batchId: e.target.value })} className={fieldClass}><option value="">全部批次</option>{data.batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.name}</option>)}</select>
            <select aria-label="按状态筛选" value={cardFilter.status} onChange={(e) => setCardFilter({ ...cardFilter, status: e.target.value })} className={fieldClass}><option value="">全部状态</option>{SWEET_CARD_STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            <select aria-label="按面额筛选" value={cardFilter.faceValueCents} onChange={(e) => setCardFilter({ ...cardFilter, faceValueCents: e.target.value })} className={fieldClass}><option value="">全部面额</option>{[...new Set(data.cards.map((card) => card.initialAmountCents))].map((amount) => <option key={amount} value={amount}>{formatCents(amount)}</option>)}</select>
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">{filteredCards.map((card) => <article key={card.id} className="rounded-3xl bg-white p-5 shadow-sm"><div className="flex justify-between gap-3"><div><h3 className="font-black text-slate-900">{card.publicCardNo}</h3><p className="mt-1 text-xs text-slate-400">{sweetCardCarrierTypeLabel(card.carrierType)} · {sweetCardBindingModeLabel(card.bindingMode)} · {sweetCardStatusLabel(card.status)}</p></div><p className="text-xl font-black text-budu-600">{formatCents(card.balanceCents)}</p></div>{card.recipientLabel && <p className="mt-3 text-sm text-slate-600">赠予：{card.recipientLabel}</p>}<div className="mt-4 flex flex-wrap gap-2"><button onClick={() => openDetail(card.id)} className="rounded-xl border border-budu-200 px-3 py-2 text-xs font-bold text-budu-600">详情 / Ledger</button>{card.status === 'CREATED' && <button disabled={saving} onClick={() => transition(card.id, 'activate')} className="rounded-xl bg-budu-500 px-3 py-2 text-xs font-bold text-white">激活</button>}{card.status === 'ACTIVE' && <button disabled={saving} onClick={() => transition(card.id, 'freeze')} className="rounded-xl border px-3 py-2 text-xs font-bold text-slate-600">冻结</button>}{card.status === 'FROZEN' && <button disabled={saving} onClick={() => transition(card.id, 'unfreeze')} className="rounded-xl border px-3 py-2 text-xs font-bold text-slate-600">解冻</button>}</div></article>)}</div>
          {filteredCards.length === 0 && <p className="mt-3 rounded-3xl bg-white p-8 text-center text-sm text-slate-400">没有符合条件的卡片</p>}
        </section>}
        {tab === 'issue' && <form onSubmit={createBatch} className="mt-4 rounded-3xl bg-white p-5 shadow-sm sm:p-7">
          <h2 className="text-lg font-black text-slate-900">创建批次</h2>
          <div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => setForm({ ...form, faceValueCents: '50000' })} className="rounded-full bg-budu-50 px-4 py-2 text-sm font-bold text-budu-600">¥500</button><button type="button" onClick={() => setForm({ ...form, faceValueCents: '100000' })} className="rounded-full bg-budu-50 px-4 py-2 text-sm font-bold text-budu-600">¥1000</button><span className="self-center text-xs text-slate-400">或输入合法自定义额度</span></div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="text-xs font-bold text-slate-500">批次名称<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`${fieldClass} mt-1`} /></label>
            <label className="text-xs font-bold text-slate-500">批次用途<select required value={form.businessPurpose} onChange={(e) => setForm({ ...form, businessPurpose: e.target.value })} className={`${fieldClass} mt-1`}><option value="COMMERCIAL">商业运营</option><option value="ACCEPTANCE_TEST">验收 / 测试</option></select></label>
            <label className="text-xs font-bold text-slate-500 sm:col-span-2">用途说明（可选）<input value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} className={`${fieldClass} mt-1`} /></label>
            <label className="text-xs font-bold text-slate-500">数量<input type="number" min="1" max="500" value={form.cardCount} onChange={(e) => setForm({ ...form, cardCount: e.target.value })} className={`${fieldClass} mt-1`} /></label>
            <label className="text-xs font-bold text-slate-500">面额（分）<input type="number" min="1" value={form.faceValueCents} onChange={(e) => setForm({ ...form, faceValueCents: e.target.value })} className={`${fieldClass} mt-1`} /></label>
            <label className="text-xs font-bold text-slate-500">有效期<select value={form.validityType} onChange={(e) => setForm({ ...form, validityType: e.target.value })} className={`${fieldClass} mt-1`}><option value="ONE_YEAR">1 年</option><option value="THREE_YEARS">3 年</option><option value="LONG_TERM">长期</option></select></label>
            <label className="text-xs font-bold text-slate-500">载体<select value={form.carrierType} onChange={(e) => setForm({ ...form, carrierType: e.target.value })} className={`${fieldClass} mt-1`}>{SWEET_CARD_CARRIER_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="text-xs font-bold text-slate-500">绑定模式<select value={form.bindingMode} onChange={(e) => setForm({ ...form, bindingMode: e.target.value })} className={`${fieldClass} mt-1`}>{SWEET_CARD_BINDING_MODE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="text-xs font-bold text-slate-500">赠送对象类型（可选）<input value={form.recipientType} onChange={(e) => setForm({ ...form, recipientType: e.target.value })} className={`${fieldClass} mt-1`} /></label>
            <label className="text-xs font-bold text-slate-500">赠送对象<input value={form.recipientLabel} onChange={(e) => setForm({ ...form, recipientLabel: e.target.value })} className={`${fieldClass} mt-1`} /></label>
            <label className="text-xs font-bold text-slate-500">公司（可选）<input value={form.recipientCompany} onChange={(e) => setForm({ ...form, recipientCompany: e.target.value })} className={`${fieldClass} mt-1`} /></label>
            <label className="text-xs font-bold text-slate-500">赠送场景（可选）<input value={form.giftingScenario} onChange={(e) => setForm({ ...form, giftingScenario: e.target.value })} className={`${fieldClass} mt-1`} /></label>
            <label className="text-xs font-bold text-slate-500">备注（可选）<input value={form.recipientNote} onChange={(e) => setForm({ ...form, recipientNote: e.target.value })} className={`${fieldClass} mt-1`} /></label>
          </div>
          {form.carrierType === 'ELECTRONIC' && <label className="mt-4 flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={form.activateNow} onChange={(e) => setForm({ ...form, activateNow: e.target.checked })} />创建后立即激活</label>}
          <button disabled={saving} className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-budu-500 py-3.5 font-bold text-white disabled:opacity-50"><Plus className="h-5 w-5" />{saving ? '创建中…' : '创建甜意卡批次'}</button>
        </form>}
        {tab === 'rules' && data.rules && <section className="mt-4 grid gap-4 lg:grid-cols-2"><div className="rounded-3xl bg-white p-5 shadow-sm"><h2 className="font-black">可核销直营门店</h2><p className="mt-1 text-xs text-slate-400">默认拒绝；只认 Store.key 策略。</p><div className="mt-4 space-y-2">{data.rules.stores.map((row) => <label key={row.id} className="flex items-center justify-between rounded-xl bg-slate-50 p-3 text-sm"><span>{row.name}</span><input type="checkbox" checked={row.eligible} onChange={() => toggleRule('stores', row.id)} /></label>)}</div></div><div className="rounded-3xl bg-white p-5 shadow-sm"><h2 className="font-black">不可使用商品分类</h2><p className="mt-1 text-xs text-slate-400">规则保存 ProductCategory.id，名称仅展示。</p><div className="mt-4 space-y-2">{data.rules.categories.map((row) => <label key={row.id} className="flex items-center justify-between rounded-xl bg-slate-50 p-3 text-sm"><span>{row.name}</span><input type="checkbox" checked={row.blocked} onChange={() => toggleRule('categories', row.id)} /></label>)}</div></div><button disabled={saving} onClick={saveRules} className="rounded-2xl bg-budu-500 py-3.5 font-bold text-white lg:col-span-2">保存规则</button></section>}
        {tab === 'usage' && <section className="mt-4 overflow-hidden rounded-3xl bg-white shadow-sm"><div className="border-b p-5"><h2 className="font-black">使用记录</h2><p className="mt-1 text-xs text-slate-400">订单销售与甜意卡核销依旧分别保留各自权威事实。</p></div><div className="divide-y">{data.usage.map((row) => <article key={row.id} className="p-4 text-sm"><div className="flex justify-between gap-3"><strong className="min-w-0 truncate text-slate-800">{row.publicCardNo} · {row.orderNo}</strong><strong className="shrink-0 text-budu-600">-{formatCents(row.amountCents)}</strong></div><p className="mt-1 text-xs text-slate-400">{row.storeId} · {row.redeemedByName || '未记录操作人'} · {new Date(row.createdAt).toLocaleString()}</p></article>)}{data.usage.length === 0 && <p className="p-8 text-center text-sm text-slate-400">暂无核销记录</p>}</div></section>}
        {tab === 'audit' && <section className="mt-4 overflow-hidden rounded-3xl bg-white shadow-sm"><div className="flex items-center gap-2 border-b p-5"><ShieldCheck className="h-5 w-5 text-budu-500" /><h2 className="font-black">安全审计</h2></div><div className="divide-y">{data.audit.map((event) => <div key={event.id} className="p-4 text-sm"><div className="flex justify-between gap-3"><strong className="text-slate-700">{event.action}</strong><time className="shrink-0 text-xs text-slate-400">{new Date(event.createdAt).toLocaleString()}</time></div><p className="mt-1 text-xs text-slate-400">{event.actorName || event.actorId || 'system'}</p></div>)}</div></section>}
      </>}
    </div>
    {detail && <div className="fixed inset-0 z-[120] flex items-end bg-slate-950/60 backdrop-blur-sm sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-label="甜意卡详情">
      <div className="max-h-[92dvh] w-full overflow-y-auto rounded-t-[30px] bg-white p-5 shadow-2xl sm:max-w-2xl sm:rounded-[30px]" style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}>
        <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-black tracking-widest text-budu-500">A LITTLE SWEETNESS.</p><h2 className="mt-1 text-xl font-black">{detail.publicCardNo}</h2></div><button onClick={() => setDetail(null)} className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-bold text-slate-500">关闭</button></div>
        <div className="mt-5 grid grid-cols-2 gap-2 text-sm">
          <p className="rounded-xl bg-slate-50 p-3">初始额度<br/><strong>{formatCents(detail.initialAmountCents)}</strong></p><p className="rounded-xl bg-slate-50 p-3">当前余额<br/><strong>{formatCents(detail.balanceCents)}</strong></p>
          <p className="rounded-xl bg-slate-50 p-3">状态<br/><strong>{sweetCardStatusLabel(detail.status)}</strong></p><p className="rounded-xl bg-slate-50 p-3">载体 / 绑定模式<br/><strong>{sweetCardCarrierTypeLabel(detail.carrierType)} / {sweetCardBindingModeLabel(detail.bindingMode)}</strong></p>
          <p className="rounded-xl bg-slate-50 p-3">批次<br/><strong>{detail.batchId || '无批次'}</strong></p><p className="rounded-xl bg-slate-50 p-3">绑定<br/><strong>{detail.binding ? detail.binding.memberId : '未绑定'}</strong></p>
          <p className="rounded-xl bg-slate-50 p-3">有效期<br/><strong>{detail.expiresAt ? new Date(detail.expiresAt).toLocaleDateString() : '长期 / 待激活'}</strong></p><p className="rounded-xl bg-slate-50 p-3">Credential<br/><strong>{(detail.credentials || []).map((row) => row.status).join(' / ') || '无'}</strong></p>
        </div>
        <div className="mt-3 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600"><p>赠送对象：{detail.recipientLabel || '—'}</p><p className="mt-1">赠送场景：{detail.giftingScenario || '—'}</p><p className="mt-1">创建/发放：{detail.issuedByName || '—'} · {detail.issuedAt ? new Date(detail.issuedAt).toLocaleString() : '—'}</p></div>
        <div className="mt-4 flex flex-wrap gap-2">{detail.bindingMode !== 'NONE' && !detail.binding && <button onClick={() => bindCard(detail.id)} className="rounded-xl bg-budu-500 px-3 py-2 text-xs font-bold text-white">绑定已验证客户</button>}{detail.binding && ['ACTIVE', 'FROZEN'].includes(detail.status) && <button onClick={() => credentialAction(detail.id, 'lost')} className="rounded-xl border border-rose-200 px-3 py-2 text-xs font-bold text-rose-600">挂失 credential</button>}{detail.binding && detail.status === 'LOST' && <button onClick={() => credentialAction(detail.id, 'replace')} className="rounded-xl bg-budu-500 px-3 py-2 text-xs font-bold text-white">补发 credential</button>}{detail.carrierType === 'ELECTRONIC' && <a href={`/api/v2/sweet-cards/cards/${detail.id}/presentation`} className="rounded-xl border border-budu-200 px-3 py-2 text-xs font-bold text-budu-600">电子卡展示稿</a>}</div>
        {hasSweetCardCapability(user, SWEET_CARD_CAPABILITIES.VOID) && !['VOID', 'EXHAUSTED', 'EXPIRED'].includes(detail.status) && <details className="mt-5 border-t border-slate-100 pt-4 text-xs"><summary className="cursor-pointer select-none font-bold text-slate-500">卡片危险操作</summary><button type="button" disabled={saving} onClick={() => voidCard(detail.id)} className="mt-3 min-h-10 rounded-xl border border-rose-200 px-3 font-bold text-rose-600 disabled:opacity-50">作废甜意卡</button></details>}
        <h3 className="mt-6 font-black">Ledger / Timeline</h3><div className="mt-2 divide-y rounded-2xl border">{(detail.ledger || []).map((entry) => <div key={entry.id} className="flex justify-between gap-3 p-3 text-xs"><span><strong>{entry.type}</strong><br/><span className="text-slate-400">{new Date(entry.createdAt).toLocaleString()}</span></span><span className="text-right font-mono">{entry.amountCents}<br/><span className="text-slate-400">余额 {entry.balanceAfterCents}</span></span></div>)}</div>
      </div>
    </div>}
  </div>
}
