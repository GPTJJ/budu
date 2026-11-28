import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Archive, ArchiveRestore, Ban, ChevronRight, Gift, Lock, Plus, QrCode, RefreshCw, Share2, Snowflake, Sun } from 'lucide-react'
import { api } from '../utils/api'
import { formatCents } from '../utils/pos'
import { hasSweetCardCapability, SWEET_CARD_CAPABILITIES } from '../../shared/accountPermissions'
import { retainSweetCardIssueAttempt } from '../utils/sweetCardIssueFlow'
import { sweetCardActivationStatusLabel, sweetCardBindingStatusLabel, sweetCardClaimCredentialStatusLabel, sweetCardClaimGenerationErrorLabel, sweetCardClaimStatusLabel, sweetCardStatusLabel } from '../utils/sweetCardLabels'
import SweetCardHeader from './sweet-card/mobile/SweetCardHeader'
import SweetCardHero from './sweet-card/mobile/SweetCardHero'
import SweetCardIssueSheet from './sweet-card/mobile/SweetCardIssueSheet'
import SweetCardConfigSheet from './sweet-card/mobile/SweetCardConfigSheet'
import SweetCardShareSheet from './sweet-card/mobile/SweetCardShareSheet'

const SCOPES = [['COMMERCIAL', '商业'], ['ACCEPTANCE_TEST', '测试'], ['ARCHIVED', '归档']]

const claimTone = (card) => {
  if (card.claimedAt) return { label: '已领取', className: 'bg-emerald-50 text-emerald-700' }
  if (card.status === 'CREATED') return { label: '待激活', className: 'bg-amber-50 text-amber-700' }
  if (card.balanceCents === '0') return { label: '已核销', className: 'bg-slate-100 text-slate-500' }
  if (['VOID', 'EXPIRED', 'LOST'].includes(card.status)) return { label: sweetCardStatusLabel(card.status), className: 'bg-slate-100 text-slate-500' }
  return { label: '待领取', className: 'bg-budu-50 text-budu-700' }
}

