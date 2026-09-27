import { useEffect, useMemo, useState } from 'react'
import { BadgeDollarSign, Check, X } from 'lucide-react'
import { api } from '../utils/api'
import { periodLabel } from '../utils/payrollSlip'
import { currentEmployeeDirectory, storeName } from '../utils/selectors'
import { resolvePayrollCalculation } from '../utils/payrollResolver'
import {
  addBusinessDays,
  businessDateDayOfWeek,
  payrollPeriodKindLabel,
  resolvePayrollPeriod,
} from '../utils/payrollPeriod'
import {
  getBigBonuses,
  getDailyPayAdjustments,
  getDailyStoreStaffRange,
  getDailyStoreStaffRangeState,
  getEntries,
  getStores,
  loadDailyStoreStaffRange,
} from '../utils/userData'
import {
  bindAuthoritativeIssuePreflight,
  buildIssuePayloadRows,
  buildIssueRows,
  preflightIssueSelection,
} from '../utils/payrollIssue'

const yuan = (value) => `¥${Number(value || 0).toFixed(2)}`

function shanghaiToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${byType.year}-${byType.month}-${byType.day}`
}

function toMonday(value) {
  const dow = businessDateDayOfWeek(value)
  return dow == null ? '' : addBusinessDays(value, -((dow + 6) % 7))
}

function periodFromControls(periodType, monthKey, weekDate, customStart, customEnd) {
  if (periodType === 'month') return resolvePayrollPeriod({ periodType, periodKey: monthKey })
  if (periodType === 'week') return resolvePayrollPeriod({ periodType, periodKey: weekDate })
  return resolvePayrollPeriod({ periodType, periodStart: customStart, periodEnd: customEnd })
}

function emptyPayroll(status = 'loading', blocked = '') {
  return {
    status, blocked, calculationReady: false, period: null,
    subjects: [], readinessById: new Map(), serverById: new Map(),
  }
}

const requestIssuePreflight = (period, employeeIds) => api('/v2/payroll-notices/preflight', {
  method: 'POST',
  body: JSON.stringify({ ...period, employeeIds }),
})

export default function PayrollIssueModal({ onClose, onIssued }) {
  const today = useMemo(shanghaiToday, [])
  const [periodType, setPeriodType] = useState('month')
  const [monthKey, setMonthKey] = useState(today.slice(0, 7))
  const [weekDate, setWeekDate] = useState(toMonday(today))
  const [customStart, setCustomStart] = useState(addBusinessDays(today, -6))
  const [customEnd, setCustomEnd] = useState(today)
  const [selected, setSelected] = useState(new Set())
  const [accounts, setAccounts] = useState([])
  const [payroll, setPayroll] = useState(emptyPayroll())
  const [issued, setIssued] = useState([])
  const [sending, setSending] = useState(false)
  const [preflighting, setPreflighting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  const period = useMemo(
    () => periodFromControls(periodType, monthKey, weekDate, customStart, customEnd),
    [periodType, monthKey, weekDate, customStart, customEnd],
  )

  useEffect(() => {
    api('/admin/users')
      .then((res) => setAccounts(Array.isArray(res.users) ? res.users : []))
      .catch(() => setAccounts([]))
  }, [])

  // All periods converge here: exact range cache completeness -> one resolver -> server preflight.
  useEffect(() => {
    let cancelled = false
    setSelected(new Set())
    setError('')
    setDone('')
    if (!period.valid) {
      setPayroll(emptyPayroll('blocked', period.reason))
      return undefined
    }
    setPayroll(emptyPayroll('loading'))
    setPreflighting(false)
    loadDailyStoreStaffRange(period.periodStart, period.periodEnd)
      .then(async () => {
        if (cancelled) return
        const rangeState = getDailyStoreStaffRangeState(period.periodStart, period.periodEnd)
        if (!rangeState.complete) {
          setPayroll(emptyPayroll('blocked', rangeState.status === 'error' ? 'LOAD_ERROR' : 'RANGE_INCOMPLETE'))
          return
        }
        const stores = Object.fromEntries(getStores().map((store) => [store.key, store.name]))
        const result = resolvePayrollCalculation({
          ...period,
          dailyEntries: getEntries(),
          dailyStoreStaffRows: getDailyStoreStaffRange(period.periodStart, period.periodEnd),
          dailyPayAdjustments: getDailyPayAdjustments(),
          bigOrderBonuses: getBigBonuses(),
          employees: currentEmployeeDirectory('all'),
          users: accounts,
          storeNames: stores,
        })
        if (cancelled) return
        if (result.mode !== 'EMPLOYEE_ID' || !result.calculationReady) {
          const onlyEmpty = (result.readiness?.calculationBlockers || []).every((row) => row.reason === 'NO_PAYROLL_SUBJECTS')
          setPayroll(emptyPayroll('blocked', onlyEmpty ? 'EMPTY_RANGE' : 'AUTHORITY_INCOMPLETE'))
          return
        }
        const readinessById = new Map((result.readiness.employees || []).map((row) => [row.employeeId, row]))
        setPayroll({
          status: 'ready', blocked: '', calculationReady: true, period,
          subjects: result.payroll.employees, readinessById, serverById: new Map(),
        })
        setPreflighting(true)
        try {
          const response = await requestIssuePreflight(period, result.payroll.employees.map((row) => row.employeeId))
          if (cancelled) return
          const serverById = new Map((response.rows || []).map((row) => [row.employeeId, row]))
          setPayroll((current) => ({ ...current, serverById }))
        } catch (preflightError) {
          if (!cancelled) setPayroll((current) => ({ ...current, status: 'blocked', blocked: 'SERVER_PREFLIGHT_FAILED' }))
        } finally {
          if (!cancelled) setPreflighting(false)
        }
      })
      .catch(() => {
        if (!cancelled) setPayroll(emptyPayroll('blocked', 'LOAD_ERROR'))
      })
    return () => { cancelled = true }
  }, [period.rangeKey, period.valid, period.reason, accounts])

  useEffect(() => {
    setIssued([])
    if (!period.valid) return
    api(`/v2/payroll-notices?periodType=${period.periodType}&periodKey=${encodeURIComponent(period.periodKey)}`)
      .then((res) => setIssued(Array.isArray(res.rows) ? res.rows : []))
      .catch(() => setIssued([]))
  }, [period.rangeKey, period.valid])

  const dirById = useMemo(() => new Map(currentEmployeeDirectory('all').map((employee) => [employee.id, employee])), [])
  const baseRows = useMemo(
    () => buildIssueRows(
      payroll.subjects,
      [...payroll.readinessById.values()],
      accounts,
      dirById,
      payroll.period,
    ),
    [payroll.subjects, payroll.readinessById, payroll.period, accounts, dirById],
  )
  const rows = useMemo(
    () => baseRows.map((row) => bindAuthoritativeIssuePreflight(row, payroll.serverById.get(row.employeeId))),
    [baseRows, payroll.serverById],
  )

  const picked = rows.filter((row) => selected.has(row.employeeId))
  const pickedTotal = picked.reduce((sum, row) => sum + Number(row.rec.salary || 0), 0)
  const selectionPreflight = preflightIssueSelection(rows, selected)

  const toggle = (employeeId) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(employeeId)) next.delete(employeeId)
      else next.add(employeeId)
      return next
    })
    setError('')
  }

  const selectAll = () => {
    const eligibleIds = rows.filter((row) => row.issueReady).map((row) => row.employeeId)
    if (eligibleIds.length > 0 && eligibleIds.every((id) => selected.has(id))) setSelected(new Set())
    else setSelected(new Set(eligibleIds))
  }

  const send = async () => {
    if (payroll.status !== 'ready' || preflighting) return setError('工资权威数据仍在加载')
    if (picked.length === 0) return setError('请至少选择 1 名可发放员工')
    if (!selectionPreflight.ok) {
      return setError(`以下员工暂不能发放：${selectionPreflight.blocked.map((row) => row.name).join('、')}`)
    }
    setSending(true)
    setError('')
    try {
      const response = await api('/v2/payroll-notices', {
        method: 'POST',
        body: JSON.stringify({ ...period, rows: buildIssuePayloadRows(picked) }),
      })
      setDone(`已发放 ${response.count} 份工资条（${periodLabel(period.periodType, period.periodKey)}）`)
      setTimeout(() => { onIssued?.(response.count); onClose() }, 1400)
    } catch (sendError) {
      if (sendError.data?.code === 'PAYROLL_AUTHORITY_MISMATCH') {
        setPreflighting(true)
        setSelected(new Set())
        try {
          const response = await requestIssuePreflight(period, payroll.subjects.map((row) => row.employeeId))
          const serverById = new Map((response.rows || []).map((row) => [row.employeeId, row]))
          setPayroll((current) => ({ ...current, serverById }))
          setError('工资权威快照已更新，请核对后重新选择发放')
        } catch {
          setPayroll((current) => ({ ...current, status: 'blocked', blocked: 'SERVER_PREFLIGHT_FAILED' }))
          setError('工资权威快照已变化，重新预检失败，请刷新后重试')
        } finally {
          setPreflighting(false)
        }
      } else setError(sendError.message)
    } finally {
      setSending(false)
    }
  }

  const blockedText = {
    INVALID_PERIOD: '请选择有效工资日期范围',
    INVALID_PERIOD_ORDER: '周期开始不能晚于周期结束',
    INVALID_WEEK_START: '周度周期必须从周一开始',
    LOAD_ERROR: '工资权威数据加载失败，请重试',
    RANGE_INCOMPLETE: '工资权威数据尚未完整加载',
    EMPTY_RANGE: '所选日期范围无有效工资',
    AUTHORITY_INCOMPLETE: '所选范围的工资权威数据不完整',
    SERVER_PREFLIGHT_FAILED: '服务器发放预检失败，请重试',
  }[payroll.blocked] || '所选范围暂不可发放'

  const renderEmployee = (row, compact = false) => {
    const on = selected.has(row.employeeId)
    const recipient = row.matches.length === 1 ? `@${row.targetUsername}` : row.matches.length === 0 ? '未绑定账号' : '账号绑定冲突'
    const status = row.overlap ? '存在重复/重叠工资条' : row.issueReady ? '可发放' : preflighting ? '预检中' : '工资权威数据不完整'
    if (compact) {
      return (
        <button key={row.employeeId} type="button" onClick={() => row.issueReady && toggle(row.employeeId)} disabled={!row.issueReady} className={`w-full rounded-xl border p-3 text-left ${on ? 'border-budu-300 bg-budu-50' : 'border-slate-100 bg-white'} disabled:opacity-60`}>
          <div className="flex items-start gap-2">
            <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded border ${on ? 'border-budu-500 bg-budu-500 text-white' : 'border-slate-300 text-transparent'}`}><Check className="h-3 w-3" /></span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-slate-700">{row.name || row.employeeId}{row.employeeNo ? <span className="ml-1 text-[11px] font-normal text-slate-400">{row.employeeNo}</span> : null}</p>
              <p className="mt-1 text-[11px] text-slate-400">{row.rec.days || 0} 天 · {row.rec.payableHours || 0}h · {recipient}</p>
              <p className={`mt-1 text-[11px] ${row.issueReady ? 'text-emerald-600' : 'text-rose-500'}`}>{status}</p>
            </div>
            <span className="font-bold tabular-nums text-budu-600">{yuan(row.rec.salary)}</span>
          </div>
        </button>
      )
    }
    return (
      <tr key={row.employeeId} onClick={() => row.issueReady && toggle(row.employeeId)} className={`${row.issueReady ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'} ${on ? 'bg-budu-50/50' : 'hover:bg-slate-50'}`}>
        <td className="px-3 py-2"><span className={`grid h-4 w-4 place-items-center rounded border ${on ? 'border-budu-500 bg-budu-500 text-white' : 'border-slate-300 text-transparent'}`}><Check className="h-3 w-3" /></span></td>
        <td className="px-3 py-2 font-semibold text-slate-700">{row.name || row.employeeId}{row.employeeNo ? <span className="ml-1 text-[11px] font-normal text-slate-400">{row.employeeNo}</span> : null}</td>
        <td className="px-3 py-2 text-slate-500">{storeName(row.storeKey) || row.storeKey || '—'}</td>
        <td className="px-3 py-2 text-right tabular-nums">{row.rec.days || 0} 天</td>
        <td className="px-3 py-2 text-right tabular-nums">{row.rec.payableHours || 0}h</td>
        <td className="px-3 py-2 text-right font-bold tabular-nums text-budu-600">{yuan(row.rec.salary)}</td>
        <td className="px-3 py-2 text-slate-500">{recipient}<p className={row.issueReady ? 'text-emerald-600' : 'text-rose-500'}>{status}</p></td>
      </tr>
    )
  }

  return (
    <div className="budu-overlay-viewport fixed inset-0 z-[96] flex items-center justify-center p-2 sm:p-4" role="dialog" aria-modal="true">
      <div className="budu-overlay-backdrop absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="budu-overlay-scroll relative max-h-[94dvh] w-full max-w-3xl rounded-2xl bg-white p-4 shadow-lg sm:p-6">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-budu-50 text-budu-600"><BadgeDollarSign className="h-6 w-6" /></div>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-bold text-slate-800">发放工资条</h3>
            <p className="mt-0.5 text-xs text-slate-400">Employee.id · 统一日期范围工资权威 · 重叠发放保护</p>
          </div>
          <button onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-400"><X className="h-5 w-5" /></button>
        </div>

        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-3 rounded-xl bg-slate-100 p-1">
            {[['month', '月度'], ['week', '周度'], ['custom', '自定义日期']].map(([value, label]) => (
              <button key={value} onClick={() => setPeriodType(value)} className={`rounded-lg px-2 py-2 text-xs font-semibold transition sm:text-[13px] ${periodType === value ? 'bg-white text-budu-600 shadow-sm' : 'text-slate-500'}`}>{label}</button>
            ))}
          </div>
          {periodType === 'month' && <input aria-label="工资月份" type="month" value={monthKey} onChange={(event) => setMonthKey(event.target.value)} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-budu-400" />}
          {periodType === 'week' && <input aria-label="周度日期" type="date" value={weekDate} onChange={(event) => setWeekDate(toMonday(event.target.value))} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-budu-400" />}
          {periodType === 'custom' && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
              <input aria-label="自定义周期开始日期" type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} className="min-w-0 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-budu-400" />
              <span className="hidden text-center text-xs text-slate-400 sm:block">至</span>
              <input aria-label="自定义周期结束日期" type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} className="min-w-0 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-budu-400" />
            </div>
          )}
          {period.valid && <p className="rounded-xl bg-budu-50 px-3 py-2 text-xs font-semibold text-budu-700">{payrollPeriodKindLabel(period.periodType)} · {period.periodStart} ～ {period.periodEnd}</p>}
        </div>

        {error && <p className="mt-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}
        {done && <p className="mt-3 rounded-xl bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-600">{done}</p>}
        {payroll.status === 'loading' && <p className="mt-3 text-xs text-slate-400">数据仍在加载…</p>}
        {payroll.status === 'blocked' && <p className="mt-3 rounded-xl bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-700">{blockedText}</p>}

        {issued.length > 0 && <p className="mt-3 rounded-xl bg-slate-50 px-4 py-2 text-xs text-slate-500">该精确周期已有 {issued.length} 份工资条；服务器还会检查所有部分重叠周期。</p>}

        {payroll.status === 'ready' && (
          <>
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm font-bold text-slate-700">员工（{rows.length}）</p>
              <button onClick={selectAll} className="text-xs font-semibold text-budu-500">选择全部可发放员工</button>
            </div>
            <div className="mt-2 space-y-2 sm:hidden">{rows.map((row) => renderEmployee(row, true))}</div>
            <div className="mt-2 hidden max-h-[34vh] overflow-y-auto rounded-xl border border-slate-100 sm:block">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-50 text-slate-400"><tr><th className="w-10 px-3 py-2" /><th className="px-3 py-2">员工</th><th className="px-3 py-2">门店</th><th className="px-3 py-2 text-right">出勤</th><th className="px-3 py-2 text-right">计薪工时</th><th className="px-3 py-2 text-right">合计</th><th className="px-3 py-2">预检</th></tr></thead>
                <tbody className="divide-y divide-slate-50">{rows.map((row) => renderEmployee(row))}</tbody>
              </table>
            </div>
            <div className="sticky bottom-0 mt-4 rounded-2xl border border-slate-100 bg-white/95 p-3 shadow-sm backdrop-blur">
              <div className="flex items-center justify-between gap-3"><div><p className="text-xs text-slate-400">已选 {picked.length} 人</p><p className="text-lg font-black tabular-nums text-budu-600">{yuan(pickedTotal)}</p></div><button onClick={send} disabled={sending || preflighting || picked.length === 0 || !selectionPreflight.ok} className="min-h-11 rounded-xl bg-budu-500 px-5 py-2.5 text-sm font-bold text-white disabled:opacity-40">{sending ? '发放中…' : preflighting ? '预检中…' : '确认发放工资条'}</button></div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
