import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, Building2, CalendarDays, CheckCircle2, ChevronDown, FileSpreadsheet, Pencil, ShieldAlert, Trash2, Users, WalletCards,
} from 'lucide-react'
import {
  allStores, currentEmployeeDirectory, dailyRows, dailyStoreStaffRows, monthLabel, localEntries,
} from '../utils/selectors'
import { formatMoney } from '../utils/format'
import { centsToYuan, formatCents, yuanToCents } from '../utils/pos'
import { api } from '../utils/api'
import {
  getDailyStoreStaffMonthState, loadDailyStoreStaffMonth, loadUserData, onUserDataUpdated,
} from '../utils/userData'
import BuduSuccessFeedback from './feedback/BuduSuccessFeedback'
import { t } from '../utils/text'
import StoreEntryExportModal from './StoreEntryExportModal'
import { resolvePerformanceDutyStaff } from '../utils/storeEntryParticipantDisplay'
import { DAILY_ENTRY_CAPABILITIES, hasDailyEntryCapability } from '../../shared/accountPermissions'
import { OverlayPanel, OverlayViewport } from './overlay/OverlayPrimitives'

function pad(n) {
  return String(n).padStart(2, '0')
}

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function authorityKey(accountId, store, date) {
  return `${String(accountId || '')}|${String(store || '')}|${String(date || '')}`
}

function serializeStaffRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((s) => ({
    employeeId: s.employeeId || '',
    participantUserId: s.participantUserId || '',
    participantType: s.participantType || 'LEGACY_UNKNOWN',
    staffId: s.staffId,
    staffName: s.staffName,
    scheduledStartTime: s.scheduledStartTime,
    scheduledEndTime: s.scheduledEndTime,
    actualStartTime: s.actualStartTime,
    actualEndTime: s.actualEndTime,
    breakMinutes: s.breakMinutes,
    actualHours: s.actualHours,
    historicalPayrollHours: s.historicalPayrollHours,
    payableHoursSource: s.payableHoursSource || 'ACTUAL_HOURS',
    attendanceStatus: s.attendanceStatus,
    prefillSource: '',
  }))
}

export function buildScheduleDraftRows(directory, existingRows, confirmed) {
  const persisted = serializeStaffRows(existingRows)
  if (confirmed || persisted.length > 0) return persisted
  const employeeById = new Map((Array.isArray(directory?.employees) ? directory.employees : [])
    .map((employee) => [employee.employeeId, employee]))
  const seen = new Set()
  const rows = []
  for (const employeeId of Array.isArray(directory?.schedule?.scheduledEmployeeIds)
    ? directory.schedule.scheduledEmployeeIds : []) {
    const employee = employeeById.get(employeeId)
    if (!employee || seen.has(employeeId)) continue
    seen.add(employeeId)
    rows.push({
      employeeId,
      participantUserId: '',
      participantType: 'EMPLOYEE',
      staffId: `employee:${employeeId}`,
      staffName: employee.label,
      scheduledStartTime: '',
      scheduledEndTime: '',
      actualStartTime: '',
      actualEndTime: '',
      breakMinutes: 0,
      actualHours: '',
      historicalPayrollHours: null,
      payableHoursSource: 'ACTUAL_HOURS',
      attendanceStatus: 'normal',
      prefillSource: 'schedule',
    })
  }
  return rows
}

const inputCls = 'input'

function Field({ label, icon: Icon, children }) {
  return (
    <div className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-500">
        {Icon && <Icon className="h-3.5 w-3.5 text-budu-600" />}
        {label}
      </span>
      {children}
    </div>
  )
}