export default function SweetCardPage({ user, onBack }) {
  const [config, setConfig] = useState(null)
  const [overview, setOverview] = useState(null)
  const [cards, setCards] = useState([])
  const [batches, setBatches] = useState([])
  const [rules, setRules] = useState(null)
  const [audit, setAudit] = useState([])
  const [usage, setUsage] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [scope, setScope] = useState('COMMERCIAL')

  const [issueOpen, setIssueOpen] = useState(false)
  const [issueError, setIssueError] = useState('')
  const [configOpen, setConfigOpen] = useState(false)
  const [configSegment, setConfigSegment] = useState('stores')
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [shareCard, setShareCard] = useState(null)
  const [moreOpen, setMoreOpen] = useState('')
  const issueAttemptRef = useRef(null)
  const toastTimer = useRef(null)

  const flash = useCallback((message) => {
    setToast(message)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2600)
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const nextConfig = await api('/v2/sweet-cards/config')
      setConfig(nextConfig)
      if (!nextConfig.enabled) return
      const scopeQuery = scope === 'ARCHIVED' ? '?businessPurpose=ALL&archived=true' : `?businessPurpose=${scope}&archived=false`
      const [nextOverview, nextBatches, nextCards, nextRules, nextUsage, nextAudit] = await Promise.all([
        api(`/v2/sweet-cards/overview${scopeQuery}`),
        api(`/v2/sweet-cards/batches${scopeQuery}`),
        api(`/v2/sweet-cards/cards${scopeQuery}`),
        api('/v2/sweet-cards/rules'),
        api(`/v2/sweet-cards/usage${scopeQuery}`),
        api('/v2/sweet-cards/audit'),
      ])
      setOverview(nextOverview)
      setBatches(nextBatches.batches || [])
      setCards(nextCards.cards || [])
      setRules(nextRules)
      setUsage(nextUsage.redemptions || [])
      setAudit(nextAudit.events || [])
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [scope])
  useEffect(() => { load() }, [load])

  const consumedCents = useMemo(() => (overview ? String(BigInt(overview.initialAmountCents) - BigInt(overview.balanceCents)) : '0'), [overview])
  const pendingCards = useMemo(() => cards.filter((card) => !card.claimedAt && card.status !== 'VOID'), [cards])
  const recentCards = useMemo(() => cards.slice(0, 8), [cards])
  const canManage = hasSweetCardCapability(user, SWEET_CARD_CAPABILITIES.MANAGE)
  const canIssue = hasSweetCardCapability(user, SWEET_CARD_CAPABILITIES.ISSUE)

  const createBatch = async (payload) => {
    setSaving(true); setIssueError('')
    try {
      const body = JSON.stringify(payload)
      issueAttemptRef.current = retainSweetCardIssueAttempt(issueAttemptRef.current, body)
      const result = await api('/v2/sweet-cards/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': issueAttemptRef.current.requestKey },
        body,
      })
      issueAttemptRef.current = null
      setIssueOpen(false)
      flash(`已创建 ${result.cards?.length || payload.cardCount} 张 · 已激活 · 待领取`)
      await load()
    } catch (e) { setIssueError(e.message) } finally { setSaving(false) }
  }

  const openDetail = async (id) => {
    setDetailLoading(true); setError('')
    try { const result = await api(`/v2/sweet-cards/cards/${id}`); setDetail(result.card) }
    catch (e) { setError(e.message) } finally { setDetailLoading(false) }
  }

  const transition = async (id, action) => {
    setSaving(true); setError('')
    try { await api(`/v2/sweet-cards/cards/${id}/${action}`, { method: 'POST' }); await load(); await openDetail(id) }
    catch (e) { setError(e.message) } finally { setSaving(false) }
  }

  const voidCard = async (id) => {
    if (!window.confirm('作废后该卡不能继续使用，余额与历史记录保留。确认作废？')) return
    setDetail(null)
    await transition(id, 'void')
  }

  const archiveBatch = async (batchId, cardCount = 1) => {
    if (!batchId) return
    const msg = cardCount > 1
      ? `归档后该卡所属批次（共 ${cardCount} 张）将移入「归档」分类，不计入日常列表。确认归档？`
      : '归档后该卡将移入「归档」分类，不计入日常列表。确认归档？'
    if (!window.confirm(msg)) return
    setSaving(true); setError('')
    try {
      await api(`/v2/sweet-cards/batches/${batchId}/archive`, { method: 'POST', body: JSON.stringify({}) })
      setDetail(null)
      flash('已移入归档')
      await load()
    } catch (e) { setError(e.message) } finally { setSaving(false) }
  }

  const restoreBatch = async (batchId) => {
    if (!batchId) return
    setSaving(true); setError('')
    try {
      await api(`/v2/sweet-cards/batches/${batchId}/restore`, { method: 'POST', body: JSON.stringify({}) })
      setDetail(null)
      flash('已从归档恢复')
      await load()
    } catch (e) { setError(e.message) } finally { setSaving(false) }
  }

  const saveRules = async (blockedCategoryIds) => {
    await api('/v2/sweet-cards/rules', { method: 'PUT', body: JSON.stringify({ blockedCategoryIds }) })
    const nextRules = await api('/v2/sweet-cards/rules')
    setRules(nextRules)
  }

  const generateClaimAsset = useCallback(async (cardId, reissue) => {
    const result = await api(`/v2/sweet-cards/cards/${cardId}/claim-presentation`, {
      method: 'POST',
      body: JSON.stringify({ carrierType: 'ELECTRONIC', holderVerificationConfirmed: true, separateProofDelivery: true, reissueConfirmed: reissue === true }),
    })
    return result
  }, [])

  const prepareCredential = useCallback(async (card) => {
    setSaving(true)
    try {
      const fresh = await api(`/v2/sweet-cards/cards/${card.id}`)
      const active = fresh.card?.delivery?.activeClaimCredentialId
      if (active) {
        setDetail((prev) => (prev?.id === fresh.card.id ? fresh.card : prev))
        return active
      }
      const generated = await generateClaimAsset(card.id, fresh.card?.delivery?.claimCredentialStatus === 'ACTIVE')
      const refreshed = await api(`/v2/sweet-cards/cards/${card.id}`)
      const nextCard = refreshed.card
      if (nextCard) {
        setDetail((prev) => (prev?.id === nextCard.id ? nextCard : prev))
        setCards((prev) => prev.map((item) => (item.id === nextCard.id ? { ...item, ...nextCard } : item)))
      }
      return generated?.claimAsset?.id || nextCard?.delivery?.activeClaimCredentialId || ''
    } catch (e) {
      flash(sweetCardClaimGenerationErrorLabel(e))
      return ''
    } finally { setSaving(false) }
  }, [flash, generateClaimAsset])

  const handleShareClose = useCallback(() => {
    setShareCard(null)
    load()
  }, [load])

  const openShare = async (card) => {
    setError('')
    if (card.delivery?.activeClaimCredentialId !== undefined) { setShareCard(card); return }
    const fresh = await api(`/v2/sweet-cards/cards/${card.id}`).catch(() => null)
    setShareCard(fresh?.card || card)
  }

  const statusPill = config?.enabled ? { label: '运营中', tone: 'live' } : { label: '未开启', tone: 'off' }

  return (
    <div className="min-h-full bg-[#FBF7F8] pb-24">
      <SweetCardHeader
        onBack={onBack}
        statusLabel={statusPill.label}
        statusTone={statusPill.tone}
        onOpenConfig={() => { setConfigSegment('stores'); setConfigOpen(true) }}
        onOpenNotifications={() => { setConfigSegment('audit'); setConfigOpen(true) }}
        notificationCount={Math.min(audit.length, 9)}
      />

      <main className="mx-auto max-w-[560px] px-3.5 pt-3.5">
        {error && <p role="alert" className="mb-3 rounded-2xl bg-rose-50 px-3.5 py-2.5 text-[12px] font-bold text-rose-700">{error}</p>}

        <SweetCardHero
          loading={loading}
          balanceCents={overview?.balanceCents || '0'}
          totalCents={overview?.initialAmountCents || '0'}
          consumedCents={consumedCents}
          claimedCount={overview?.claimed || 0}
        />

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" disabled={!canIssue || !config?.enabled} onClick={() => { setIssueError(''); setIssueOpen(true) }} className="flex h-12 items-center justify-center gap-1.5 rounded-2xl bg-budu-500 text-[14px] font-black text-white shadow-[0_10px_22px_-14px_rgba(188,79,126,1)] disabled:opacity-40">
            <Plus className="h-[18px] w-[18px]" />创建甜意卡
          </button>
          <button type="button" disabled={!config?.enabled || pendingCards.length === 0} onClick={() => openShare(pendingCards[0])} className="flex h-12 items-center justify-center gap-1.5 rounded-2xl bg-white text-[14px] font-black text-slate-700 ring-1 ring-slate-200 disabled:opacity-40">
            <Share2 className="h-[17px] w-[17px]" />转发给好友
          </button>
        </div>

        <div className="mt-4 flex items-center gap-1.5">
          {SCOPES.map(([key, label]) => (
            <button key={key} type="button" aria-pressed={scope === key} onClick={() => setScope(key)} className={`h-8 rounded-full px-3 text-[12px] font-black transition ${scope === key ? 'bg-slate-900 text-white' : 'bg-white text-slate-500 ring-1 ring-slate-200'}`}>{label}</button>
          ))}
          <button type="button" onClick={load} aria-label="刷新" className="ml-auto grid h-8 w-8 place-items-center rounded-full bg-white text-slate-400 ring-1 ring-slate-200"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
        </div>

        <section aria-label="最近甜意卡" className="mt-2.5 space-y-2">
          {loading && <p className="rounded-2xl bg-white px-4 py-8 text-center text-[12px] text-slate-400 ring-1 ring-slate-100">正在读取甜意卡…</p>}
          {!loading && recentCards.length === 0 && <p className="rounded-2xl bg-white px-4 py-10 text-center text-[12px] text-slate-400 ring-1 ring-slate-100">还没有甜意卡，点上方「创建甜意卡」开始</p>}
          {recentCards.map((card) => {
            const tone = claimTone(card)
            return (
              <article key={card.id} className="rounded-2xl bg-white p-3.5 ring-1 ring-slate-100">
                <div className="flex items-start gap-3">
                  <button type="button" onClick={() => openDetail(card.id)} className="min-w-0 flex-1 text-left">
                    <div className="flex items-center gap-1.5">
                      <span className={`rounded-full px-2 py-[2px] text-[10px] font-black ${tone.className}`}>{tone.label}</span>
                      <span className="truncate text-[10px] font-mono text-slate-300">****{String(card.publicCardNo).slice(-4)}</span>
                    </div>
                    <p className="mt-1.5 text-[19px] font-black leading-none tabular-nums text-slate-900">{formatCents(card.balanceCents)}</p>
                    <p className="mt-1 truncate text-[11px] text-slate-400">{card.recipientLabel || '未指定赠送对象'} · 面额 {formatCents(card.initialAmountCents)}</p>
                  </button>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {!card.claimedAt && card.status !== 'VOID' && (
                      <button type="button" onClick={() => openShare(card)} className="inline-flex h-8 items-center gap-1 rounded-xl bg-budu-50 px-2.5 text-[11px] font-black text-budu-700"><Share2 className="h-3 w-3" />转发</button>
                    )}
                    <button type="button" onClick={() => openDetail(card.id)} className="inline-flex h-8 items-center gap-0.5 rounded-xl px-2 text-[11px] font-bold text-slate-400">详情<ChevronRight className="h-3 w-3" /></button>
                  </div>
                </div>
              </article>
            )
          })}
        </section>

        <section className="mt-3 space-y-2">
          {[['batches', '批次与二维码包', `${batches.length} 个批次`], ['usage', '核销记录', `${usage.length} 笔`]].map(([key, label, hint]) => (
            <div key={key} className="overflow-hidden rounded-2xl bg-white ring-1 ring-slate-100">
              <button type="button" onClick={() => setMoreOpen(moreOpen === key ? '' : key)} className="flex w-full items-center gap-2 px-3.5 py-3 text-left">
                <span className="text-[13px] font-black text-slate-700">{label}</span>
                <span className="text-[11px] text-slate-300">{hint}</span>
                <ChevronRight className={`ml-auto h-4 w-4 text-slate-300 transition ${moreOpen === key ? 'rotate-90' : ''}`} />
              </button>
              {moreOpen === key && key === 'batches' && <div className="border-t border-slate-50">
                {batches.length === 0 && <p className="px-3.5 py-5 text-center text-[12px] text-slate-400">暂无批次</p>}
                {batches.slice(0, 12).map((batch) => (
                  <div key={batch.id} className="flex items-center gap-2 border-b border-slate-50 px-3.5 py-2.5 last:border-0">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-bold text-slate-800">{batch.name}</p>
                      <p className="mt-0.5 text-[10px] text-slate-400">{batch.cardCount} 张 · {formatCents(batch.totalInitialAmountCents)} · 余额 {formatCents(batch.metrics?.balanceCents || '0')}</p>
                    </div>
                    <a href={`/api/v2/sweet-cards/batches/${batch.id}/export`} className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-slate-50 px-2.5 py-1.5 text-[11px] font-bold text-slate-600"><QrCode className="h-3 w-3" />二维码包</a>
                    {canManage && (scope === 'ARCHIVED' ? (
                      <button type="button" disabled={saving} onClick={() => restoreBatch(batch.id)} className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-emerald-50 px-2.5 py-1.5 text-[11px] font-bold text-emerald-700 disabled:opacity-50"><ArchiveRestore className="h-3 w-3" />恢复</button>
                    ) : (
                      <button type="button" disabled={saving} onClick={() => archiveBatch(batch.id, batch.cardCount)} className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 disabled:opacity-50"><Archive className="h-3 w-3" />归档</button>
                    ))}
                  </div>
                ))}
              </div>}
              {moreOpen === key && key === 'usage' && <div className="border-t border-slate-50">
                {usage.length === 0 && <p className="px-3.5 py-5 text-center text-[12px] text-slate-400">暂无核销记录</p>}
                {usage.slice(0, 20).map((row) => (
                  <div key={row.id} className="flex items-center gap-2 border-b border-slate-50 px-3.5 py-2.5 last:border-0">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-bold text-slate-700">****{String(row.publicCardNo).slice(-4)} · {row.orderNo}</p>
                      <p className="mt-0.5 text-[10px] text-slate-400">{new Date(row.createdAt).toLocaleString()}</p>
                    </div>
                    <span className="shrink-0 text-[12px] font-black text-budu-600">-{formatCents(row.amountCents)}</span>
                  </div>
                ))}
              </div>}
            </div>
          ))}
        </section>
      </main>

      <SweetCardIssueSheet open={issueOpen} saving={saving} error={issueError} onClose={() => setIssueOpen(false)} onSubmit={createBatch} />

      <SweetCardConfigSheet
        open={configOpen}
        initialSegment={configSegment}
        onClose={() => setConfigOpen(false)}
        rules={rules}
        audit={audit}
        cards={cards}
        saving={saving}
        onSaveRules={saveRules}
        onReload={load}
      />

      <SweetCardShareSheet
        open={Boolean(shareCard)}
        card={shareCard}
        onClose={handleShareClose}
        onPrepareCredential={prepareCredential}
        onToast={flash}
      />

      {detail && <CardDetailSheet
        card={detail}
        saving={saving}
        canManage={canManage}
        archived={scope === 'ARCHIVED'}
        batchCardCount={batches.find((b) => b.id === detail.batchId)?.cardCount || 1}
        onClose={() => setDetail(null)}
        onShare={() => openShare(detail)}
        onGenerate={() => generateClaimAsset(detail.id, detail.delivery?.claimCredentialStatus === 'ACTIVE').then(async () => { await load(); await openDetail(detail.id); flash('电子卡已生成') }).catch((e) => flash(sweetCardClaimGenerationErrorLabel(e)))}
        onTransition={(action) => transition(detail.id, action)}
        onVoid={() => voidCard(detail.id)}
        onArchive={() => archiveBatch(detail.batchId, batches.find((b) => b.id === detail.batchId)?.cardCount || 1)}
        onRestore={() => restoreBatch(detail.batchId)}
      />}

      {toast && <div role="status" className="fixed inset-x-0 bottom-24 z-[160] mx-auto w-fit max-w-[86%] rounded-full bg-slate-900/90 px-4 py-2 text-[12px] font-bold text-white shadow-lg">{toast}</div>}
      {detailLoading && <div className="fixed inset-0 z-[120] grid place-items-center bg-slate-950/20"><RefreshCw className="h-6 w-6 animate-spin text-white" /></div>}
    </div>
  )
}

