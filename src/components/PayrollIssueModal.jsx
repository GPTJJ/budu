// 工资条发放（开发者）：选择月度周期 → 勾选稳定员工 → 实时预览快照 → 批量发放
// Gate 27：唯一计算决策点 = resolvePayrollCalculation（月级 Employee.id payroll）。
// LEGACY/未就绪月份硬阻断（不发放兼容工资）；周度/自定义周期保持可见但标记"尚未迁移至稳定计算，暂不可发放"；
// 发放预检按 per-employee issueReady（Gate 22）+ 负工资总额（服务端规则）双阻断；
// 收件人 = 服务端 User.employeeId 精确匹配（Gate 18，fail closed）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { BadgeDollarSign, Check, X } from 'lucide-react'
import { api } from '../utils/api'
import { periodLabel } from '../utils/payrollSlip'
import { storeName, currentEmployeeDirectory } from '../utils/selectors'
import { resolvePayrollCalculation } from '../utils/payrollResolver'
import {
  loadDailyStoreStaffMonth,
  getDailyStoreStaff,
  getDailyStoreStaffMonthState,
  getEntries,
  getDailyPayAdjustments,
  getBigBonuses,
} from '../utils/userData'
import { buildIssueRows, preflightIssueSelection, buildIssuePayloadRows } from '../utils/payrollIssue'

const yuan = (n) => `¥${Number(n || 0).toFixed(2)}`

function toMonday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`)
  const dow = (d.getDay() + 6) % 7 // 周一=0
  d.setDate(d.getDate() - dow)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${dd}`
}

