import SweetCardDelivery from './SweetCardDelivery'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight, Download, Gift, LayoutGrid, List, LockKeyhole, Plus, ReceiptText, RefreshCw, Settings2, ShieldCheck } from 'lucide-react'
import SweetCardAvailability from './SweetCardAvailability'
import SweetCardCreateWizard from './sweet-card/SweetCardCreateWizard'
import SweetCardSuccess from './sweet-card/SweetCardSuccess'
import { api } from '../utils/api'
import { formatCents } from '../utils/pos'
import { hasSweetCardCapability, SWEET_CARD_CAPABILITIES } from '../../shared/accountPermissions'
import {
  SWEET_CARD_BINDING_MODE_OPTIONS,
  SWEET_CARD_CARRIER_TYPE_OPTIONS,
  SWEET_CARD_STATUS_OPTIONS,
  sweetCardBindingModeLabel,
  sweetCardBindingStatusLabel,
  sweetCardBatchPurposeLabel,
  sweetCardCarrierTypeLabel,
  sweetCardClaimCredentialStatusLabel,
  sweetCardClaimGenerationErrorLabel,
  sweetCardClaimStatusLabel,
  sweetCardCredentialStatusLabel,
  sweetCardDeliveryStatusLabel,
  sweetCardActivationStatusLabel,
  sweetCardLedgerTypeLabel,
  sweetCardPresentationStatusLabel,
  sweetCardStatusLabel,
} from '../utils/sweetCardLabels'

// Scheme B 一级核心导航（使用记录/审计下沉，规则/设置并入管理设置）
const PRIMARY_TABS = [['overview', '总览'], ['batches', '批次'], ['cards', '卡片'], ['issue', '创建并发卡']]
const MANAGE_SECTIONS = [['rules', '规则'], ['settings', '设置'], ['audit', '审计日志']]
const VIEW_SCOPES = [['COMMERCIAL', '商业运营'], ['ACCEPTANCE_TEST', '测试/验收'], ['ARCHIVED', '已归档']]
const fieldClass = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-budu-400 focus:ring-2 focus:ring-budu-100'
const labelClass = 'text-xs font-bold text-slate-500'

const INITIAL_FORM = { name: '', purpose: '', businessPurpose: 'COMMERCIAL', cardCount: 1, faceValueYuan: '500.00', validityType: 'ONE_YEAR', carrierType: 'PHYSICAL', bindingMode: 'NONE', recipientType: '', recipientLabel: '', recipientCompany: '', recipientNote: '', giftingScenario: '', activateNow: false }