function StaffMultiSelect({ participants, selectedRows, onToggle, disabled }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    if (!needle) return participants
    return participants.filter((participant) => [
      participant.label,
      participant.employeeNo,
      participant.currentStoreName,
    ].some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(needle)))
  }, [participants, query])
  return (
    <div className="relative w-full max-w-md min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className={`${inputCls} flex min-h-[38px] w-full items-center gap-1 text-left`}
      >
        <Users className="h-4 w-4 shrink-0 text-budu-600" />
        <span className="flex-1 truncate text-sm">{selectedRows.length === 0 ? '选择值班人员（可多选）' : `已选 ${selectedRows.length} 人`}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <div data-budu-overlay-ignore className="fixed inset-0 z-30 bg-slate-900/10 sm:bg-transparent" onClick={() => setOpen(false)} />
          <div
            data-testid="staff-candidate-panel"
            className="fixed inset-x-3 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-40 max-h-[min(70vh,30rem)] overflow-y-auto overscroll-contain rounded-2xl border border-slate-100 bg-white p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-full sm:mt-1 sm:max-h-72 sm:w-full sm:pb-2 sm:shadow-lg"
          >
            <div className="sticky top-0 z-10 bg-white px-1 pb-2 pt-1">
              <p className="px-1 py-1 text-[11px] font-semibold text-slate-400">点击姓名多选值班人员</p>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索员工姓名"
                aria-label="搜索值班人员"
                className={`${inputCls} h-9 min-w-0 text-sm`}
              />
            </div>
            {filtered.map((participant) => {
              const id = participant.employeeId || participant.participantUserId
              const checked = selectedRows.some((row) => (
                (participant.employeeId && row.employeeId === participant.employeeId)
                || (participant.participantUserId && row.participantUserId === participant.participantUserId)
              ))
              return (
                <button
                  key={`${participant.participantType}:${id}`}
                  type="button"
                  onClick={() => onToggle(participant)}
                  aria-label={`${participant.label}${participant.employeeNo ? ` ${participant.employeeNo}` : ''}`}
                  className={`grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-xl px-2.5 py-2.5 text-left text-xs transition ${checked ? 'bg-budu-50' : 'hover:bg-slate-50'}`}
                >
                  <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px] font-bold ${checked ? 'border-budu-500 bg-budu-500 text-white' : 'border-slate-200 text-transparent'}`}>✓</span>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 break-words font-semibold text-slate-700">{participant.label}</span>
                    {participant.employeeNo && <span className="whitespace-nowrap text-[10px] text-slate-400">{participant.employeeNo}</span>}
                    {participant.currentStoreName && <span className="min-w-0 break-words text-[10px] text-slate-400">{participant.currentStoreName}</span>}
                    {participant.participantType === 'NON_EMPLOYEE_SUBSTITUTE' && (
                      <span className="whitespace-nowrap rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">运营替代·不计工资</span>
                    )}
                  </span>
                </button>
              )
            })}
            {filtered.length === 0 && <p className="px-3 py-6 text-center text-xs text-slate-400">未找到匹配人员</p>}
          </div>
        </>
      )}
    </div>
  )
}

export default function StoreEntryPage({ user, onBack, registerNavigationGuard }) {
  // 门店范围：与全局 Header 同口径——超管/财务/管理员全量，其余角色仅限账号绑定门店
  const visibleStores = useMemo(() => {
    if (user?.role === 'developer' || user?.role === 'public' || user?.role === 'finance' || user?.role === 'admin') return allStores()
    return allStores().filter((s) => (user?.storeKeys || []).includes(s.key))
  }, [user])
  const [store, setStore] = useState(() => (visibleStores[0] ? visibleStores[0].key : ''))
  const [date, setDate] = useState(todayStr)
  const [overview, setOverview] = useState(null)
  const [loadingOverview, setLoadingOverview] = useState(true)
  const overviewRef = useRef(null)
  const [error, setError] = useState('')
  const [savedTip, setSavedTip] = useState('')
  const [inc, setInc] = useState('')
  const [ord, setOrd] = useState('')
  const [staffRows, setStaffRows] = useState([])
  const [participants, setParticipants] = useState([])
  const [scheduleIssues, setScheduleIssues] = useState([])
  const [saving, setSaving] = useState('')
  const [exportOpen, setExportOpen] = useState(false)
  const [feedback, setFeedback] = useState(null)
  const [, setVersion] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [authorityStatus, setAuthorityStatus] = useState('loading')
  const [loadedAuthorityKey, setLoadedAuthorityKey] = useState('')
  const [refreshNotice, setRefreshNotice] = useState('')
  const authorityGenerationRef = useRef(0)
  const selectedAuthorityRef = useRef(null)
  const loadedAuthorityRef = useRef('')
  const requestSequenceRef = useRef(0)
  const latestRequestRef = useRef(0)
  const dirtyRef = useRef(false)
  const pendingTransitionRef = useRef(null)
  const loadOverviewRef = useRef(null)

  const currentAuthorityKey = authorityKey(user?.id, store, date)
  if (selectedAuthorityRef.current?.key !== currentAuthorityKey) {
    authorityGenerationRef.current += 1
    selectedAuthorityRef.current = {
      accountId: String(user?.id || ''),
      store,
      date,
      key: currentAuthorityKey,
      generation: authorityGenerationRef.current,
    }
  }

  const month = date && date.length >= 7 ? date.slice(0, 7) : '2026-07'
  const storeInfo = allStores().find((s) => s.key === store)
  const rows = dailyRows(month, store)
  const performanceStaffMonth = getDailyStoreStaffMonthState(month)
  const performanceStaffRows = dailyStoreStaffRows(month)
  const performanceEmployeeDirectory = currentEmployeeDirectory('all')
  const source = overview?.salesDataSource || 'manual'
  const confirmed = overview?.entry?.status === 'confirmed'
  const salesDataStatus = overview?.salesDataStatus || 'waiting_input'
  const pos = overview?.pos || null
  const adjustmentCents = overview?.entry ? BigInt(overview.entry.hybridAdjustmentCents) : 0n
  const canEdit = hasDailyEntryCapability(user, DAILY_ENTRY_CAPABILITIES.EDIT)
  const canConfirm = hasDailyEntryCapability(user, DAILY_ENTRY_CAPABILITIES.CONFIRM)
  const canRevise = hasDailyEntryCapability(user, DAILY_ENTRY_CAPABILITIES.REVISE)
  const canEditSales = source === 'manual' && canEdit && !confirmed
  const hasHistoricalStaff = staffRows.some((row) => row.payableHoursSource === 'LEGACY_PAYROLL_HOURS')
  const canEditStaff = canEdit && !confirmed && !hasHistoricalStaff
  const authorityReady = authorityStatus === 'loaded' && loadedAuthorityKey === currentAuthorityKey

  const loadOverviewFor = useCallback(async (authority, options = {}) => {
    if (!authority?.store || !authority?.date) return { discarded: true }
    const requestToken = requestSequenceRef.current + 1
    requestSequenceRef.current = requestToken
    latestRequestRef.current = requestToken
    const isCurrent = () => (
      selectedAuthorityRef.current?.key === authority.key
      && selectedAuthorityRef.current?.generation === authority.generation
      && latestRequestRef.current === requestToken
    )
    if (options.mode !== 'background') setLoadingOverview(true)
    setError('')
    try {
      const [data, directory] = await Promise.all([
        api(`/v2/daily-entry/overview?store=${encodeURIComponent(authority.store)}&date=${authority.date}`),
        api(`/v2/daily-participants?store=${encodeURIComponent(authority.store)}&date=${authority.date}`),
      ])
      if (!isCurrent()) return { discarded: true }
      if (data?.storeKey !== authority.store || data?.date !== authority.date) {
        throw new Error('门店业绩响应权威与当前门店/日期不一致，请重试')
      }
      const nextParticipants = [
        ...(directory.employees || []).map((row) => ({
          ...row,
          label: row.label,
          currentStoreName: row.currentStoreKey
            ? (allStores().find((candidate) => candidate.key === row.currentStoreKey)?.name || row.currentStoreKey)
            : '',
        })),
        ...(directory.substitutes || []).map((row) => ({ ...row, label: row.label })),
      ]
      setParticipants(nextParticipants)
      if (options.mode === 'background' && dirtyRef.current) {
        setRefreshNotice('服务器有新数据可刷新；当前未保存编辑已保留。')
        return { preservedDirty: true }
      }
      setOverview(data)
      overviewRef.current = data
      setInc(data.entry ? centsToYuan(data.entry.incCents) : '')
      setOrd(data.entry ? String(data.entry.ord ?? '') : '')
      setStaffRows(buildScheduleDraftRows({ ...directory, employees: nextParticipants.filter((row) => row.employeeId) }, data.staff, data.entry?.status === 'confirmed'))
      setScheduleIssues(Array.isArray(directory?.schedule?.unresolved) ? directory.schedule.unresolved : [])
      dirtyRef.current = false
      setDirty(false)
      setAuthorityStatus('loaded')
      loadedAuthorityRef.current = authority.key
      setLoadedAuthorityKey(authority.key)
      setRefreshNotice('')
      return { loaded: true }
    } catch (e) {
      if (!isCurrent()) return { discarded: true }
      setError(e.message)
      if (options.mode !== 'background' || loadedAuthorityRef.current !== authority.key) {
        setAuthorityStatus('error')
        loadedAuthorityRef.current = ''
        setLoadedAuthorityKey('')
      }
      return { error: e }
    } finally {
      if (isCurrent()) setLoadingOverview(false)
    }
  }, [])
  loadOverviewRef.current = loadOverviewFor

  useEffect(() => {
    const authority = { ...selectedAuthorityRef.current }
    latestRequestRef.current = requestSequenceRef.current + 1
    requestSequenceRef.current = latestRequestRef.current
    dirtyRef.current = false
    setDirty(false)
    loadedAuthorityRef.current = ''
    setLoadedAuthorityKey('')
    setAuthorityStatus('loading')
    setLoadingOverview(true)
    setOverview(null)
    overviewRef.current = null
    setInc('')
    setOrd('')
    setStaffRows([])
    setScheduleIssues([])
    setRefreshNotice('')
    loadOverviewFor(authority)
  }, [currentAuthorityKey, loadOverviewFor])

  // 进入页面时自动拉取最新共享数据（POS 自动同步/他端录入的最新业绩），
  // 并在后台数据合并完成后重渲染，避免首次打开只看到旧缓存（如 KV 只到 8-17）。
  useEffect(() => {
    const unsubscribe = onUserDataUpdated(() => {
      setVersion((v) => v + 1)
      const authority = { ...selectedAuthorityRef.current }
      loadOverviewRef.current?.(authority, { mode: 'background' }).catch(() => {})
    })
    loadUserData()
      .then(() => setVersion((v) => v + 1))
      .catch(() => {})
    return unsubscribe
  }, [])

  useEffect(() => {
    loadDailyStoreStaffMonth(month).catch(() => {})
  }, [month, user?.id])

  useEffect(() => {
    const onBeforeUnload = (event) => {
      if (!dirtyRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  const refreshAll = async () => {
    await loadUserData().catch(() => {})
  }

  const reloadCurrentAuthority = (options) => loadOverviewFor({ ...selectedAuthorityRef.current }, options)

  const requireLoadedAuthority = () => {
    const authority = { ...selectedAuthorityRef.current }
    if (loadedAuthorityRef.current !== authority.key || authorityStatus !== 'loaded') {
      setError('当前门店/日期的权威数据尚未完整加载，已阻止保存，请重试。')
      return null
    }
    return authority
  }

  const markDirty = () => {
    dirtyRef.current = true
    setDirty(true)
    setRefreshNotice('')
  }

  const requestTransition = useCallback((action) => {
    if (!dirtyRef.current) return action?.()
    pendingTransitionRef.current = action
    setDiscardOpen(true)
    return undefined
  }, [])

  useEffect(() => {
    registerNavigationGuard?.(requestTransition)
    return () => registerNavigationGuard?.(null)
  }, [registerNavigationGuard, requestTransition])

  const continueAfterDiscard = () => {
    const action = pendingTransitionRef.current
    pendingTransitionRef.current = null
    dirtyRef.current = false
    setDirty(false)
    setDiscardOpen(false)
    action?.()
  }

  const retryCurrentAuthority = () => {
    dirtyRef.current = false
    setDirty(false)
    loadedAuthorityRef.current = ''
    setLoadedAuthorityKey('')
    setAuthorityStatus('loading')
    setLoadingOverview(true)
    setOverview(null)
    overviewRef.current = null
    setInc('')
    setOrd('')
    setStaffRows([])
    setScheduleIssues([])
    setRefreshNotice('')
    reloadCurrentAuthority()
  }

  const tip = (message, ok = true) => {
    setSavedTip(message)
    setTimeout(() => setSavedTip(''), 2500)
  }

  const toggleStaff = (participant) => {
    if (hasHistoricalStaff || !authorityReady) return
    const exists = staffRows.some((row) => (
      (participant.employeeId && row.employeeId === participant.employeeId)
      || (participant.participantUserId && row.participantUserId === participant.participantUserId)
    ))
    const nextRows = exists
      ? staffRows.filter((row) => !(
        (participant.employeeId && row.employeeId === participant.employeeId)
        || (participant.participantUserId && row.participantUserId === participant.participantUserId)
      ))
      : [...staffRows, {
        employeeId: participant.employeeId || '',
        participantUserId: participant.participantUserId || '',
        participantType: participant.participantType,
        staffId: participant.employeeId ? `employee:${participant.employeeId}` : `user:${participant.participantUserId}`,
        staffName: participant.label,
        scheduledStartTime: '',
        scheduledEndTime: '',
        actualStartTime: '',
        actualEndTime: '',
        breakMinutes: 0,
        actualHours: '',
        attendanceStatus: 'normal',
        prefillSource: '',
      }]
    setStaffRows(nextRows)
    markDirty()
  }

  const updateActualHours = (staffId, value) => {
    setStaffRows((current) => current.map((row) => row.staffId === staffId ? { ...row, actualHours: value } : row))
    markDirty()
  }

  const confirmEntry = async () => {
    const authority = requireLoadedAuthority()
    if (!authority) return
    setSaving('confirm')
    setError('')
    try {
      const result = await api('/v2/daily-entry/confirm', {
        method: 'POST',
        body: JSON.stringify({
          storeKey: authority.store,
          date: authority.date,
          version: overview?.entry?.version || 0,
          ...(source === 'manual' ? { manualSales: { incCents: Number(yuanToCents(inc)), ord: Number(ord) } } : {}),
          items: staffRows.map((row) => ({
            employeeId: row.employeeId || undefined,
            participantUserId: row.participantUserId || undefined,
            actualStartTime: row.actualStartTime || '',
            actualEndTime: row.actualEndTime || '',
            breakMinutes: Number(row.breakMinutes || 0),
            actualHours: row.actualHours,
            attendanceStatus: row.attendanceStatus || 'normal',
          })),
          reason: '确认今日录入',
        }),
      })
      dirtyRef.current = false
      setDirty(false)
      setOverview((current) => ({ ...current, entry: result.entry, staff: result.staff, salesDataSource: result.salesDataSource, ...(result.pos ? { pos: result.pos } : {}) }))
      overviewRef.current = { ...(overviewRef.current || {}), entry: result.entry, staff: result.staff }
      setStaffRows(serializeStaffRows(result.staff))
      await refreshAll()
      await reloadCurrentAuthority()
      setFeedback({ title: t('确认成功'), description: t('今日营业与实际值班事实已一次确认') })
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving('')
    }
  }

  const handleEdit = (r) => {
    requestTransition(() => {
      setDate(`${month}-${r.d}`)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    })
  }

  const handleDelete = async (d) => {
    if (!window.confirm(t('确定删除该日业绩吗？删除后不可恢复'))) return
    setError('')
    try {
      await api('/v2/daily-entries', {
        method: 'DELETE',
        body: JSON.stringify({ storeKey: store, date: `${month}-${d.slice(3)}` }),
      })
      await refreshAll()
      await reloadCurrentAuthority()
      tip(t('当日业绩已删除 ✓'))
    } catch (e) {
      setError(e.message)
      await refreshAll()
    }
  }

  const statusBadge = () => {
    if (source === 'pos' || source === 'hybrid') {
      if (salesDataStatus === 'sync_failed') {
        return <span className="inline-flex items-center gap-1 rounded-lg bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-600"><ShieldAlert className="h-3.5 w-3.5" />POS 数据同步异常</span>
      }
      return <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" />POS 自动同步</span>
    }
    return <span className="inline-flex items-center gap-1 rounded-lg bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-600"><WalletCards className="h-3.5 w-3.5" />当前门店暂未接入 POS</span>
  }

  const posCards = pos ? [
    { label: '有效销售额', value: formatCents(BigInt(pos.effectiveAfterRefund) + adjustmentCents) },
    { label: '实收金额', value: formatCents(BigInt(pos.effectiveAfterRefund)) },
    { label: '订单数', value: String(pos.orderCount) },
    { label: '客单价', value: formatCents(BigInt(pos.avgOrderCents)) },
    { label: '退款金额', value: formatCents(BigInt(pos.refundAmount)) },
    { label: '折扣金额', value: formatCents(BigInt(pos.discountAmount)) },
  ] : []

  const channelCards = pos ? [
    ['微信', pos.byChannel.wechat],
    ['支付宝', pos.byChannel.alipay],
    ['现金', pos.byChannel.cash],
    ['其他', pos.byChannel.other],
  ] : []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <button onClick={onBack} className="flex items-center gap-1.5 rounded-2xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-500 shadow-card transition hover:text-budu-600">
          <ArrowLeft className="h-4 w-4" />{t('返回首页')}
        </button>
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t('每日门店录入')}</h2>
          <p className="mt-0.5 text-[13px] text-slate-400">{t('营业数据按门店来源自动/人工匹配，值班人员与工时用于工资与人效计算')}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {statusBadge()}
          {dirty && <span data-testid="daily-entry-dirty" className="rounded-lg bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-600">有未确认修改</span>}
          {confirmed && <span className="rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-600">已确认{overview?.entry?.confirmedBy ? ` · ${overview.entry.confirmedBy}` : ''}</span>}
          <button onClick={() => setExportOpen(true)} className="btn-secondary px-3 py-2"><FileSpreadsheet className="h-4 w-4 text-budu-600" />{t('表格导出')}</button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</div>}
      {refreshNotice && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          <span>{refreshNotice}</span>
          <button type="button" onClick={() => requestTransition(retryCurrentAuthority)} className="whitespace-nowrap rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold">重新加载</button>
        </div>
      )}
      {savedTip && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-600">{savedTip}</div>}

      {visibleStores.length === 0 && (
        <div className="card grid place-items-center p-10 text-center">
          <div>
            <Building2 className="mx-auto h-8 w-8 text-slate-200" />
            <p className="mt-3 text-sm font-semibold text-slate-600">{t('当前账号未绑定门店，请联系开发者绑定后再录入')}</p>
          </div>
        </div>
      )}

      {visibleStores.length > 0 && (<>
      <div className="card p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t('门店')} icon={Building2}>
            <select value={store} onChange={(e) => { const next = e.target.value; requestTransition(() => setStore(next)) }} className={inputCls}>
              {visibleStores.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
            </select>
          </Field>
          <Field label={t('日期')} icon={CalendarDays}>
            <input type="date" value={date} onChange={(e) => { const next = e.target.value; requestTransition(() => setDate(next)) }} className={inputCls} />
          </Field>
          <div className="flex items-end">
            <p className="text-xs text-slate-400">
              {source === 'pos' ? '该门店营业数据由 POS 自动同步，普通员工不可修改。' : source === 'hybrid' ? '该门店优先读取 POS 数据，管理员可调整补录。' : '当前门店暂未接入 POS，营业数据由门店录入。'}
            </p>
          </div>
        </div>
      </div>

      <section className="card p-5">
        <h3 className="text-[15px] font-bold text-slate-800">今日经营概览</h3>
        {authorityStatus === 'loading' || (loadingOverview && !authorityReady) ? (
          <p className="mt-3 text-sm text-slate-400">正在加载…</p>
        ) : authorityStatus === 'error' || !authorityReady ? (
          <div className="mt-3 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3">
            <p className="text-sm font-semibold text-rose-600">当前门店/日期的数据未完整加载，页面不会以 0 或空值代替。</p>
            <button type="button" onClick={() => requestTransition(retryCurrentAuthority)} className="mt-3 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-rose-600 shadow-sm">重试加载</button>
          </div>
        ) : source === 'pos' || source === 'hybrid' ? (
          <>
            {salesDataStatus === 'sync_failed' ? (
              <p className="mt-3 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600">POS 数据同步异常，请稍后刷新；值班人员与库存/备注填写不受影响。</p>
            ) : pos ? (
              <>
                <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                  {posCards.map((card) => (
                    <div key={card.label} className="rounded-2xl border border-slate-100 bg-slate-50/70 p-3">
                      <p className="text-[11px] text-slate-400">{card.label}</p>
                      <p className="mt-1 text-lg font-black tabular-nums text-slate-900">{card.value}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-500">
                  {channelCards.map(([label, value]) => (
                    <span key={label}>{label} <b className="tabular-nums text-slate-700">{formatCents(BigInt(value))}</b></span>
                  ))}
                </div>
                {BigInt(pos.effectiveSales) === 0n && <p className="mt-3 text-xs text-slate-400">今日 POS 销售额 ¥0.00（确无订单）</p>}
                {adjustmentCents !== 0n && <p className="mt-2 text-xs text-emerald-600">管理员调整：{adjustmentCents > 0n ? '+' : ''}{formatCents(adjustmentCents)}</p>}
              </>
            ) : (
              <p className="mt-3 text-sm text-slate-400">POS 数据同步中…</p>
            )}
            {source === 'hybrid' && canRevise && <p className="mt-3 text-xs text-slate-400">POS 调整属于受控历史修正，不在本次当日原子确认中修改。</p>}
          </>
        ) : (
          <>
            <p className="mt-2 text-xs text-slate-400">{salesDataStatus === 'waiting_input' ? '等待门店录入' : '营业数据已录入'}</p>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t('营业收入（元）')}><input type="number" step="0.01" min="0" value={inc} onChange={(e) => { markDirty(); setInc(e.target.value) }} placeholder="0.00" disabled={!authorityReady || !canEditSales} className={inputCls} /></Field>
              <Field label={t('订单数（单）')}><input type="number" step="1" min="0" value={ord} onChange={(e) => { markDirty(); setOrd(e.target.value) }} placeholder="0" disabled={!authorityReady || !canEditSales} className={inputCls} /></Field>
              <div className="flex items-end"><p className="rounded-xl bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">本地修改不会自动保存，最终确认时与实际值班事实一次提交。</p></div>
            </div>
          </>
        )}
      </section>

      <section className="card p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-[15px] font-bold text-slate-800">今日值班</h3>
          {dirty && <span className="text-xs font-semibold text-amber-600">仅保存在本地 draft</span>}
        </div>
        <div className="mt-4">
          <StaffMultiSelect
            participants={participants}
            selectedRows={staffRows}
            onToggle={toggleStaff}
            disabled={!authorityReady || !canEditStaff}
          />
          {hasHistoricalStaff && (
            <p className="mt-3 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
              历史计薪工时（无考勤事实）为只读权威记录，不能在日常值班录入中覆盖或删除。
            </p>
          )}
          {!confirmed && scheduleIssues.length > 0 && (
            <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
              历史排班身份未解析 {scheduleIssues.length} 人，未自动预填；请通过员工选择器按真实 Employee 重新选择。
            </p>
          )}
          {staffRows.length > 0 && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {staffRows.map((row) => (
                <div key={row.staffId} className="min-w-0 rounded-2xl border border-budu-100 bg-budu-50/60 p-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-bold text-budu-700">{row.staffName}</span>
                    {row.participantType === 'NON_EMPLOYEE_SUBSTITUTE' && <span className="shrink-0 text-[10px] text-amber-600">不计工资</span>}
                    {row.prefillSource === 'schedule' && <span className="shrink-0 text-[10px] font-semibold text-budu-500">排班预填</span>}
                    {row.payableHoursSource === 'LEGACY_PAYROLL_HOURS' && <span className="shrink-0 text-[10px] text-amber-600">历史只读</span>}
                  </div>
                  <label className="mt-2 block text-[11px] font-semibold text-slate-500">
                    实际工时（小时）
                    <input
                      data-testid={`daily-entry-hours-${row.staffId}`}
                      type="number"
                      min="0"
                      max="24"
                      step="0.25"
                      inputMode="decimal"
                      value={row.payableHoursSource === 'LEGACY_PAYROLL_HOURS' ? row.historicalPayrollHours ?? '' : row.actualHours ?? ''}
                      onChange={(event) => updateActualHours(row.staffId, event.target.value)}
                      disabled={!canEditStaff || row.payableHoursSource === 'LEGACY_PAYROLL_HOURS'}
                      placeholder="待填写"
                      className={`${inputCls} mt-1 h-10 min-w-0`}
                    />
                  </label>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="card p-5">
        <h3 className="text-[15px] font-bold text-slate-800">闭店确认</h3>
        <p className="mt-2 text-xs text-slate-400">提交前请确认：营业数据完整、值班人员与实际工时已确认。确认后普通员工不可修改，店长/管理员可取消确认。</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {confirmed ? (
            <span className="rounded-xl bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-500">已确认记录在普通每日录入中只读</span>
          ) : (
            <button data-testid="daily-entry-confirm" onClick={confirmEntry} disabled={saving === 'confirm' || !authorityReady || !canConfirm} className="flex min-h-11 items-center gap-2 rounded-xl bg-budu-500 px-6 py-2.5 text-sm font-semibold text-white shadow-sm disabled:opacity-50"><CheckCircle2 className="h-4 w-4" />{saving === 'confirm' ? '确认中…' : '确认今日录入'}</button>
          )}
          {confirmed && overview?.entry?.confirmedAt && <span className="text-xs text-slate-400">确认时间：{new Date(overview.entry.confirmedAt).toLocaleString('zh-CN', { hour12: false })}</span>}
        </div>
      </section>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
          <h3 className="text-[15px] font-bold text-slate-800">{t('业绩明细')}</h3>
          <span className="rounded-lg bg-budu-50 px-2 py-0.5 text-xs font-semibold text-budu-600">{monthLabel(month)} · {storeInfo ? storeInfo.name : ''}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead>
              <tr className="bg-slate-50/80 text-xs text-slate-400">
                <th className="px-5 py-3 font-semibold">{t('日期')}</th>
                <th className="px-4 py-3 font-semibold">{t('值班人员')}</th>
                <th className="px-4 py-3 font-semibold">{t('营业收入')}</th>
                <th className="px-4 py-3 font-semibold">{t('订单数')}</th>
                <th className="px-4 py-3 font-semibold">{t('客单价')}</th>
                <th className="px-4 py-3 font-semibold">{t('来源')}</th>
                <th className="px-4 py-3 font-semibold text-right">{t('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const entry = localEntries()[`${month}|${store}|${r.d}`]
                const performanceDate = `${month}-${String(r.d || '').includes('-') ? String(r.d).slice(3) : String(r.d)}`
                const dutyStaff = resolvePerformanceDutyStaff({
                  monthRows: performanceStaffRows,
                  monthLoaded: performanceStaffMonth.status === 'loaded' && performanceStaffMonth.hasPayload,
                  storeKey: store,
                  date: performanceDate,
                  legacyStaffNames: entry && Array.isArray(entry.staff) ? entry.staff : [],
                  employeeDirectory: performanceEmployeeDirectory,
                })
                return (
                  <tr key={r.d} className="border-t border-slate-50 transition hover:bg-slate-50">
                    <td className="px-5 py-3 font-medium text-slate-700">{r.d}</td>
                    <td className="px-4 py-3" data-testid={`performance-duty-staff-${performanceDate}`} data-authority={dutyStaff.source}>
                      {dutyStaff.source === 'unresolved' ? (
                        <span aria-label="值班人员载入中" className="text-xs text-slate-300">…</span>
                      ) : dutyStaff.participants.length > 0 ? (
                        <div className="flex min-w-0 flex-wrap gap-1">
                          {dutyStaff.participants.map((participant) => (
                            <span
                              key={participant.key}
                              title={participant.label}
                              data-participant-key={participant.key}
                              className="max-w-full break-words rounded-md bg-budu-50 px-1.5 py-0.5 text-[11px] font-semibold text-budu-600"
                            >
                              {participant.label}
                            </span>
                          ))}
                        </div>
                      ) : <span className="text-xs text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-600">¥{formatMoney(r.inc)}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-600">{r.ord.toLocaleString('zh-CN')}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-600">¥{r.ord > 0 ? (r.inc / r.ord).toFixed(2) : '0.00'}</td>
                    <td className="px-4 py-3">{r.local ? <span className="rounded-md bg-budu-50 px-1.5 py-0.5 text-[10px] font-bold text-budu-600">{t('本地录入')}</span> : <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-400">{t('报表')}</span>}</td>
                    <td className="px-4 py-3 text-right">
                      {r.local && entry?.status !== 'confirmed' && canEdit && (
                        <div className="inline-flex items-center gap-1"><button onClick={() => handleEdit(r)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-budu-500 transition hover:bg-budu-50"><Pencil className="h-3.5 w-3.5" />{t('修改')}</button><button onClick={() => handleDelete(r.d)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-rose-400 transition hover:bg-rose-50"><Trash2 className="h-3.5 w-3.5" />{t('删除')}</button></div>
                      )}
                      {r.local && entry?.status === 'confirmed' && <span className="text-xs font-semibold text-slate-400">已确认·只读</span>}
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && <tr><td colSpan="7" className="px-5 py-12 text-center text-sm text-slate-300">{t('暂无数据，请在上方录入')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-center text-[11px] text-slate-300">
        {t('营业数据以门店来源为准（POS 自动同步 / 人工录入）；值班与工时以每日实际确认为准，用于工资与人效计算')}
      </p>
      </>)}

      {exportOpen && <StoreEntryExportModal storeKey={store} storeName={storeInfo ? storeInfo.name : ''} onClose={() => setExportOpen(false)} />}

      {discardOpen && (
        <OverlayViewport data-testid="daily-entry-unsaved-dialog" className="fixed inset-0 z-[110] grid place-items-center p-4">
          <button
            type="button"
            aria-label="关闭未保存提示"
            className="budu-overlay-backdrop absolute inset-0 bg-slate-900/45 backdrop-blur-sm"
            onClick={() => { pendingTransitionRef.current = null; setDiscardOpen(false) }}
          />
          <OverlayPanel role="dialog" aria-modal="true" aria-labelledby="daily-entry-unsaved-title" className="relative w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3 id="daily-entry-unsaved-title" className="text-base font-bold text-slate-800">当前修改尚未确认</h3>
            <p className="mt-2 text-sm leading-6 text-slate-500">离开后，本次营业数据、值班人员与实际工时修改都不会保存。</p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => { pendingTransitionRef.current = null; setDiscardOpen(false) }} className="rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-600">继续编辑</button>
              <button type="button" onClick={continueAfterDiscard} className="rounded-xl bg-rose-500 px-4 py-2.5 text-sm font-semibold text-white">放弃修改</button>
            </div>
          </OverlayPanel>
        </OverlayViewport>
      )}

      {/* 卡皮巴拉提交成功动画 */}
      {feedback && (
        <BuduSuccessFeedback
          open={!!feedback}
          title={feedback.title}
          description={feedback.description}
          onClose={() => setFeedback(null)}
        />
      )}
    </div>
  )
}
