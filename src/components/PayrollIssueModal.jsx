// 工资条发放（开发者）：选择周期 → 勾选员工 → 实时预览快照 → 批量发放
import { useEffect, useMemo, useState } from 'react'
import { BadgeDollarSign, Check, X } from 'lucide-react'
import { api } from '../utils/api'
import { employeeList } from '../utils/selectors'
import { buildPayrollSnapshot, periodLabel } from '../utils/payrollSlip'
import { storeName } from '../utils/selectors'

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
  const [issued, setIssued] = useState([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  useEffect(() => {
    api('/admin/users')
      .then((res) => setAccounts(Array.isArray(res.users) ? res.users : []))
      .catch(() => setAccounts([]))
  }, [])

  // 该周期已发放记录（切换周期时刷新）
  const periodKey = periodType === 'week' ? weekDate : periodType === 'custom' ? `${customStart}~${customEnd}` : monthKey
  useEffect(() => {
    setDone('')
    setError('')
    api(`/v2/payroll-notices?periodType=${periodType}&periodKey=${encodeURIComponent(periodKey)}`)
      .then((res) => setIssued(Array.isArray(res.rows) ? res.rows : []))
      .catch(() => setIssued([]))
  }, [periodType, periodKey])

  // 员工名单（全部 + 本地），预计算快照
  const employees = useMemo(() => {
    const list = employeeList('all', null)
    return list.map((emp) => {
      const snap = buildPayrollSnapshot(periodType, periodKey, emp.name)
      // 员工绑定账号：优先精确 staffKey = `${storeKey}::${name}`，兜底按员工姓名匹配
      const acct = accounts.find(
        (u) => u.staffKey === `${emp.storeKey}::${emp.name}` || (u.staffKey || '').split('::')[1] === emp.name,
      )
      return { ...emp, snap, targetUsername: acct ? acct.username : '' }
    })
  }, [periodType, periodKey, accounts])

  const picked = employees.filter((e) => selected.has(e.name))
  const pickedTotal = picked.reduce((s, e) => s + (e.snap.summary.total || 0), 0)

  const toggle = (name) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const selectAll = () => {
    if (selected.size === employees.length) setSelected(new Set())
    else setSelected(new Set(employees.map((e) => e.name)))
  }

  const send = async () => {
    if (picked.length === 0) {
      setError('请至少选择 1 名员工')
      return
    }
    setSending(true)
    setError('')
    setDone('')
    try {
      const res = await api('/v2/payroll-notices', {
        method: 'POST',
        body: JSON.stringify({
          periodType,
          periodKey,
          rows: picked.map((e) => ({
            employeeName: e.name,
            storeKey: e.storeKey,
            targetUsername: e.targetUsername,
            snapshot: e.snap,
            totalCents: Math.round((e.snap.summary.total || 0) * 100),
          })),
        }),
      })
      setDone(`已发放 ${res.count} 份工资条（${periodLabel(periodType, periodKey)}）`)
      // 提示展示 1.4s 后刷新列表并关闭
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
              按当前薪资规则自动生成快照 · 员工签收后留痕 · 同员工同周期不可重复发放
            </p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* 周期选择 */}
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
          <span className="rounded-lg bg-budu-50 px-2.5 py-1 text-xs font-bold text-budu-600">
            {periodLabel(periodType, periodKey)}
          </span>
          {periodType === 'week' && (
            <span className="text-[11px] text-slate-400">周度按所选日期所在周的周一至周日计算</span>
          )}
          {periodType === 'custom' && (
            <span className="text-[11px] text-slate-400">按所选起止日期逐日计算员工工资</span>
          )}
        </div>

        {error && <p className="mt-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}
        {done && (
          <p className="mt-3 rounded-xl bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-600">{done}</p>
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

        {/* 员工勾选列表 */}
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm font-bold text-slate-700">
            员工（{employees.length}）
            <span className="ml-2 text-xs font-normal text-slate-400">勾选后实时预览该周期工资</span>
          </p>
          <button onClick={selectAll} className="text-xs font-semibold text-budu-500 transition hover:text-budu-600">
            {selected.size === employees.length && employees.length > 0 ? '取消全选' : '全选'}
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
                <th className="px-3 py-2 text-right">工时</th>
                <th className="px-3 py-2 text-right">合计</th>
                <th className="px-3 py-2">绑定账号</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {employees.map((e) => {
                const on = selected.has(e.name)
                const bound = e.targetUsername ? `@${e.targetUsername}` : '未绑定'
                return (
                  <tr key={`${e.storeKey}::${e.name}`} onClick={() => toggle(e.name)} className={`cursor-pointer transition ${on ? 'bg-budu-50/50' : 'hover:bg-slate-50'}`}>
                    <td className="px-3 py-2">
                      <span
                        className={`grid h-4.5 w-4.5 place-items-center rounded border ${
                          on ? 'border-budu-500 bg-budu-500 text-white' : 'border-slate-300 bg-white text-transparent'
                        }`}
                      >
                        <Check className="h-3 w-3" />
                      </span>
                    </td>
                    <td className="px-3 py-2 font-semibold text-slate-700">{e.name}</td>
                    <td className="px-3 py-2 text-slate-500">{storeName(e.storeKey) || e.storeKey}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${e.type === 'fulltime' ? 'bg-budu-500 text-white' : 'bg-slate-100 text-slate-500'}`}>
                        {e.type === 'fulltime' ? '全职' : '兼职'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">{e.snap.summary.workedDays} 天</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">{e.snap.summary.hours}h</td>
                    <td className="px-3 py-2 text-right font-bold tabular-nums text-budu-600">{yuan(e.snap.summary.total)}</td>
                    <td className={`px-3 py-2 ${e.targetUsername ? 'text-emerald-600' : 'text-slate-300'}`}>{bound}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* 底部操作 */}
        <div className="mt-4 flex flex-col items-center gap-3 border-t border-slate-100 pt-4">
          <p className="text-xs text-slate-400">
            已选 <span className="font-bold text-budu-600">{picked.length}</span> 人 · 合计{' '}
            <span className="font-black text-budu-600">{yuan(pickedTotal)}</span>
            {picked.length > 0 && ' · 发放后员工在通知铃铛查收并签收'}
          </p>
          <button
            onClick={send}
            disabled={sending || picked.length === 0}
            className="w-full max-w-sm rounded-xl bg-budu-500 py-3 text-sm font-bold text-white shadow-sm transition hover:opacity-90 disabled:opacity-40"
          >
            {sending ? '发放中…' : `确认发放 ${picked.length > 0 ? picked.length + ' 份' : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