export default function SweetCardPage({ user, onBack }) {
  const [tab, setTab] = useState('overview')
  const [manageSection, setManageSection] = useState('rules')
  const [usageOpen, setUsageOpen] = useState(false)
  const [config, setConfig] = useState(null)
  const [data, setData] = useState({ overview: null, batches: [], cards: [], rules: null, usage: [], audit: [] })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [detail, setDetail] = useState(null)
  const [claimDelivery, setClaimDelivery] = useState(null)
  const [claimGeneration, setClaimGeneration] = useState({ status: 'IDLE', message: '' })
  const [error, setError] = useState('')
  const [viewScope, setViewScope] = useState('COMMERCIAL')
  const [form, setForm] = useState(INITIAL_FORM)
  const [issueResult, setIssueResult] = useState(null)
  const [presentationForm, setPresentationForm] = useState({ recipientType: '', recipientLabel: '', recipientCompany: '', giftingScenario: '', recipientNote: '' })
  const [cardFilter, setCardFilter] = useState({ search: '', batchId: '', status: '', faceValueCents: '' })
  const issueAttemptRef = useRef(null)
  const [batchFilter, setBatchFilter] = useState('')
  const [cardView, setCardView] = useState('card')

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
  const batchNames = useMemo(() => Object.fromEntries(data.batches.map((batch) => [batch.id, batch.name])), [data.batches])
  const filteredBatches = useMemo(() => {
    const query = batchFilter.trim().toLowerCase()
    if (!query) return data.batches
    return data.batches.filter((batch) => String(batch.name || '').toLowerCase().includes(query))
  }, [batchFilter, data.batches])
  const filteredCards = useMemo(() => data.cards.filter((card) => {
    const search = cardFilter.search.trim().toLowerCase()
    return (!search || [card.publicCardNo, card.recipientLabel, card.recipientCompany].some((value) => String(value || '').toLowerCase().includes(search)))
      && (!cardFilter.batchId || card.batchId === cardFilter.batchId)
      && (!cardFilter.status || card.status === cardFilter.status)
      && (!cardFilter.faceValueCents || card.initialAmountCents === cardFilter.faceValueCents)
  }), [cardFilter, data.cards])

  const createBatch = async () => {
    setSaving(true); setError('')
    try {
      const payload = { ...form, cardCount: Number(form.cardCount) }
      const payloadIdentity = JSON.stringify(payload)
      if (!issueAttemptRef.current) {
        issueAttemptRef.current = { requestKey: crypto.randomUUID(), payloadIdentity }
      }
      const result = await api('/v2/sweet-cards/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': issueAttemptRef.current.requestKey },
        body: payloadIdentity,
      })
      issueAttemptRef.current = null
      setIssueResult(result)
      await load()
    } catch (e) { setError(e.message) } finally { setSaving(false) }
  }
  const continueIssue = () => {
    issueAttemptRef.current = null
    setIssueResult(null)
    setForm(INITIAL_FORM)
    setCardFilter((value) => ({ ...value, batchId: '', status: '', faceValueCents: '', search: '' }))
  }

  const saveRules = async () => {
    setSaving(true); setError('')
    try {
      await api('/v2/sweet-cards/rules', { method: 'PUT', body: JSON.stringify({
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
  const applyDetail = (card) => {
    setDetail(card)
    setPresentationForm({
      recipientType: card.recipientType || '', recipientLabel: card.recipientLabel || '',
      recipientCompany: card.recipientCompany || '', giftingScenario: card.giftingScenario || '',
      recipientNote: card.recipientNote || '',
    })
  }
  const openDetail = async (id) => {
    setError(''); setClaimDelivery(null); setClaimGeneration({ status: 'IDLE', message: '' })
    try { const result = await api(`/v2/sweet-cards/cards/${id}`); applyDetail(result.card) } catch (e) { setError(e.message) }
  }
  const refreshDetail = async () => {
    if (!detail?.id) return
    const result = await api(`/v2/sweet-cards/cards/${detail.id}`)
    applyDetail(result.card)
  }
  const savePresentation = async (event) => {
    event.preventDefault(); setSaving(true); setError('')
    try {
      await api(`/v2/sweet-cards/cards/${detail.id}/presentation`, { method: 'PUT', body: JSON.stringify(presentationForm) })
      await refreshDetail()
    } catch (e) { setError(e.message) } finally { setSaving(false) }
  }
  const bindCard = async (id) => { const memberId = window.prompt('请输入已验证的 Member.id'); if (!memberId) return; setSaving(true); try { await api(`/v2/sweet-cards/cards/${id}/bind`, { method: 'POST', body: JSON.stringify({ memberId }) }); setDetail(null); await load() } catch (e) { setError(e.message) } finally { setSaving(false) } }
  const credentialAction = async (id, action) => { if (!window.confirm(action === 'lost' ? '确认挂失并永久撤销当前 credential？' : '确认生成补发 credential？价值账户、余额与历史不移动。')) return; setSaving(true); try { await api(`/v2/sweet-cards/cards/${id}/${action}`, { method: 'POST' }); setDetail(null); await load() } catch (e) { setError(e.message) } finally { setSaving(false) } }
  const activateDelivery = async () => {
    if (!window.confirm('激活后卡片将进入可使用状态。确认激活并准备发放？')) return
    setSaving(true); setError('')
    try { await api(`/v2/sweet-cards/cards/${detail.id}/activate-delivery`, { method: 'POST' }); await refreshDetail(); await load() }
    catch (e) { setError(e.message) } finally { setSaving(false) }
  }
  const generateClaimPresentation = async (carrierType) => {
    const reissue = detail?.delivery?.claimCredentialStatus === 'ACTIVE'
    const message = reissue
      ? '重新生成会撤销当前未使用的领取凭证，旧二维码将失效。原 POS 使用码和余额不受影响。确认继续？'
      : '已核验领取人/持卡人，并确认领取图片与独立领取凭证将通过不同渠道交付？'
    if (!window.confirm(message)) return
    setSaving(true); setClaimGeneration({ status: 'GENERATING', message: '正在生成电子卡…' })
    try {
      const result = await api(`/v2/sweet-cards/cards/${detail.id}/claim-presentation`, { method: 'POST', body: JSON.stringify({ carrierType, holderVerificationConfirmed: true, separateProofDelivery: true, reissueConfirmed: reissue }) })
      setClaimDelivery(result)
      setClaimGeneration({ status: 'SUCCESS', message: '电子卡已生成' })
      try { await refreshDetail() } catch { setClaimGeneration({ status: 'SUCCESS', message: '电子卡已生成；状态刷新失败，请稍后手动刷新。' }) }
    } catch (e) {
      setClaimGeneration({ status: 'ERROR', message: sweetCardClaimGenerationErrorLabel(e) })
    } finally { setSaving(false) }
  }
  const copyClaimProof = async () => {
    const proof = claimDelivery?.proofDelivery?.proof
    if (!proof) return
    await navigator.clipboard.writeText(proof)
    setClaimDelivery((value) => ({ ...value, proofCopied: true, proofDelivery: { ...value.proofDelivery, proof: '' } }))
  }
  const revokeClaimPresentation = async () => {
    if (!window.confirm('撤销后旧领取图片不能再建立 ownership；原 POS 核销二维码不受影响。确认撤销？')) return
    setSaving(true); setError('')
    try {
      await api(`/v2/sweet-cards/cards/${detail.id}/claim-presentation/revoke`, { method: 'POST', body: JSON.stringify({}) })
      setClaimDelivery((value) => value ? { ...value, claimAsset: { ...value.claimAsset, state: 'REVOKED' }, proofDelivery: { ...value.proofDelivery, proof: '' } } : value)
      await refreshDetail()
    } catch (e) { setError(e.message) } finally { setSaving(false) }
  }
  const toggleRule = (kind, id) => setData((current) => ({ ...current, rules: { ...current.rules, [kind]: current.rules[kind].map((row) => row.id === id ? { ...row, [kind === 'stores' ? 'eligible' : 'blocked']: !(kind === 'stores' ? row.eligible : row.blocked) } : row) } }))
  const claimAssetEligible = detail?.delivery?.claimAssetEligible === true
  const claimAssetBlockedReason = detail?.delivery?.claimAssetBlockedReason || '当前卡暂不可生成电子领取卡。'
  const claimGenerating = claimGeneration.status === 'GENERATING'
  const canManage = hasSweetCardCapability(user, SWEET_CARD_CAPABILITIES.MANAGE)

  const goTab = (next) => { setUsageOpen(false); setTab(next) }
  const openUsage = () => setUsageOpen(true)
  const statusPill = (status) => {
    const tone = status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-700' : status === 'FROZEN' || status === 'LOST' ? 'bg-amber-50 text-amber-700' : status === 'VOID' || status === 'EXPIRED' || status === 'EXHAUSTED' ? 'bg-slate-100 text-slate-500' : 'bg-budu-50 text-budu-700'
    return `rounded-full px-2 py-0.5 text-[10px] font-black ${tone}`
  }

  return <div className="min-h-full bg-slate-50 px-3 pb-28 pt-3 sm:px-6 sm:pt-6">
    <div className="mx-auto max-w-6xl">
      <header className="flex items-center gap-3 rounded-3xl border border-rose-100 bg-white p-4 shadow-card sm:p-6">
        <button onClick={onBack} className="grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-slate-500" aria-label="返回"><ArrowLeft className="h-5 w-5" /></button>
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-budu-50 text-budu-600"><Gift className="h-6 w-6" /></div>
        <div className="min-w-0"><h1 className="text-xl font-black text-slate-900">budu 甜意卡</h1><p className="truncate text-xs font-semibold tracking-[0.16em] text-budu-500">A LITTLE SWEETNESS.</p></div>
        <button onClick={load} className="ml-auto grid h-10 w-10 place-items-center rounded-xl border border-slate-200 text-slate-500" aria-label="刷新"><RefreshCw className="h-4 w-4" /></button>
      </header>
      {error && <div className="mt-4 rounded-2xl bg-rose-50 p-4 text-sm text-rose-700">{error}</div>}
      {loading ? <div className="mt-6 rounded-3xl bg-white p-10 text-center text-sm text-slate-400">正在读取甜意卡权威数据…</div> : config?.enabled !== true ? <div className="mt-6 rounded-3xl border border-amber-200 bg-amber-50 p-8 text-center"><LockKeyhole className="mx-auto h-9 w-9 text-amber-500" /><h2 className="mt-3 font-black text-slate-800">Production capability 当前关闭</h2><p className="mt-2 text-sm text-slate-500">Candidate 已保留完整能力；开启前不会创建或核销任何真实价值。</p></div> : <>
        <nav className="mt-4 flex items-center gap-2 overflow-x-auto pb-2">
          {PRIMARY_TABS.map(([key, label]) => <button key={key} onClick={() => goTab(key)} className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold ${tab === key && !usageOpen ? 'bg-budu-500 text-white' : 'bg-white text-slate-500 shadow-sm'}`}>{label}</button>)}
          <span className="mx-1 h-6 w-px shrink-0 bg-slate-200" aria-hidden="true" />
          <button onClick={() => goTab('manage')} className={`flex shrink-0 items-center gap-1 rounded-full px-4 py-2 text-sm font-bold ${tab === 'manage' && !usageOpen ? 'bg-slate-800 text-white' : 'bg-white text-slate-500 shadow-sm'}`}><Settings2 className="h-4 w-4" />管理设置</button>
        </nav>
        {usageOpen ? <section className="mt-4 overflow-hidden rounded-3xl bg-white shadow-card">
          <div className="flex items-center gap-3 border-b border-slate-100 p-5"><button onClick={() => setUsageOpen(false)} className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-500" aria-label="返回总览"><ArrowLeft className="h-4 w-4" /></button><div><h2 className="font-black text-slate-900">使用记录</h2><p className="mt-0.5 text-xs text-slate-400">订单销售与甜意卡核销依旧分别保留各自权威事实。</p></div></div>
          <div className="flex gap-2 overflow-x-auto border-b border-slate-100 px-5 py-3">{VIEW_SCOPES.map(([key, label]) => <button key={key} type="button" aria-pressed={viewScope === key} onClick={() => setViewScope(key)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold ${viewScope === key ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500'}`}>{label}</button>)}</div>
          <div className="divide-y">{data.usage.map((row) => <article key={row.id} className="p-4 text-sm"><div className="flex justify-between gap-3"><strong className="min-w-0 truncate text-slate-800">{row.publicCardNo} · {row.orderNo}</strong><strong className="shrink-0 text-budu-600">-{formatCents(row.amountCents)}</strong></div><p className="mt-1 text-xs text-slate-400">{row.storeId} · {row.redeemedByName || '未记录操作人'} · {new Date(row.createdAt).toLocaleString()}</p></article>)}{data.usage.length === 0 && <p className="p-8 text-center text-sm text-slate-400">暂无核销记录</p>}</div>
        </section> : <>
          {['overview', 'batches', 'cards'].includes(tab) && <div className="mt-3 flex gap-2 overflow-x-auto" aria-label="甜意卡运营视图">{VIEW_SCOPES.map(([key, label]) => <button key={key} type="button" aria-pressed={viewScope === key} onClick={() => { setViewScope(key); setCardFilter((value) => ({ ...value, batchId: '' })) }} className={`min-h-10 shrink-0 rounded-xl px-4 text-xs font-bold ${viewScope === key ? 'bg-slate-800 text-white' : 'bg-white text-slate-500 shadow-sm'}`}>{label}</button>)}</div>}

          {tab === 'overview' && data.overview && <section className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className="rounded-3xl bg-white p-5 shadow-card sm:col-span-2 lg:col-span-1 lg:row-span-2">
                <p className="text-xs font-semibold text-slate-400">剩余余额</p>
                <p className="mt-2 break-words text-3xl font-black text-budu-600">{formatCents(data.overview.balanceCents)}</p>
                <div className="mt-4 space-y-2 text-sm"><p className="flex justify-between"><span className="text-slate-400">总发行额度</span><strong>{formatCents(data.overview.initialAmountCents)}</strong></p><p className="flex justify-between"><span className="text-slate-400">已消费额度</span><strong>{formatCents(consumed)}</strong></p></div>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:col-span-2 lg:col-span-2">{[['已激活', data.overview.statusCounts.ACTIVE || 0], ['未激活', data.overview.statusCounts.CREATED || 0], ['总发行额度', formatCents(data.overview.initialAmountCents)], ['已消费额度', formatCents(consumed)]].map(([label, value]) => <div key={label} className="rounded-3xl bg-white p-5 shadow-card"><p className="text-xs font-semibold text-slate-400">{label}</p><p className="mt-2 break-words text-2xl font-black text-slate-900">{value}</p></div>)}</div>
            </div>
            <div className="rounded-3xl bg-white p-4 shadow-card">
              <p className="text-xs font-bold text-slate-400">快捷操作</p>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <button onClick={() => goTab('issue')} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-budu-500 px-4 font-bold text-white"><Plus className="h-4 w-4" />创建并发卡</button>
                <button onClick={openUsage} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-slate-200 px-4 font-bold text-slate-600"><ReceiptText className="h-4 w-4" />使用记录 / Ledger</button>
                <button onClick={() => goTab('batches')} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-slate-200 px-4 font-bold text-slate-600"><Download className="h-4 w-4" />下载 QR 包</button>
              </div>
            </div>
            <details className="rounded-3xl bg-white px-5 py-4 shadow-card"><summary className="cursor-pointer select-none text-xs font-bold text-slate-500">更多统计</summary><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">{[['已创建', data.overview.count], ['已发放', data.overview.issued || 0], ['已用尽', data.overview.statusCounts.EXHAUSTED || 0], ['已冻结', data.overview.statusCounts.FROZEN || 0], ['已挂失', data.overview.statusCounts.LOST || 0], ['已过期', data.overview.statusCounts.EXPIRED || 0]].map(([label, value]) => <div key={label} className="rounded-2xl bg-slate-50 p-3"><p className="text-[10px] font-semibold text-slate-400">{label}</p><p className="mt-1 text-lg font-black text-slate-800">{value}</p></div>)}</div></details>
          </section>}

          {tab === 'batches' && <section className="mt-4 space-y-3">
            <div className="rounded-3xl bg-white p-4 shadow-card"><input aria-label="搜索批次名称" placeholder="搜索批次名称" value={batchFilter} onChange={(e) => setBatchFilter(e.target.value)} className={`${fieldClass} max-w-sm`} /></div>
            {filteredBatches.map((batch) => <article key={batch.id} className="rounded-3xl bg-white p-5 shadow-card"><div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap gap-2"><span className="rounded-full bg-budu-50 px-2 py-1 text-[10px] font-black text-budu-700">{sweetCardBatchPurposeLabel(batch.businessPurpose)}</span>{batch.archivedAt && <span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-black text-amber-700">已归档</span>}</div><h3 className="mt-2 font-black text-slate-900">{batch.name}</h3><p className="mt-1 text-xs text-slate-400">{batch.cardCount} 张 · {sweetCardCarrierTypeLabel(batch.carrierType)} · {sweetCardBindingModeLabel(batch.bindingMode)} · {new Date(batch.createdAt).toLocaleDateString()}</p></div><div className="text-right"><p className="text-xs text-slate-400">总面额</p><p className="text-lg font-black text-slate-900">{formatCents(batch.totalInitialAmountCents)}</p></div></div><div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs"><span className="rounded-xl bg-slate-50 p-2">已激活 {batch.metrics.activated}</span><span className="rounded-xl bg-slate-50 p-2">已消费 {formatCents(batch.metrics.consumedCents)}</span><span className="rounded-xl bg-slate-50 p-2">余额 {formatCents(batch.metrics.balanceCents)}</span></div><div className="mt-3 flex items-center gap-2"><a href={`/api/v2/sweet-cards/batches/${batch.id}/export`} className="inline-flex items-center gap-1 rounded-xl border border-budu-200 px-3 py-2 text-xs font-bold text-budu-600"><Download className="h-4 w-4" />QR 包</a>{hasSweetCardCapability(user, SWEET_CARD_CAPABILITIES.MANAGE) && <details className="relative"><summary className="cursor-pointer select-none rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-500">更多</summary><div className="absolute right-0 z-10 mt-1 w-44 rounded-2xl border border-slate-100 bg-white p-1 shadow-modal"><button type="button" disabled={saving} onClick={() => archiveBatch(batch.id, !batch.archivedAt)} className="w-full rounded-xl px-3 py-2 text-left text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50">{batch.archivedAt ? '恢复归档' : '归档批次'}</button></div></details>}</div></article>)}
            {filteredBatches.length === 0 && <p className="rounded-3xl bg-white p-8 text-center text-sm text-slate-400">没有符合条件的批次</p>}
          </section>}

          {tab === 'cards' && <section className="mt-4">
            <div className="grid gap-2 rounded-3xl bg-white p-4 shadow-card sm:grid-cols-2 lg:grid-cols-4">
              <input aria-label="搜索卡号或赠送对象" placeholder="搜索卡号 / 赠送对象" value={cardFilter.search} onChange={(e) => setCardFilter({ ...cardFilter, search: e.target.value })} className={fieldClass} />
              <select aria-label="按批次筛选" value={cardFilter.batchId} onChange={(e) => setCardFilter({ ...cardFilter, batchId: e.target.value })} className={fieldClass}><option value="">全部批次</option>{data.batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.name}</option>)}</select>
              <select aria-label="按状态筛选" value={cardFilter.status} onChange={(e) => setCardFilter({ ...cardFilter, status: e.target.value })} className={fieldClass}><option value="">全部状态</option>{SWEET_CARD_STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
              <select aria-label="按面额筛选" value={cardFilter.faceValueCents} onChange={(e) => setCardFilter({ ...cardFilter, faceValueCents: e.target.value })} className={fieldClass}><option value="">全部面额</option>{[...new Set(data.cards.map((card) => card.initialAmountCents))].map((amount) => <option key={amount} value={amount}>{formatCents(amount)}</option>)}</select>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <p className="text-xs font-bold text-slate-400">{filteredCards.length} 张卡</p>
              <div className="flex rounded-xl bg-slate-100 p-1" role="tablist" aria-label="卡片视图">
                <button role="tab" aria-selected={cardView === 'card'} onClick={() => setCardView('card')} className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold ${cardView === 'card' ? 'bg-white text-budu-600 shadow-sm' : 'text-slate-400'}`}><LayoutGrid className="h-3.5 w-3.5" />卡片</button>
                <button role="tab" aria-selected={cardView === 'list'} onClick={() => setCardView('list')} className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold ${cardView === 'list' ? 'bg-white text-budu-600 shadow-sm' : 'text-slate-400'}`}><List className="h-3.5 w-3.5" />列表</button>
              </div>
            </div>
            {cardView === 'card' ? <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{filteredCards.map((card) => <article key={card.id} className="rounded-3xl bg-white p-5 shadow-card"><div className="flex items-start justify-between gap-3"><span className={statusPill(card.status)}>{sweetCardStatusLabel(card.status)}</span><p className="text-xl font-black text-budu-600">{formatCents(card.balanceCents)}</p></div><div className="mt-3"><p className="text-xs text-slate-400">面额</p><p className="mt-0.5 text-sm font-black text-slate-900">{formatCents(card.initialAmountCents)}</p></div>{card.recipientLabel && <p className="mt-3 flex items-center gap-1.5 text-sm text-slate-600"><Gift className="h-3.5 w-3.5 text-budu-400" />{card.recipientLabel}</p>}<p className="mt-3 text-xs text-slate-400">{batchNames[card.batchId] ? `批次：${batchNames[card.batchId]}` : '无批次'} · {sweetCardCarrierTypeLabel(card.carrierType)} · {sweetCardBindingModeLabel(card.bindingMode)}</p><p className="mt-1 text-[11px] font-mono text-slate-300">{card.publicCardNo}</p><div className="mt-4 flex flex-wrap gap-2"><button onClick={() => openDetail(card.id)} className="rounded-xl border border-budu-200 px-3 py-2 text-xs font-bold text-budu-600">详情 / Ledger</button>{card.status === 'CREATED' && <button disabled={saving} onClick={() => transition(card.id, 'activate')} className="rounded-xl bg-budu-500 px-3 py-2 text-xs font-bold text-white">激活</button>}{card.status === 'ACTIVE' && <button disabled={saving} onClick={() => transition(card.id, 'freeze')} className="rounded-xl border px-3 py-2 text-xs font-bold text-slate-600">冻结</button>}{card.status === 'FROZEN' && <button disabled={saving} onClick={() => transition(card.id, 'unfreeze')} className="rounded-xl border px-3 py-2 text-xs font-bold text-slate-600">解冻</button>}</div></article>)}</div> : <div className="mt-3 overflow-hidden rounded-3xl bg-white shadow-card"><div className="divide-y">{filteredCards.map((card) => <button key={card.id} onClick={() => openDetail(card.id)} className="flex w-full items-center gap-3 p-4 text-left hover:bg-slate-50"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className={statusPill(card.status)}>{sweetCardStatusLabel(card.status)}</span>{card.recipientLabel && <span className="truncate text-sm font-semibold text-slate-700">{card.recipientLabel}</span>}</div><p className="mt-1 text-xs text-slate-400">{formatCents(card.initialAmountCents)} · {batchNames[card.batchId] || '无批次'}</p></div><div className="text-right"><p className="font-black text-budu-600">{formatCents(card.balanceCents)}</p><p className="mt-0.5 text-[11px] font-mono text-slate-300">{card.publicCardNo}</p></div><ChevronRight className="h-4 w-4 shrink-0 text-slate-300" /></button>)}</div></div>}
            {filteredCards.length === 0 && <p className="mt-3 rounded-3xl bg-white p-8 text-center text-sm text-slate-400">没有符合条件的卡片</p>}
          </section>}

          {tab === 'issue' && (issueResult ? <SweetCardSuccess result={issueResult} onViewBatches={() => goTab('batches')} onViewCards={() => { setCardFilter((value) => ({ ...value, batchId: issueResult.batchId, status: '', faceValueCents: '', search: '' })); goTab('cards') }} onContinue={continueIssue} /> : <SweetCardCreateWizard form={form} onChange={setForm} saving={saving} onSubmit={createBatch} />)}

          {tab === 'manage' && <section className="mt-4 space-y-3">
            <div className="flex gap-2 overflow-x-auto">{MANAGE_SECTIONS.filter(([key]) => key !== 'settings' || canManage).map(([key, label]) => <button key={key} onClick={() => setManageSection(key)} className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold ${manageSection === key ? 'bg-slate-800 text-white' : 'bg-white text-slate-500 shadow-sm'}`}>{label}</button>)}</div>
            {manageSection === 'rules' && data.rules && <section className="rounded-3xl bg-white p-5 shadow-card"><h2 className="font-black text-slate-900">不可使用商品分类</h2><div className="mt-4 space-y-2">{data.rules.categories.map((row) => <label key={row.id} className="flex items-center justify-between rounded-xl bg-slate-50 p-3 text-sm"><span>{row.name}</span><input type="checkbox" checked={row.blocked} onChange={() => toggleRule('categories', row.id)} /></label>)}</div><button disabled={saving} onClick={saveRules} className="mt-4 rounded-2xl bg-budu-500 px-5 py-3.5 font-bold text-white">保存规则</button></section>}
            {manageSection === 'settings' && canManage && <SweetCardAvailability />}
            {manageSection === 'audit' && <section className="overflow-hidden rounded-3xl bg-white shadow-card"><div className="flex items-center gap-2 border-b border-slate-100 p-5"><ShieldCheck className="h-5 w-5 text-budu-500" /><h2 className="font-black text-slate-900">安全审计</h2></div><div className="divide-y">{data.audit.map((event) => <div key={event.id} className="p-4 text-sm"><div className="flex justify-between gap-3"><strong className="text-slate-700">{event.action}</strong><time className="shrink-0 text-xs text-slate-400">{new Date(event.createdAt).toLocaleString()}</time></div><p className="mt-1 text-xs text-slate-400">{event.actorName || event.actorId || 'system'}</p></div>)}</div></section>}
          </section>}
        </>}
      </>}
    </div>
    {detail && <div className="fixed inset-0 z-[120] flex items-end bg-slate-950/60 backdrop-blur-sm sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-label="甜意卡详情">
      <div className="max-h-[94dvh] w-full overflow-y-auto rounded-t-[30px] bg-white shadow-modal sm:max-w-2xl sm:rounded-[30px]" style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}>
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-100 bg-white/95 p-5 backdrop-blur"><div><p className="text-xs font-black tracking-widest text-budu-500">A LITTLE SWEETNESS.</p><h2 className="mt-1 text-xl font-black text-slate-900">{detail.publicCardNo}</h2></div><button onClick={() => setDetail(null)} className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-bold text-slate-500">关闭</button></div>
        <div className="space-y-5 p-5">
          <section aria-label="卡片概况">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <p className="rounded-xl bg-slate-50 p-3">初始额度<br/><strong>{formatCents(detail.initialAmountCents)}</strong></p><p className="rounded-xl bg-slate-50 p-3">当前余额<br/><strong>{formatCents(detail.balanceCents)}</strong></p>
              <p className="rounded-xl bg-slate-50 p-3">卡状态<br/><strong>{sweetCardStatusLabel(detail.status)}</strong></p><p className="rounded-xl bg-slate-50 p-3">载体 / 绑定模式<br/><strong>{sweetCardCarrierTypeLabel(detail.carrierType)} / {sweetCardBindingModeLabel(detail.bindingMode)}</strong></p>
              <p className="rounded-xl bg-slate-50 p-3">业务批次<br/><strong>{detail.batch?.name || '无批次'}</strong></p><p className="rounded-xl bg-slate-50 p-3">有效期<br/><strong>{detail.expiresAt ? new Date(detail.expiresAt).toLocaleDateString() : '长期 / 待激活'}</strong></p>
              <p className="rounded-xl bg-slate-50 p-3">绑定<br/><strong>{detail.delivery ? sweetCardBindingStatusLabel(detail.delivery.bindingStatus) : detail.binding ? '已绑定' : '未绑定'}</strong></p><p className="rounded-xl bg-slate-50 p-3">使用凭证<br/><strong>{(detail.credentials || []).map((row) => sweetCardCredentialStatusLabel(row.status)).join(' / ') || '无'}</strong></p>
            </div>
          </section>

          {detail.carrierType === 'ELECTRONIC' && <section className="rounded-3xl border border-rose-100 bg-rose-50/40 p-4" aria-label="电子卡发放">
            <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-black tracking-[0.18em] text-budu-500">DELIVERY</p><h3 className="mt-1 text-lg font-black text-slate-900">电子卡发放</h3></div><button type="button" disabled={saving} onClick={refreshDetail} className="inline-flex min-h-10 items-center gap-1 rounded-xl border border-rose-200 bg-white px-3 text-xs font-bold text-budu-600 disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" />刷新状态</button></div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
              <p aria-label="激活状态" className="rounded-xl bg-white p-3">激活状态<br/><strong className="mt-1 inline-block text-sm text-slate-800">{sweetCardActivationStatusLabel(detail.delivery?.activationStatus)}</strong></p>
              <p aria-label="电子卡状态" className="rounded-xl bg-white p-3">电子卡<br/><strong className="mt-1 inline-block text-sm text-slate-800">{sweetCardPresentationStatusLabel(detail.delivery?.presentationStatus)}</strong></p>
              <p aria-label="领取凭证状态" className="rounded-xl bg-white p-3">领取凭证<br/><strong className="mt-1 inline-block text-sm text-slate-800">{sweetCardClaimCredentialStatusLabel(detail.delivery?.claimCredentialStatus)}</strong></p>
              <p aria-label="领取状态" className="rounded-xl bg-white p-3">领取<br/><strong className="mt-1 inline-block text-sm text-slate-800">{sweetCardClaimStatusLabel(detail.delivery?.claimStatus)}</strong></p>
              <p aria-label="绑定状态" className="rounded-xl bg-white p-3">绑定<br/><strong className="mt-1 inline-block text-sm text-slate-800">{sweetCardBindingStatusLabel(detail.delivery?.bindingStatus)}</strong></p>
              <p aria-label="发放准备状态" className="rounded-xl bg-white p-3">发放准备<br/><strong className="mt-1 inline-block text-sm text-slate-800">{sweetCardDeliveryStatusLabel(detail.delivery?.deliveryStatus)}</strong></p>
            </div>
            {claimGeneration.status !== 'IDLE' && <div role={claimGeneration.status === 'ERROR' ? 'alert' : 'status'} data-claim-generation-state={claimGeneration.status} className={`mt-3 rounded-xl px-3 py-2 text-sm font-bold ${claimGeneration.status === 'ERROR' ? 'bg-rose-100 text-rose-700' : claimGeneration.status === 'SUCCESS' ? 'bg-emerald-50 text-emerald-700' : 'bg-budu-50 text-budu-700'}`}>{claimGeneration.message}</div>}
            {!claimAssetEligible && <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800" data-testid="claim-asset-blocked-reason">{claimAssetBlockedReason}</p>}
            {detail.delivery?.claimedAt && <p className="mt-3 rounded-xl bg-white px-3 py-2 text-xs text-slate-600">领取时间：{new Date(detail.delivery.claimedAt).toLocaleString()}</p>}

            <form onSubmit={savePresentation} className="mt-5 rounded-2xl bg-white p-4" aria-label="编辑赠送信息">
              <h4 className="font-black text-slate-800">赠送信息</h4>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className={labelClass}>赠送对象<input value={presentationForm.recipientLabel} onChange={(e) => setPresentationForm({ ...presentationForm, recipientLabel: e.target.value })} className={`${fieldClass} mt-1`} /></label>
                <label className={labelClass}>赠送对象类型<input value={presentationForm.recipientType} onChange={(e) => setPresentationForm({ ...presentationForm, recipientType: e.target.value })} className={`${fieldClass} mt-1`} /></label>
                <label className={labelClass}>公司（可选）<input value={presentationForm.recipientCompany} onChange={(e) => setPresentationForm({ ...presentationForm, recipientCompany: e.target.value })} className={`${fieldClass} mt-1`} /></label>
                <label className={labelClass}>赠送场景（可选）<input value={presentationForm.giftingScenario} onChange={(e) => setPresentationForm({ ...presentationForm, giftingScenario: e.target.value })} className={`${fieldClass} mt-1`} /></label>
                <label className={`${labelClass} sm:col-span-2`}>祝福语 / campaign 文案<textarea rows="3" value={presentationForm.recipientNote} onChange={(e) => setPresentationForm({ ...presentationForm, recipientNote: e.target.value })} className={`${fieldClass} mt-1 resize-y`} /></label>
              </div>
              <button disabled={saving} className="mt-3 min-h-11 w-full rounded-xl border border-budu-200 font-bold text-budu-600 disabled:opacity-50">保存赠送信息</button>
            </form>

            <div className="mt-4 rounded-2xl bg-white p-4">
              <h4 className="font-black text-slate-800">卡面</h4>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs"><p className="rounded-xl bg-slate-50 p-3">当前模板<br/><strong>{detail.batch?.presentationTemplateKey || 'minimal-v2'}</strong></p><p className="rounded-xl bg-slate-50 p-3">设计版本<br/><strong>{detail.batch?.presentationTemplateKey || 'minimal-v2'}</strong></p></div>
              <a href={`/api/v2/sweet-cards/cards/${detail.id}/presentation`} target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-budu-200 font-bold text-budu-600">预览电子卡</a>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <button type="button" disabled={saving || !claimAssetEligible} onClick={() => generateClaimPresentation('ELECTRONIC')} className="min-h-12 rounded-xl bg-budu-500 px-4 font-bold text-white disabled:opacity-50">{claimGenerating ? '正在生成电子卡…' : detail.delivery?.claimCredentialStatus === 'ACTIVE' ? '重新生成领取凭证' : '生成电子卡'}</button>
              {detail.status === 'CREATED' && <button disabled={saving || detail.delivery?.claimCredentialStatus !== 'ACTIVE'} onClick={activateDelivery} className="min-h-12 rounded-xl border border-budu-300 bg-white px-4 font-bold text-budu-600 disabled:opacity-40">激活并准备发放</button>}
              {config?.claimPresentationEnabled && detail.delivery?.claimCredentialStatus === 'ACTIVE' && detail.delivery?.claimStatus !== 'CLAIMED' && <button disabled={saving} onClick={revokeClaimPresentation} className="min-h-11 rounded-xl border border-rose-200 bg-white px-4 font-bold text-rose-600 disabled:opacity-50">撤销领取凭证</button>}
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-500">顾客收到的主二维码仅用于微信领取；POS 使用码不会出现在未领取电子卡中。生成后请立即下载电子卡图片，并通过独立渠道交付领取凭证。</p>
          </section>}

          <section className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600" aria-label="发放摘要"><p>赠送对象：{detail.recipientLabel || '—'}</p><p className="mt-1">公司：{detail.recipientCompany || '—'}</p><p className="mt-1">赠送场景：{detail.giftingScenario || '—'}</p><p className="mt-1">祝福语：{detail.recipientNote || '—'}</p><p className="mt-1">创建人：{detail.issuedByName || '—'} · {detail.issuedAt ? new Date(detail.issuedAt).toLocaleString() : '—'}</p></section>

          <div className="flex flex-wrap gap-2">{detail.bindingMode !== 'NONE' && !detail.binding && <button onClick={() => bindCard(detail.id)} className="rounded-xl bg-budu-500 px-3 py-2 text-xs font-bold text-white">绑定已验证客户</button>}{detail.binding && ['ACTIVE', 'FROZEN'].includes(detail.status) && <button onClick={() => credentialAction(detail.id, 'lost')} className="rounded-xl border border-rose-200 px-3 py-2 text-xs font-bold text-rose-600">挂失使用凭证</button>}{detail.binding && detail.status === 'LOST' && <button onClick={() => credentialAction(detail.id, 'replace')} className="rounded-xl bg-budu-500 px-3 py-2 text-xs font-bold text-white">补发使用凭证</button>}{detail.carrierType === 'PHYSICAL' && <button type="button" disabled={saving || !claimAssetEligible} onClick={() => generateClaimPresentation('PHYSICAL')} className="rounded-xl border border-budu-200 px-3 py-2 text-xs font-bold text-budu-600 disabled:opacity-50">生成实体卡领取二维码</button>}</div>
          {hasSweetCardCapability(user, SWEET_CARD_CAPABILITIES.VOID) && !['VOID', 'EXHAUSTED', 'EXPIRED'].includes(detail.status) && <details className="border-t border-slate-100 pt-4 text-xs"><summary className="cursor-pointer select-none font-bold text-slate-500">卡片危险操作</summary><button type="button" disabled={saving} onClick={() => voidCard(detail.id)} className="mt-3 min-h-10 rounded-xl border border-rose-200 px-3 font-bold text-rose-600 disabled:opacity-50">作废甜意卡</button></details>}
          <section aria-label="账务记录"><h3 className="font-black text-slate-900">账务记录</h3><div className="mt-2 divide-y rounded-2xl border">{(detail.ledger || []).map((entry) => { const amount = BigInt(entry.amountCents); const positive = entry.type !== 'REDEEM'; return <div key={entry.id} className="flex justify-between gap-3 p-3 text-xs"><span><strong>{sweetCardLedgerTypeLabel(entry.type)}</strong><br /><span className="text-slate-400">{new Date(entry.createdAt).toLocaleString()}</span></span><span className="text-right font-semibold">{positive ? '+' : '-'}{formatCents(amount < 0n ? -amount : amount)}<br /><span className="text-slate-400">余额 {formatCents(entry.balanceAfterCents)}</span></span></div> })}</div></section>
          <details className="rounded-2xl border border-slate-100 p-4 text-xs text-slate-500"><summary className="cursor-pointer font-bold">技术信息</summary><p className="mt-2 break-all">Card ID：{detail.id}</p><p className="mt-1 break-all">Batch ID：{detail.batchId || '—'}</p></details>
        </div>
      </div>
    </div>}
    {claimDelivery && <SweetCardDelivery delivery={claimDelivery} onClose={() => setClaimDelivery(null)} onCopy={copyClaimProof} onRevoke={revokeClaimPresentation} saving={saving} />}
  </div>
}