function CardDetailSheet({ card, saving, canManage, archived, batchCardCount, onClose, onShare, onGenerate, onTransition, onVoid, onArchive, onRestore }) {
  const claimed = Boolean(card.claimedAt)
  const isVoid = card.status === 'VOID'
  const rows = [
    ['面额', formatCents(card.initialAmountCents)],
    ['余额', formatCents(card.balanceCents)],
    ['受赠人', card.recipientLabel || '—'],
    ['有效期', card.expiresAt ? new Date(card.expiresAt).toLocaleDateString() : '长期'],
    ['领取', sweetCardClaimStatusLabel(card.delivery?.claimStatus)],
    ['激活', sweetCardActivationStatusLabel(card.delivery?.activationStatus)],
    ['领取凭证', sweetCardClaimCredentialStatusLabel(card.delivery?.claimCredentialStatus)],
    ['绑定', sweetCardBindingStatusLabel(card.delivery?.bindingStatus)],
  ]
  return (
    <div className="fixed inset-0 z-[145] flex items-end bg-slate-950/55 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="甜意卡详情">
      <div className="max-h-[92dvh] w-full overflow-y-auto rounded-t-[26px] bg-white" style={{ paddingBottom: 'max(14px, env(safe-area-inset-bottom))' }}>
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-slate-100 bg-white/95 px-4 py-3 backdrop-blur">
          <p className="text-[10px] font-black tracking-[0.2em] text-budu-500">budu SWEET CARD</p>
          <h2 className="ml-auto font-mono text-[12px] text-slate-400">****{String(card.publicCardNo).slice(-4)}</h2>
          <button type="button" onClick={onClose} className="rounded-xl bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-500">关闭</button>
        </div>

        <div className="px-4 py-4">
          <p className="text-[11px] font-bold text-slate-400">当前余额</p>
          <p className="mt-1 text-[30px] font-black leading-none tabular-nums text-slate-900">{formatCents(card.balanceCents)}</p>
          <p className="mt-2 text-[11px] text-slate-400">{card.recipientNote || 'With a little sweetness, from budu.'}</p>

          <dl className="mt-4 grid grid-cols-2 gap-2">
            {rows.map(([label, value]) => (
              <div key={label} className="rounded-xl bg-slate-50 px-3 py-2">
                <dt className="text-[10px] font-bold text-slate-400">{label}</dt>
                <dd className="mt-0.5 truncate text-[13px] font-black text-slate-800">{value || '—'}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-3 grid grid-cols-2 gap-2">
            {!claimed && !isVoid && <button type="button" disabled={saving} onClick={onShare} className="flex h-11 items-center justify-center gap-1.5 rounded-2xl bg-budu-500 text-[13px] font-black text-white disabled:opacity-50"><Share2 className="h-4 w-4" />转发给好友</button>}
            {!isVoid && <button type="button" disabled={saving} onClick={onGenerate} className="flex h-11 items-center justify-center gap-1.5 rounded-2xl bg-slate-100 text-[13px] font-black text-slate-700 disabled:opacity-50"><Gift className="h-4 w-4" />{card.delivery?.claimCredentialStatus === 'ACTIVE' ? '重新生成电子卡' : '生成电子卡'}</button>}
            {card.status === 'ACTIVE' && <button type="button" disabled={saving} onClick={() => onTransition('freeze')} className="flex h-11 items-center justify-center gap-1.5 rounded-2xl bg-white text-[13px] font-bold text-slate-600 ring-1 ring-slate-200"><Snowflake className="h-4 w-4" />冻结</button>}
            {card.status === 'FROZEN' && <button type="button" disabled={saving} onClick={() => onTransition('unfreeze')} className="flex h-11 items-center justify-center gap-1.5 rounded-2xl bg-white text-[13px] font-bold text-slate-600 ring-1 ring-slate-200"><Sun className="h-4 w-4" />解冻</button>}
            {card.status === 'CREATED' && <button type="button" disabled={saving} onClick={() => onTransition('activate')} className="flex h-11 items-center justify-center gap-1.5 rounded-2xl bg-white text-[13px] font-bold text-slate-600 ring-1 ring-slate-200"><Lock className="h-4 w-4" />手动激活</button>}
            {canManage && card.batchId && (archived ? (
              <button type="button" disabled={saving} onClick={onRestore} className="flex h-11 items-center justify-center gap-1.5 rounded-2xl bg-emerald-50 text-[13px] font-black text-emerald-700 disabled:opacity-50"><ArchiveRestore className="h-4 w-4" />从归档恢复</button>
            ) : (
              <button type="button" disabled={saving} onClick={onArchive} className="flex h-11 items-center justify-center gap-1.5 rounded-2xl bg-slate-100 text-[13px] font-black text-slate-700 disabled:opacity-50"><Archive className="h-4 w-4" />{batchCardCount > 1 ? `归档所属批次(${batchCardCount}张)` : '归档'}</button>
            ))}
          </div>

          {(card.ledger || []).length > 0 && <details className="mt-4 rounded-2xl bg-slate-50 px-3.5 py-2.5">
            <summary className="cursor-pointer text-[12px] font-black text-slate-500">使用明细（{card.ledger.length}）</summary>
            <ul className="mt-2 divide-y divide-white">
              {card.ledger.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-2 py-2 text-[11px]">
                  <span className="text-slate-500">{new Date(entry.createdAt).toLocaleString()}</span>
                  <span className="font-black tabular-nums text-slate-700">{entry.type === 'REDEEM' ? '-' : '+'}{formatCents(BigInt(entry.amountCents) < 0n ? -BigInt(entry.amountCents) : entry.amountCents)}</span>
                </li>
              ))}
            </ul>
          </details>}

          {canManage && !['VOID', 'EXHAUSTED', 'EXPIRED'].includes(card.status) && <button type="button" disabled={saving} onClick={onVoid} className="mt-4 inline-flex items-center gap-1 text-[11px] font-bold text-rose-500"><Ban className="h-3 w-3" />作废这张卡</button>}
        </div>
      </div>
    </div>
  )
}