export default function PayrollIssueModal({ onClose, onIssued }) {
  // 周期类型（Gate 27 澄清：周度/自定义为既有产品能力——保持可见，但未迁移稳定计算前不可发放）
  const [periodType, setPeriodType] = useState('month')
  const [monthKey, setMonthKey] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const [weekDate, setWeekDate] = useState(() => toMonday(new Date().toISOString().slice(0, 10)))
  const [customStart, setCustomStart] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 6)
    return d.toISOString().slice(0, 10)
  })
  const [customEnd, setCustomEnd] = useState(() => new Date().toISOString().slice(0, 10))
  const [selected, setSelected] = useState(new Set())
  const [accounts, setAccounts] = useState([])
  const [payroll, setPayroll] = useState({
    status: 'loading', month: '', mode: '', calculationReady: false,
    byEmployeeId: new Map(), readinessById: new Map(), subjects: [], blocked: '',
  })
  const [issued, setIssued] = useState([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const lastMonthRef = useRef(monthKey)

  useEffect(() => {
    api('/admin/users')
      .then((res) => setAccounts(Array.isArray(res.users) ? res.users : []))
      .catch(() => setAccounts([]))
  }, [])

  // Gate 27：显式月份 → 月键控考勤加载（loadDailyStoreStaffMonth(m)）→ resolver（唯一计算决策点）
  // 竞态安全：切换月份后晚到的响应丢弃（cancelled）；加载期间不展示上月金额。
  // 周度/自定义周期：不进入 resolver（无稳定引擎），显式 blocked。
  useEffect(() => {
    const m = String(monthKey || '')
    const monthChanged = lastMonthRef.current !== m
    lastMonthRef.current = m
    let cancelled = false
    setPayroll({ status: 'loading', month: m, mode: '', calculationReady: false, byEmployeeId: new Map(), readinessById: new Map(), subjects: [], blocked: '' })
    if (monthChanged) {
      setSelected(new Set())
      setError('')
      setDone('')
    }
    if (periodType !== 'month') {
      setPayroll({ status: 'blocked', month: m, mode: '', calculationReady: false, byEmployeeId: new Map(), readinessById: new Map(), subjects: [], blocked: 'PERIOD_NOT_AVAILABLE' })
      return
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) {
      setPayroll({ status: 'blocked', month: m, mode: '', calculationReady: false, byEmployeeId: new Map(), readinessById: new Map(), subjects: [], blocked: 'INVALID_MONTH' })
      return
    }
    loadDailyStoreStaffMonth(m)
      .then(() => {
        if (cancelled) return
        const monthState = getDailyStoreStaffMonthState(m)
        if (monthState.status !== 'loaded' || !monthState.hasPayload) {
          setPayroll({ status: 'blocked', month: m, mode: '', calculationReady: false, byEmployeeId: new Map(), readinessById: new Map(), subjects: [], blocked: 'LOAD_ERROR' })
          return
        }
        const res = resolvePayrollCalculation({
          month: m,
          dailyEntries: getEntries(),
          dailyStoreStaffRows: getDailyStoreStaff(m),
          dailyPayAdjustments: getDailyPayAdjustments(),
          bigOrderBonuses: getBigBonuses(),
          employees: [],
          users: accounts,
        })
        if (cancelled) return
        if (res.mode !== 'EMPLOYEE_ID' || !res.calculationReady) {
          // LEGACY：兼容数据阻断（重名/无身份）；纯空月（仅 NO_PAYROLL_SUBJECTS）单独归类为 EMPTY_MONTH，
          // 避免把"无数据"误报成"存在历史兼容工资"。
          let blocked = res.mode === 'LEGACY' ? 'LEGACY' : 'NOT_CALCULATION_READY'
          if (res.mode === 'LEGACY') {
            const calcBlockers = (res.readiness && res.readiness.calculationBlockers) || []
            if (calcBlockers.length > 0 && calcBlockers.every((b) => b.reason === 'NO_PAYROLL_SUBJECTS')) {
              blocked = 'EMPTY_MONTH'
            }
          }
          setPayroll({
            status: 'blocked', month: m, mode: res.mode, calculationReady: false,
            byEmployeeId: new Map(), readinessById: new Map(), subjects: [],
            blocked,
          })
          return
        }
        const byEmployeeId = new Map(res.payroll.employees.map((r) => [r.employeeId, r]))
        const readinessById = new Map((res.readiness.employees || []).map((r) => [r.employeeId, r]))
        setPayroll({ status: 'ready', month: m, mode: 'EMPLOYEE_ID', calculationReady: true, byEmployeeId, readinessById, subjects: res.payroll.employees, blocked: '' })
      })
      .catch(() => {
        if (!cancelled) {
          setPayroll({ status: 'blocked', month: m, mode: '', calculationReady: false, byEmployeeId: new Map(), readinessById: new Map(), subjects: [], blocked: 'LOAD_ERROR' })
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey, periodType, accounts])

  // 该周期已发放记录（仅月度；切换周期时刷新）
  useEffect(() => {
    setDone('')
    setError('')
    if (periodType !== 'month') return
    api(`/v2/payroll-notices?periodType=month&periodKey=${encodeURIComponent(monthKey)}`)
      .then((res) => setIssued(Array.isArray(res.rows) ? res.rows : []))
      .catch(() => setIssued([]))
  }, [periodType, monthKey])

  // Gate 27：主体 = resolver payroll subjects（Employee.id 权威；含调整仅日/历史员工）；
  // 展示富集仅按 Employee.id（目录缺失时回退结果快照，绝不按 name 匹配金额）；
  // 快照逐日明细 ctx：显式月 + 该月 DailyStoreStaff（employeeId 严格模式）。
  const dirById = useMemo(() => new Map(currentEmployeeDirectory('all').map((e) => [e.id, e])), [])
  const snapCtx = periodType === 'month' ? { month: monthKey, attendanceRows: getDailyStoreStaff(monthKey) } : null
  const rows = useMemo(
    () => buildIssueRows(payroll.subjects, payroll.readinessById ? [...payroll.readinessById.values()] : [], accounts, dirById, snapCtx),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [payroll, accounts, dirById, monthKey, periodType],
  )

  const picked = rows.filter((r) => selected.has(r.employeeId))
  const pickedTotal = picked.reduce((s, r) => s + (r.rec.salary || 0), 0)

  const toggle = (employeeId) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(employeeId)) next.delete(employeeId)
      else next.add(employeeId)
      return next
    })
  }

  const selectAll = () => {
    if (selected.size === rows.length && rows.length > 0) setSelected(new Set())
    else setSelected(new Set(rows.map((r) => r.employeeId)))
  }

  const send = async () => {
    if (payroll.status !== 'ready') {
      setError('工资数据尚未就绪')
      return
    }
    if (picked.length === 0) {
      setError('请至少选择 1 名员工')
      return
    }
    // Gate 27 预检：发送第一个 POST 前校验全部选中员工（per-employee issueReady + 负工资总额）
    const preflight = preflightIssueSelection(rows, selected)
    if (!preflight.ok) {
      const reasonText = (b) => (b.reason === 'NEGATIVE_PAYROLL_TOTAL' ? '工资金额为负' : '未绑定可接收账号或账号异常')
      setError(`以下员工暂不能发放：${preflight.blocked.map((b) => `${b.name}（${reasonText(b)}）`).join('、')}`)
      return
    }
    setSending(true)
    setError('')
    setDone('')
    try {
      const res = await api('/v2/payroll-notices', {
        method: 'POST',
        body: JSON.stringify({
          periodType: 'month',
          periodKey: monthKey,
          rows: buildIssuePayloadRows(picked),
        }),
      })
      setDone(`已发放 ${res.count} 份工资条（${periodLabel('month', monthKey)}）`)
      setTimeout(() => {
        onIssued?.(res.count)
        onClose()
      }, 1400)
    } catch (e) {
      setError(e.message)
    } finally {
      setSending(false)
    }
  }

  const blockedBanner = () => {
    if (payroll.status !== 'blocked') return null
    if (payroll.blocked === 'LEGACY') {
      return '该月份存在历史兼容工资数据，无法确认员工身份，暂不能发放工资条。'
    }
    if (payroll.blocked === 'PERIOD_NOT_AVAILABLE') {
      return '周度/自定义周期尚未迁移至稳定工资计算，暂不可发放'
    }
    if (payroll.blocked === 'LOAD_ERROR') return '工资数据尚未加载，请重新加载'
    return '该月份暂无可发放的稳定工资数据'
  }

  return (
    <div className="fixed inset-0 z-[96] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-6 shadow-lg">
        <div className="flex flex-wrap items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-budu-50 text-budu-600">
            <BadgeDollarSign className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-800">发放工资条</h3>
            <p className="mt-0.5 text-xs text-slate-400">
              按稳定员工身份（Employee.id）生成月度快照 · 员工签收后留痕 · 同员工同周期不可重复发放
            </p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* 周期选择（Gate 27 澄清：周度/自定义保持可见；未迁移稳定计算 → 受控不可用） */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-xl bg-slate-100 p-1">
            {[
              ['month', '月度'],
              ['week', '周度'],
              ['custom', '自定日期'],
            ].map(([v, label]) => (
              <button
                key={v}
                onClick={() => setPeriodType(v)}
                className={`rounded-lg px-4 py-1.5 text-[13px] font-semibold transition ${
                  periodType === v ? 'bg-white text-budu-600 shadow-sm' : 'text-slate-500'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {periodType === 'month' && (
            <input
              type="month"
              value={monthKey}
              onChange={(e) => e.target.value && setMonthKey(e.target.value)}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-budu-400"
            />
          )}
          {periodType === 'week' && (
            <input
              type="date"
              value={weekDate}
              onChange={(e) => e.target.value && setWeekDate(toMonday(e.target.value))}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-budu-400"
            />
          )}
          {periodType === 'custom' && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={customStart}
                max={customEnd}
                onChange={(e) => e.target.value && setCustomStart(e.target.value)}
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-budu-400"
                aria-label="自定周期开始日期"
              />
              <span className="text-xs text-slate-400">至</span>
              <input
                type="date"
                value={customEnd}
                min={customStart}
                onChange={(e) => e.target.value && setCustomEnd(e.target.value)}
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-budu-400"
                aria-label="自定周期结束日期"
              />
            </div>
          )}
          {periodType === 'month' && (
            <span className="rounded-lg bg-budu-50 px-2.5 py-1 text-xs font-bold text-budu-600">
              {periodLabel('month', monthKey)}
            </span>
          )}
          {periodType === 'week' && (
            <span className="text-[11px] text-slate-400">周度按所选日期所在周的周一至周日计算</span>
          )}
          {periodType === 'custom' && (
            <span className="text-[11px] text-slate-400">按所选起止日期逐日计算员工工资</span>
          )}
          {payroll.status === 'ready' && (
            <span className="rounded-lg bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-600">稳定计算</span>
          )}
          {payroll.status === 'loading' && <span className="text-xs text-slate-400">加载中…</span>}
        </div>

        {error && <p className="mt-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}
        {done && (
          <p className="mt-3 rounded-xl bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-600">{done}</p>
        )}
        {blockedBanner() && (
          <p className="mt-3 rounded-xl bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-700">{blockedBanner()}</p>
        )}

        {/* 该周期已发放记录 */}
        {issued.length > 0 && (
          <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3">
            <p className="text-xs font-bold text-slate-500">
              该周期已发放 {issued.length} 份
              <span className="ml-2 font-normal text-slate-400">（重复发放会被拦截）</span>
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {issued.map((r) => (
                <span
                  key={r.id}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-semibold ${
                    r.status === 'confirmed' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
                  }`}
                >
                  {r.employeeName} · ¥{(Number(r.totalCents) / 100).toFixed(2)}
                  {r.status === 'confirmed' ? ' · 已签收' : ' · 待签收'}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 员工勾选列表（主体 = resolver payroll subjects） */}
        {payroll.status === 'ready' && (
          <>
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm font-bold text-slate-700">
                员工（{rows.length}）
                <span className="ml-2 text-xs font-normal text-slate-400">勾选后实时预览该月工资</span>
              </p>
              <button onClick={selectAll} className="text-xs font-semibold text-budu-500 transition hover:text-budu-600">
                {selected.size === rows.length && rows.length > 0 ? '取消全选' : '全选'}
              </button>
            </div>

            <div className="mt-2 max-h-[34vh] overflow-y-auto rounded-xl border border-slate-100">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="sticky top-0 bg-slate-50 text-slate-400">
                  <tr>
                    <th className="w-10 px-3 py-2" />
                    <th className="px-3 py-2">员工</th>
                    <th className="px-3 py-2">门店</th>
                    <th className="px-3 py-2">类型</th>
                    <th className="px-3 py-2 text-right">出勤</th>
                    <th className="px-3 py-2 text-right">计薪工时</th>
                    <th className="px-3 py-2 text-right">合计</th>
                    <th className="px-3 py-2">绑定账号</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {rows.map((e) => {
                    const on = selected.has(e.employeeId)
                    const bound =
                      e.matches.length === 0
                        ? '未绑定'
                        : e.matches.length > 1
                          ? `多个绑定(${e.matches.length})`
                          : `@${e.targetUsername}`
                    return (
                      <tr
                        key={e.employeeId}
                        onClick={() => toggle(e.employeeId)}
                        className={`cursor-pointer transition ${on ? 'bg-budu-50/50' : 'hover:bg-slate-50'}`}
                      >
                        <td className="px-3 py-2">
                          <span
                            className={`grid h-4.5 w-4.5 place-items-center rounded border ${
                              on ? 'border-budu-500 bg-budu-500 text-white' : 'border-slate-300 bg-white text-transparent'
                            }`}
                          >
                            <Check className="h-3 w-3" />
                          </span>
                        </td>
                        <td className="px-3 py-2 font-semibold text-slate-700">
                          {e.name || e.employeeNo || e.employeeId}
                          {e.employeeNo && <span className="ml-1.5 text-[10px] font-normal text-slate-400">{e.employeeNo}</span>}
                        </td>
                        <td className="px-3 py-2 text-slate-500">{storeName(e.storeKey) || e.storeKey || '—'}</td>
                        <td className="px-3 py-2">
                          <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${e.type === 'fulltime' ? 'bg-budu-500 text-white' : 'bg-slate-100 text-slate-500'}`}>
                            {e.type === 'fulltime' ? '全职' : e.type === 'parttime' ? '兼职' : '—'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-600">{e.rec.days || 0} 天</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-600">{e.rec.payableHours || 0}h</td>
                        <td className="px-3 py-2 text-right font-bold tabular-nums text-budu-600">{yuan(e.rec.salary)}</td>
                        <td className={`px-3 py-2 ${e.matches.length === 1 ? 'text-emerald-600' : 'text-slate-300'}`}>{bound}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* 底部操作 */}
        <div className="mt-4 flex flex-col items-center gap-3 border-t border-slate-100 pt-4">
          <p className="text-xs text-slate-400">
            已选 <span className="font-bold text-budu-600">{picked.length}</span> 人 · 合计{' '}
            <span className="font-black text-budu-600">{yuan(pickedTotal)}</span>
            {picked.length > 0 && ' · 发放后员工在通知铃铛查收并签收'}
          </p>
          <button
            onClick={send}
            disabled={sending || picked.length === 0 || payroll.status !== 'ready'}
            className="w-full max-w-sm rounded-xl bg-budu-500 py-3 text-sm font-bold text-white shadow-sm transition hover:opacity-90 disabled:opacity-40"
          >
            {sending ? '发放中…' : `确认发放 ${picked.length > 0 ? picked.length + ' 份' : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
