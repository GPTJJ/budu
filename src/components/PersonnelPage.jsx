import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Award, BadgeDollarSign, CalendarDays, FileSpreadsheet, IdCard, Plus, Trash2, X } from 'lucide-react'
import CalendarPicker from './CalendarPicker'
import BigBonusModal from './BigBonusModal'
import DailyPayAdjustmentModal from './DailyPayAdjustmentModal'
import ExportSalaryModal from './ExportSalaryModal'
import { getWeekDays, isoWeek } from '../utils/schedule'
import {
  employeesByType,
  employeeList,
  monthLabel,
  employeeDayStatus,
  employeeDailyPayDetail,
  employeeWeekStatus,
  legacyAmbiguousEmployeeNames,
  payrollPeriodMonths,
  hasLocalEntry,
  localStaffList,
  currentEmployeeDirectory,
  saveLocalStaffList,
  allStores,
  storeName,
} from '../utils/selectors'
import { resignEmployeeById, loadDailyStoreStaffMonth, getDailyStoreStaff, getEntries, getDailyPayAdjustments, getBigBonuses } from '../utils/userData'
import { resolvePayrollCalculation } from '../utils/payrollResolver'
import { HOLIDAYS_2026, WORKDAYS_2026 } from '../utils/payroll'
import { formatMoney } from '../utils/format'
import { t } from '../utils/text'
import { usePublicMode, useStorePrivacy } from '../visibility'
import { api } from '../utils/api'
import { downloadEmployeePayExcel } from '../utils/employeePayExcel'

const AVATAR_GRADIENTS = [
  'bg-budu-100',
  'bg-violet-100',
  'bg-amber-100',
  'bg-emerald-100',
  'bg-sky-100',
  'bg-violet-100',
  'bg-rose-100',
]

function todayParts() {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return { month: `${d.getFullYear()}-${mm}`, day: `${mm}-${dd}` }
}

function Stat({ label, value, accent, className = '' }) {
  return (
    <div className={`rounded-xl bg-slate-50/80 px-3 py-2 ${className}`}>
      <p className="text-[10px] text-slate-400">{label}</p>
      <p className={`mt-0.5 text-sm font-bold tabular-nums ${accent || 'text-slate-700'}`}>{value}</p>
    </div>
  )
}

function signedMoney(value) {
  const amount = Number(value) || 0
  return `${amount >= 0 ? '+' : '-'}¥${formatMoney(Math.abs(amount))}`
}

/** Gate 24 澄清：payroll 派生金额渲染——null = 无法归属（LEGACY 重名），显示「—」而非 0 */
function payAmount(value, fallback = 0) {
  if (value === null) return t('—')
  return `¥${formatMoney(Number(value) ?? fallback)}`
}
/** 工时渲染：null = 无法归属 → 「—」 */
function payHours(value) {
  if (value === null) return t('—')
  return t('工时 {h}h', { h: Math.round(Number(value) || 0) })
}

const inputCls = 'input'

/** 添加员工弹窗 */
function AddStaffModal({ onClose, onSave }) {
  const [name, setName] = useState('')
  const [type, setType] = useState('parttime')
  const [storeKey, setStoreKey] = useState(() => (allStores()[0] ? allStores()[0].key : ''))
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSave = () => {
    const trimmed = name.trim()
    const storeLabel = storeName(storeKey)
    if (!trimmed) {
      setError(t('请输入员工姓名'))
      return
    }
    if (employeeList('all').some((e) => e.name === trimmed && e.storeKey === storeKey)) {
      // Gate 7：仅拒绝同店同名（服务端 PUT /staff-list 按 name+storeKey findFirst，同店同名会更新既有行而非新建）；
      // 跨店同名允许——Employee.id 才是稳定身份。
      setError(t('该门店已有同名员工，请勿重复添加'))
      return
    }
    onSave({
      name: trimmed,
      type,
      storeKey,
      storeName: storeLabel,
      salary: 0,
      baseHours: 0,
      otHours: 0,
      otPay: 0,
      perf: 0,
      big: 0,
      workedRevenue: 0,
      workedDays: 0,
      achieve: 0,
      duty: 0,
      review: 0,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-slate-800">{t('添加员工')}</h3>
            <p className="mt-1 text-xs text-slate-400">{t('新员工将保存到本地，并同步到值班选择等关联模块')}</p>
          </div>
          <button
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label={t('关闭')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-500">{t('员工姓名')}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('请输入姓名')}
              className={inputCls}
              autoFocus
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-500">{t('人员类型')}</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setType('fulltime')}
                className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
                  type === 'fulltime'
                    ? 'bg-budu-500 text-white shadow-md'
                    : 'bg-slate-50 text-slate-500 hover:bg-budu-50 hover:text-budu-600'
                }`}
              >
                {t('全职雇员')}
              </button>
              <button
                onClick={() => setType('parttime')}
                className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
                  type === 'parttime'
                    ? 'bg-budu-500 text-white shadow-md'
                    : 'bg-slate-50 text-slate-500 hover:bg-budu-50 hover:text-budu-600'
                }`}
              >
                {t('兼职人员')}
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-500">{t('所属门店')}</label>
            <select value={storeKey} onChange={(e) => setStoreKey(e.target.value)} className={inputCls}>
              {allStores().map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          {error && <p className="text-xs font-medium text-rose-500">{error}</p>}

          <button
            onClick={handleSave}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            {t('确认添加')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 删除员工确认弹窗 */
function ConfirmDeleteModal({ name, onClose, onConfirm }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-2xl bg-white p-6 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-slate-800">{t('删除员工')}</h3>
            <p className="mt-1 text-xs text-slate-400">{t('删除后将从人员管理、值班选择和员工绩效中隐藏，历史业绩记录保留')}</p>
          </div>
          <button
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label={t('关闭')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mt-5 rounded-xl bg-rose-50/70 px-4 py-3 text-sm text-slate-600">
          {t('确认删除 {name} 吗？', { name })}
        </p>

        <div className="mt-5 grid grid-cols-2 gap-2.5">
          <button
            onClick={onClose}
            className="rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-200"
          >
            {t('取消')}
          </button>
          <button
            onClick={onConfirm}
            className="rounded-xl bg-rose-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-rose-200/60 transition hover:bg-rose-600"
          >
            {t('确认删除')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 二次确认：删除雇员需输入二级密码（开发者账户） */
function SecondPasswordModal({ name, onClose, onSuccess }) {
  const [pwd, setPwd] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!pwd) {
      setError('请输入二级密码')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api('/auth/verify-second-password', { method: 'POST', body: JSON.stringify({ secondPassword: pwd }) })
      onSuccess()
    } catch (e) {
      setError(e.message || '二级密码不正确')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-2xl bg-white p-6 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-slate-800">二次确认</h3>
            <p className="mt-1 text-xs text-slate-400">删除雇员属于高风险操作，请输入二级密码后继续</p>
          </div>
          <button
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label="关闭"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mt-5 rounded-xl bg-rose-50/70 px-4 py-3 text-sm text-slate-600">
          确认删除 {name} 吗？此操作不可撤销。
        </p>

        <input
          type="password"
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          placeholder="请输入二级密码"
          autoFocus
          className="input mt-4 w-full"
        />
        {error && <p className="mt-2 text-xs font-medium text-rose-500">{error}</p>}

        <div className="mt-5 grid grid-cols-2 gap-2.5">
          <button onClick={onClose} className="rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-200">
            取消
          </button>
          <button onClick={submit} disabled={busy || !pwd} className="rounded-xl bg-rose-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-rose-200/60 transition hover:bg-rose-600 disabled:opacity-50">
            {busy ? '验证中…' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DailyPayModal({ emp, month, day, weekStart, hidePersonal, stableIdentity, attendanceRows, onClose }) {
  const [y, m] = String(month).split('-').map(Number)
  const daysInMonth = new Date(y, m, 0).getDate()
  const weekDays = weekStart ? getWeekDays(weekStart) : null
  const dayRows = []
  const pushDay = (monthKey, dd, label) => {
    const detail = employeeDailyPayDetail(
      monthKey,
      dd,
      emp.name,
      stableIdentity ? emp.id : undefined,
      stableIdentity ? attendanceRows : undefined,
    )
    // 周末/法定节假日标记（与首页日历一致：假=红+「假」、调休=绿+「班」、普通周末=红）
    const full = String(dd).includes('-') ? `${monthKey}-${String(dd).slice(3)}` : `${monthKey}-${String(dd)}`
    const isHolidayDay = HOLIDAYS_2026.has(full)
    const isMakeupDay = WORKDAYS_2026.has(full)
    const dow = new Date(`${full}T00:00:00`).getDay()
    const isWeekendDay = !isHolidayDay && !isMakeupDay && (dow === 0 || dow === 6)
    const mark = isHolidayDay ? 'holiday' : isMakeupDay ? 'makeup' : isWeekendDay ? 'weekend' : null
    dayRows.push({
      day: label,
      mark,
      revenue: detail ? detail.totals.inc : 0,
      orders: detail ? detail.totals.ord : 0,
      hours: detail ? detail.totals.hours : 0,
      basePay: detail ? detail.totals.basePay : 0,
      commission: detail ? detail.totals.commission : 0,
      transferSubsidy: detail ? detail.totals.transferSubsidy : 0,
      bigBonus: detail ? detail.totals.bigBonus : 0,
      automaticPay: detail ? detail.totals.automaticPay : 0,
      salaryAdjustment: detail ? detail.totals.salaryAdjustment : 0,
      payAdjustment: detail ? detail.totals.payAdjustment : null,
      pay: detail ? detail.totals.pay : 0,
      hasData: Boolean(detail),
      stores: detail ? detail.rows.map((r) => r.storeName).join('、') : '',
    })
  }
  if (weekStart && weekDays) {
    for (const w of weekDays) pushDay(w.date.slice(0, 7), w.date.slice(5), w.date.slice(5))
  } else if (day) {
    pushDay(month, day, day)
  } else {
    for (let d = 1; d <= daysInMonth; d += 1) {
      const dd = `${String(d).padStart(2, '0')}`
      pushDay(month, `${String(m).padStart(2, '0')}-${dd}`, dd)
    }
  }
  const totals = dayRows.reduce(
    (s, r) => ({
      revenue: s.revenue + r.revenue,
      orders: s.orders + r.orders,
      hours: s.hours + r.hours,
      basePay: s.basePay + r.basePay,
      commission: s.commission + r.commission,
      transferSubsidy: s.transferSubsidy + r.transferSubsidy,
      bigBonus: s.bigBonus + r.bigBonus,
      automaticPay: s.automaticPay + r.automaticPay,
      salaryAdjustment: s.salaryAdjustment + r.salaryAdjustment,
      pay: s.pay + r.pay,
    }),
    { revenue: 0, orders: 0, hours: 0, basePay: 0, commission: 0, transferSubsidy: 0, bigBonus: 0, automaticPay: 0, salaryAdjustment: 0, pay: 0 },
  )

  const download = () => {
    const selectedDate = day
      ? (String(day).includes('-') ? `${month.slice(0, 4)}-${day}` : `${month}-${String(day).padStart(2, '0')}`)
      : ''
    const periodLabel = weekStart
      ? `本周 ${weekStart} ~ ${weekDays[6].date}`
      : day
        ? `当日 ${selectedDate}`
        : month
    const periodKey = weekStart ? weekStart.replace(/-/g, '') : day ? selectedDate.replace(/-/g, '') : month.replace(/-/g, '')
    downloadEmployeePayExcel({ employeeName: emp.name, periodLabel, periodKey, dayRows, totals })
  }

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={`${emp.name}工资明细`}>
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-lg">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h3 className="text-lg font-bold text-slate-800">{emp.name} · {t(weekStart ? '本周每日工资明细' : day ? '当日工资明细' : '当月每日工资明细')}</h3>
            <p className="mt-0.5 text-xs text-slate-400">{t('{period} · 按日期正序排列', { period: weekStart ? `${weekStart} ~ ${weekDays[6].date}` : day ? `${month}-${day}` : month })}</p>
          </div>
          <button onClick={onClose} className="ml-auto grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400">
            <X className="h-5 w-5" />
          </button>
        </div>

        {hidePersonal ? (
          <p className="grid place-items-center py-16 text-sm text-slate-300">{t('工资详情仅开发者/店长可见')}</p>
        ) : (
          <>
            <div className="mt-3 flex items-center gap-4 text-[11px] text-slate-400">
              <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400" />周末 / 法定节假日</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400" />调休上班（周末补班）</span>
            </div>
            <div className="mt-4 max-h-[52vh] overflow-x-auto overflow-y-auto">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="py-2 pr-2">{t('日期')}</th>
                    <th className="py-2 pr-2 text-right">{t('营业额')}</th>
                    <th className="py-2 pr-2 text-right">{t('订单')}</th>
                    <th className="py-2 pr-2 text-right">{t('工时')}</th>
                    <th className="py-2 pr-2 text-right">{t('基础工资')}</th>
                    <th className="py-2 pr-2 text-right">{t('提成')}</th>
                    <th className="py-2 pr-2 text-right">{t('调货补贴')}</th>
                    <th className="py-2 pr-2 text-right">{t('大单奖')}</th>
                    <th className="py-2 pr-2 text-right">{t('自动工资')}</th>
                    <th className="py-2 pr-2 text-right">{t('薪资调整')}</th>
                    <th className="py-2 pr-2 text-right">{t('当日工资')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {dayRows.map((r) => (
                    <tr key={r.day} className={r.hasData ? '' : 'text-slate-300'}>
                      <td className="py-1.5 pr-2 font-semibold">
                        <span className={r.mark === 'holiday' || r.mark === 'weekend' ? 'text-amber-600' : r.mark === 'makeup' ? 'text-emerald-600' : 'text-slate-700'}>
                          {r.day}
                          {r.mark === 'holiday' && <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-bold text-amber-700">{t('假')}</span>}
                          {r.mark === 'makeup' && <span className="ml-1 rounded bg-emerald-50 px-1 py-0.5 text-[9px] font-bold text-emerald-600">{t('班')}</span>}
                        </span>
                        {r.stores && <span className="ml-1 text-[10px] font-normal text-slate-400">({r.stores})</span>}
                        {r.payAdjustment && <span className="ml-1 rounded bg-violet-50 px-1 py-0.5 text-[9px] text-violet-600">{t('已调整')}</span>}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{r.hasData ? `¥${r.revenue.toFixed(2)}` : '—'}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{r.hasData ? r.orders : '—'}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{r.hasData ? `${r.hours}h` : '—'}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{r.hasData ? `¥${r.basePay.toFixed(2)}` : '—'}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{r.hasData ? `¥${r.commission.toFixed(2)}` : '—'}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-emerald-600">
                        {r.hasData ? `¥${r.transferSubsidy.toFixed(2)}` : '—'}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">
                        {r.hasData && r.bigBonus > 0 ? `¥${r.bigBonus.toFixed(2)}` : '—'}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{r.hasData ? `¥${r.automaticPay.toFixed(2)}` : '—'}</td>
                      <td className={`py-1.5 pr-2 text-right tabular-nums ${r.payAdjustment ? 'font-semibold text-violet-600' : ''}`}>
                        {r.payAdjustment ? signedMoney(r.salaryAdjustment) : '—'}
                      </td>
                      <td className="py-1.5 pr-2 text-right font-bold tabular-nums text-budu-600">
                        {r.hasData ? `¥${r.pay.toFixed(2)}` : '—'}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-budu-50/40 font-bold">
                    <td className="py-2 pr-2 text-slate-700">{t('合计')}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-slate-700">¥{totals.revenue.toFixed(2)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-slate-700">{totals.orders}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-slate-700">{totals.hours}h</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-slate-700">¥{totals.basePay.toFixed(2)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-slate-700">¥{totals.commission.toFixed(2)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-emerald-600">¥{totals.transferSubsidy.toFixed(2)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-slate-700">¥{totals.bigBonus.toFixed(2)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-slate-700">¥{totals.automaticPay.toFixed(2)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-violet-600">{signedMoney(totals.salaryAdjustment)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-budu-600">¥{totals.pay.toFixed(2)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {dayRows.some((row) => row.payAdjustment) && (
              <div className="mt-4 space-y-2">
                <p className="text-xs font-bold text-slate-600">{t('人工调整明细')}</p>
                {dayRows.filter((row) => row.payAdjustment).map((row) => (
                  <div key={`adjustment-${row.day}`} className="rounded-xl border border-violet-100 bg-violet-50/60 px-4 py-3 text-xs text-violet-700">
                    <p className="font-semibold">
                      {row.day} · {t('自动 ¥{auto} → 最终 ¥{final}（差额 {difference}）', {
                        auto: row.payAdjustment.autoPaySnapshot.toFixed(2),
                        final: row.payAdjustment.adjustedPay.toFixed(2),
                        difference: signedMoney(row.payAdjustment.recordedDifference),
                      })}
                    </p>
                    <p className="mt-1 break-words">{t('原因')}：{row.payAdjustment.reason}</p>
                    <p className="mt-1 text-violet-400">{t('操作人')}：{row.payAdjustment.updatedBy || row.payAdjustment.createdBy || '—'} · {row.payAdjustment.updatedAt ? new Date(row.payAdjustment.updatedAt).toLocaleString('zh-CN') : '—'}</p>
                  </div>
                ))}
              </div>
            )}
            <button
              onClick={download}
              className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
            >
              <FileSpreadsheet className="h-4 w-4" />
              {t('导出 Excel')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default function PersonnelPage({ onBack, canDelete = false, canManage = false, user, onOpenProfile }) {
  const isPublic = usePublicMode()
  const isStore = useStorePrivacy()
  const hidePersonal = isPublic || isStore
  const [filter, setFilter] = useState(() => (['developer', 'finance', 'admin'].includes(user?.role) ? 'all' : 'fulltime'))
  const [month, setMonth] = useState(() => todayParts().month)
  const [day, setDay] = useState(null)
  const [weekStart, setWeekStart] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [showSecondPwd, setShowSecondPwd] = useState(false)
  const [bigBonusEmp, setBigBonusEmp] = useState(null)
  const [adjustmentEmp, setAdjustmentEmp] = useState(null)
  const [detailEmp, setDetailEmp] = useState(null)
  const [showExport, setShowExport] = useState(false)
  const [syncTick, setSyncTick] = useState(0)

  // 与全局 8 秒数据同步保持一致：大单奖/业绩等新增后自动刷新卡片
  useEffect(() => {
    const id = setInterval(() => setSyncTick((v) => v + 1), 8000)
    return () => clearInterval(id)
  }, [])
  const [staffVersion, setStaffVersion] = useState(0)

  const localStaff = localStaffList()
  // Gate 7：PersonnelPage 当前目录卡片 = PostgreSQL Employee 当前在册记录（均有 Employee.id）。
  // Gate 24：月度工资/绩效展示改为统一 payroll resolver（resolvePayrollCalculation）——
  //   EMPLOYEE_ID 模式按 Employee.id join（同店同名各自正确）；
  //   LEGACY 模式显式标记兼容计算，且重名员工不把模糊 legacy 金额当精确结果。
  // 历史 payroll 合成员工（当前目录之外、无 Employee.id）一律不出现在当前人员目录。
  const directory = currentEmployeeDirectory('all')
  // Gate 24：卡片渲染以当前 PG 目录为准（hasData = 目录有员工；不再由"当月有无薪资数据"决定）
  const hasData = directory.length > 0
  const dayHasData = day ? hasLocalEntry(month, day) : false
  const weekDays = weekStart ? getWeekDays(weekStart) : null
  const weekLabel = weekDays ? `${weekStart} ~ ${weekDays[6].date}` : ''

  // Gate 29F：日/周稳定工资必须先加载所选日期覆盖的每一个月份。
  // 请求键只由所选期间决定；员工切换不发请求，渲染始终使用当前 Employee.id，避免迟到的 A 覆盖 B。
  const periodDates = weekDays
    ? weekDays.map((item) => item.date)
    : day
      ? [String(day).includes('-') ? `${month.slice(0, 4)}-${day}` : `${month}-${day}`]
      : []
  const periodKey = periodDates.join('|')
  const [periodAttendance, setPeriodAttendance] = useState({ status: 'idle', key: '', rows: [] })
  const periodRequestRef = useRef(0)
  useEffect(() => {
    if (periodDates.length === 0) {
      setPeriodAttendance({ status: 'idle', key: '', rows: [] })
      return undefined
    }
    const requestId = periodRequestRef.current + 1
    periodRequestRef.current = requestId
    const key = periodDates.join('|')
    const months = payrollPeriodMonths(periodDates)
    setPeriodAttendance({ status: 'loading', key, rows: [] })
    let cancelled = false
    Promise.all(months.map((monthKey) => loadDailyStoreStaffMonth(monthKey))).then(() => {
      if (cancelled || periodRequestRef.current !== requestId) return
      const rows = months.flatMap((monthKey) => getDailyStoreStaff(monthKey))
      setPeriodAttendance({ status: 'ready', key, rows })
    })
    return () => { cancelled = true }
    // syncTick/staffVersion intentionally reload the current period from the month-keyed cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, day, weekStart, staffVersion, syncTick])

  // ---- Gate 24：显式月份加载 + resolver（竞态安全：晚到的响应不覆盖当前所选月）----
  const [payrollDisplay, setPayrollDisplay] = useState({ status: 'loading', month: '', mode: '', byEmployeeId: new Map(), legacyByName: new Map(), legacyAmbiguousNames: new Set() })
  const requestedMonthRef = useRef('')
  useEffect(() => {
    const m = String(month || '')
    requestedMonthRef.current = m
    setPayrollDisplay((prev) => ({ ...prev, status: 'loading', month: m }))
    let cancelled = false
    loadDailyStoreStaffMonth(m).then(() => {
      if (cancelled || requestedMonthRef.current !== m) return // 竞态：已切换月份则丢弃
      const res = resolvePayrollCalculation({
        month: m,
        dailyEntries: getEntries(),
        dailyStoreStaffRows: getDailyStoreStaff(m),
        dailyPayAdjustments: getDailyPayAdjustments(),
        bigOrderBonuses: getBigBonuses(),
        employees: directory,
        users: [],
      })
      if (cancelled || requestedMonthRef.current !== m) return
      if (res.mode === 'EMPLOYEE_ID') {
        const byId = new Map(res.payroll.employees.map((row) => [row.employeeId, { ...row, payrollComputed: true }]))
        setPayrollDisplay({ status: 'ready', month: m, mode: 'EMPLOYEE_ID', byEmployeeId: byId, legacyByName: new Map(), legacyAmbiguousNames: new Set() })
      } else {
        // LEGACY 兼容：按姓名聚合；模糊判定 = 当前目录中同名员工数 > 1
        // （legacy 结果本身把重名合并成一行，无法反推——以目录为准，绝不给重名卡精确金额）
        const byName = new Map()
        for (const row of res.payroll.employees) byName.set(row.name, row)
        const ambiguous = legacyAmbiguousEmployeeNames(directory)
        setPayrollDisplay({ status: 'ready', month: m, mode: 'LEGACY', byEmployeeId: new Map(), legacyByName: byName, legacyAmbiguousNames: ambiguous })
      }
    }).catch(() => {
      if (cancelled || requestedMonthRef.current !== m) return
      setPayrollDisplay((prev) => ({ ...prev, status: 'ready', month: m }))
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, staffVersion, syncTick])

  // Gate 24：卡片 payroll 富集——EMPLOYEE_ID 按 id；LEGACY 唯一名兼容、重名不赋值
  const enrichPayroll = (d) => {
    if (payrollDisplay.mode === 'EMPLOYEE_ID') {
      return payrollDisplay.byEmployeeId.get(d.id) || {}
    }
    if (payrollDisplay.mode === 'LEGACY') {
      if (payrollDisplay.legacyAmbiguousNames.has(d.name)) return { legacyAmbiguous: true } // 重名模糊：不给精确金额
      return payrollDisplay.legacyByName.get(d.name) || {}
    }
    return {}
  }
  const all = directory.map((d) => {
    const p = enrichPayroll(d)
    if (p.legacyAmbiguous) {
      // Gate 24 澄清：LEGACY 重名无法归属 → payroll 派生字段为 null（渲染「—」），
      // 绝不以数字零冒充"零工资"；非 payroll 员工字段保持原样。
      return {
        ...d,
        legacyAmbiguous: true,
        salary: null, basePay: null, perf: null, big: null, transferSubsidy: null,
        hours: null, workedRevenue: null, workedDays: null,
        salaryAdjustment: null, adjustmentCount: null, payrollComputed: false, roi: null,
      }
    }
    // Gate 24：payroll 派生字段缺失时给安全默认（未就绪等场景不崩溃）
    return {
      ...d,
      salary: p.salary ?? 0,
      basePay: p.basePay ?? 0,
      perf: p.perf ?? p.commission ?? 0,
      big: p.big ?? p.bigBonus ?? 0,
      transferSubsidy: p.transferSubsidy ?? 0,
      hours: p.hours ?? p.actualHours ?? 0,
      workedRevenue: p.workedRevenue ?? 0,
      workedDays: p.workedDays ?? p.days ?? 0,
      salaryAdjustment: p.salaryAdjustment ?? 0,
      adjustmentCount: p.adjustmentCount ?? 0,
      payrollComputed: p.payrollComputed === true,
      roi: p.roi ?? (p.workedRevenue != null && p.salary ? p.workedRevenue / p.salary : 0),
    }
  })
  const scopedAll =
    user?.role === 'staff' && user.staffKey
      ? all.filter((e) => `${e.storeKey}::${e.name}` === user.staffKey)
      : all
  const fulltime = scopedAll.filter((e) => e.type === 'fulltime')
  const parttime = scopedAll.filter((e) => e.type === 'parttime')
  const list = filter === 'all' ? scopedAll : filter === 'fulltime' ? fulltime : parttime
  const payrollComputed = all.some((e) => e.payrollComputed)

  const handleAddStaff = async (emp) => {
    setShowAdd(false)
    try {
      await saveLocalStaffList([...localStaffList(), emp])
      setStaffVersion((v) => v + 1)
      // 自动生成员工档案（幂等：已存在的跳过），让「员工档案」页立即可见新员工
      await api('/v2/employees/backfill', { method: 'POST' })
    } catch (e) {
      setError(t('员工名单保存失败（PostgreSQL 不可用），请重试'))
    }
  }

  const handleDeleteStaff = async (emp) => {
    // Gate 7：当前目录员工卡片必须携带 Employee.id；删除/离职只按 id 定向，
    // 绝不回退到按姓名移除（removeStaff(name) 会误伤同名员工）。
    if (!emp?.id) {
      setError(t('员工数据不完整（缺少稳定 ID），无法删除，请刷新后重试'))
      return
    }
    try {
      await resignEmployeeById(emp.id)
      setStaffVersion((v) => v + 1)
    } catch (e) {
      setError(t('员工名单保存失败（PostgreSQL 不可用），请重试'))
    }
  }

  return (
    <div className="space-y-6">
      {user?.role === 'staff' && (
        <p className="rounded-xl bg-budu-50 px-4 py-2.5 text-xs font-semibold text-budu-600">
          {t('当前账号仅可查看本人信息')}
        </p>
      )}
      {/* 页面头部 */}
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-2xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-500 shadow-card transition hover:text-budu-600"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('返回首页')}
        </button>
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t('人员管理')}</h2>
          <p className="mt-0.5 text-[13px] text-slate-400">
            {payrollComputed
              ? t('薪酬按每日业绩录入自动计算 · 全职 {full} 人 / 兼职 {part} 人', {
                  full: fulltime.length,
                  part: parttime.length,
                })
              : t('薪资表 2026.27-31 周 · 按所选月份显示 · 全职 {full} 人 / 兼职 {part} 人', {
                  full: fulltime.length,
                  part: parttime.length,
                })}
            {weekStart
              ? t('· 查看整周 {range}', { range: weekLabel })
              : day
                ? t('· 当日值班查询中')
                : ''}
            {payrollDisplay.mode === 'EMPLOYEE_ID' && (
              <span className="ml-2 inline-flex items-center rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600">
                {t('稳定计算')}
              </span>
            )}
            {payrollDisplay.mode === 'LEGACY' && (
              <span className="ml-2 inline-flex items-center rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-600">
                {t('兼容计算')}
              </span>
            )}
            {payrollDisplay.status === 'loading' && (
              <span className="ml-2 inline-flex items-center rounded-md bg-slate-50 px-1.5 py-0.5 text-[10px] font-bold text-slate-400">
                {t('加载中…')}
              </span>
            )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          {canManage && !isPublic && (
            <button
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-1.5 rounded-2xl bg-budu-500 px-3.5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
            >
              <Plus className="h-4 w-4" />
              {t('添加员工')}
            </button>
          )}
          <CalendarPicker
            month={month}
            day={day}
            weekStart={weekStart}
            onSelect={(m, d) => {
              setMonth(m)
              setDay(d)
              if (d) setWeekStart(null)
            }}
            onWeekSelect={(ws) => {
              setMonth(ws.slice(0, 7))
              setDay(null)
              setWeekStart(ws)
            }}
          />
        </div>
      </div>

      {/* 类型切换 */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex flex-wrap gap-1.5 rounded-2xl bg-white p-1.5 shadow-card">
            {['developer', 'finance', 'admin'].includes(user?.role) && (
              <button
                onClick={() => setFilter('all')}
                className={`rounded-xl px-4 py-1.5 text-[13px] font-semibold transition ${
                  filter === 'all'
                    ? 'bg-budu-500 text-white shadow-md'
                    : 'text-slate-500 hover:bg-budu-50 hover:text-budu-600'
                }`}
              >
                {t('全部')}（{scopedAll.length}）
              </button>
            )}
            <button
              onClick={() => setFilter('fulltime')}
                className={`rounded-xl px-4 py-1.5 text-[13px] font-semibold transition ${
                filter === 'fulltime'
                  ? 'bg-budu-500 text-white shadow-md'
                  : 'text-slate-500 hover:bg-budu-50 hover:text-budu-600'
              }`}
            >
              {t('全职人员')}（{fulltime.length}）
            </button>
            <button
              onClick={() => setFilter('parttime')}
                className={`rounded-xl px-4 py-1.5 text-[13px] font-semibold transition ${
                filter === 'parttime'
                  ? 'bg-budu-500 text-white shadow-md'
                  : 'text-slate-500 hover:bg-budu-50 hover:text-budu-600'
              }`}
            >
              {t('兼职人员')}（{parttime.length}）
            </button>
          </div>
          {['developer', 'finance', 'admin'].includes(user?.role) && (
            <button
              onClick={() => setShowExport(true)}
              className="ml-auto flex items-center gap-1.5 rounded-2xl bg-emerald-500 px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm transition hover:opacity-90"
            >
              <FileSpreadsheet className="h-4 w-4" />
              {t('导出表格')}
            </button>
          )}
        </div>
      </div>

      {day && !dayHasData && (
        <div className="rounded-2xl border border-amber-100 bg-amber-50/70 px-4 py-3 text-xs font-medium text-amber-600">
          {t('所选日期 {date} 暂无业绩录入，请先在「门店经营 → 门店业绩录入」登记当日值班人员与业绩', {
            date: `${month.slice(5)}-${day}`,
          })}
        </div>
      )}

      {hasData ? (
        <>
          {/* 员工卡片 */}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" data-sync-tick={syncTick}>
            {list.map((emp, i) => {
              const periodReady = periodAttendance.status === 'ready' && periodAttendance.key === periodKey
              const stablePeriod = payrollDisplay.mode === 'EMPLOYEE_ID'
              const legacyPeriod = payrollDisplay.mode === 'LEGACY' && !emp.legacyAmbiguous
              const status = weekStart
                ? weekDays && (stablePeriod ? periodReady : legacyPeriod)
                  ? employeeWeekStatus(month, weekDays.map((w) => w.date), emp.name, stablePeriod ? emp.id : undefined, stablePeriod ? periodAttendance.rows : undefined)
                  : null
                : day && (stablePeriod ? periodReady : legacyPeriod)
                  ? employeeDayStatus(month, day, emp.name, stablePeriod ? emp.id : undefined, stablePeriod ? periodAttendance.rows : undefined)
                  : null
              const hasPeriodResult = Boolean((day || weekStart) && status)
              const onDuty = Boolean(hasPeriodResult && !status.adjustmentOnly)
              const periodSalary = hasPeriodResult ? status.pay : 0
              const periodHours = hasPeriodResult ? status.hours : 0
              const periodPerf = hasPeriodResult ? status.commission : 0
              const periodBase = hasPeriodResult ? status.basePay : day || weekStart ? 0 : emp.basePay || 0
              const periodTransfer = hasPeriodResult ? status.transferSubsidy || 0 : day || weekStart ? 0 : emp.transferSubsidy || 0
              const periodBig = hasPeriodResult ? status.bigBonus || 0 : day || weekStart ? 0 : emp.big || 0
              const periodAdjustment = hasPeriodResult ? status.salaryAdjustment || 0 : day || weekStart ? 0 : emp.salaryAdjustment || 0
              const periodAdjustmentCount = hasPeriodResult ? status.adjustmentCount || (status.payAdjustment ? 1 : 0) : day || weekStart ? 0 : emp.adjustmentCount || 0
              const periodRevenue = hasPeriodResult ? status.inc : 0
              const periodStores = onDuty && status.stores ? status.stores.length : 0
              const periodWorkedDays = weekStart
                ? status ? status.workedDays : 0
                : day
                  ? onDuty ? 1 : 0
                  : emp.workedDays
              const periodText = weekStart
                ? `${Number(weekStart.slice(5, 7))}.${Number(weekStart.slice(8, 10))} - ${Number(weekDays[6].date.slice(5, 7))}.${Number(weekDays[6].date.slice(8, 10))}`
                : day
                  ? `${Number(day.slice(0, 2))}.${Number(day.slice(3, 5))}`
                  : monthLabel(month)
              const canBigBonus =
                user?.role !== 'public' && (user?.role !== 'staff' || user.staffKey === `${emp.storeKey}::${emp.name}`)
              return (
                <div
                  key={emp.id}
                  onClick={() => setDetailEmp(emp)}
                  className="card relative cursor-pointer p-5 transition duration-300 hover:-translate-y-0.5 hover:shadow-card-hover"
                >
                  {canDelete && !isPublic && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setPendingDelete(emp)
                      }}
                      className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-lg text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"
                      title={t('删除该员工')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {onOpenProfile && !isPublic && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpenProfile(emp.name, emp.id)
                      }}
                      className="absolute right-11 top-3 grid h-7 w-7 place-items-center rounded-lg text-slate-300 transition hover:bg-budu-50 hover:text-budu-600"
                      title={t('员工档案')}
                    >
                      <IdCard className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <div className="flex items-center gap-3">
                    <div
                      className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl text-base font-bold shadow-sm ${
                        AVATAR_GRADIENTS[i % AVATAR_GRADIENTS.length]
                      }`}
                    >
                      {emp.name[0]}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[15px] font-bold text-slate-800">{emp.name}</p>
                        {emp.employeeNo && (
                          <span className="shrink-0 rounded-md bg-slate-50 px-1.5 py-0.5 text-[10px] font-bold text-slate-400">
                            {emp.employeeNo}
                          </span>
                        )}
                        {emp.legacyAmbiguous && (
                          <span className="shrink-0 rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-600" title={t('兼容计算下存在同名员工，金额无法精确归属')}>
                            {t('身份模糊')}
                          </span>
                        )}
                        <span
                          className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                            emp.type === 'fulltime'
                              ? 'bg-budu-500 text-white'
                              : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {emp.type === 'fulltime' ? t('全职') : t('兼职')}
                        </span>
                        {emp.local && (
                          <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-600">
                            {t('本地')}
                          </span>
                        )}
                        {(day || weekStart) && onDuty && (
                          <span className="flex items-center gap-1 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                            {t('值班')}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-slate-400">
                        {emp.storeName} · {emp.legacyAmbiguous && !day && !weekStart ? t('出勤 —') : t('出勤 {days} 天', { days: periodWorkedDays })}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between rounded-lg bg-budu-50/60 px-2.5 py-1">
                    <span className="text-[10px] font-bold text-budu-600">{periodText}</span>
                    {weekStart && <span className="text-[10px] text-slate-400">{t('第 {n} 周', { n: isoWeek(weekStart) })}</span>}
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <Stat
                      label={weekStart ? t('周工资') : day ? t('当日工资') : t('工资合计')}
                      value={hidePersonal ? '•••' : (emp.legacyAmbiguous && !day && !weekStart ? payAmount(null) : `¥${formatMoney(weekStart || day ? periodSalary : emp.salary)}`)}
                      accent="text-budu-600"
                    />
                    <Stat
                      label={t('基础工资')}
                      value={hidePersonal ? '•••' : (emp.legacyAmbiguous && !day && !weekStart ? payAmount(null) : `¥${formatMoney(periodBase)}`)}
                    />
                    <Stat
                      label={t('业绩提成')}
                      value={hidePersonal ? '•••' : (emp.legacyAmbiguous && !day && !weekStart ? payAmount(null) : `¥${formatMoney(weekStart || day ? periodPerf : emp.perf + emp.big)}`)}
                      accent="text-budu-600"
                    />
                    <Stat
                      label={t('大单奖')}
                      value={hidePersonal ? '•••' : (emp.legacyAmbiguous && !day && !weekStart ? payAmount(null) : `¥${formatMoney(periodBig)}`)}
                      accent="text-amber-600"
                    />
                    <Stat
                      label={t('调货补贴')}
                      value={hidePersonal ? '•••' : (emp.legacyAmbiguous && !day && !weekStart ? payAmount(null) : `¥${formatMoney(periodTransfer)}`)}
                      accent="text-emerald-600"
                      className="col-span-2"
                    />
                    {periodAdjustmentCount > 0 && (
                      <Stat
                        label={t('薪资调整')}
                        value={hidePersonal ? '•••' : (emp.legacyAmbiguous && !day && !weekStart ? payAmount(null) : signedMoney(periodAdjustment))}
                        accent="text-violet-600"
                        className="col-span-2"
                      />
                    )}
                  </div>

                  <div className="mt-3 flex items-center justify-between rounded-xl bg-slate-50/80 px-3 py-2 text-[11px] text-slate-400">
                    <span>{emp.legacyAmbiguous && !day && !weekStart ? t('工时 —') : t('工时 {h}h', { h: Math.round(weekStart || day ? periodHours : emp.hours) })}</span>
                    <span>{isPublic ? '•••' : (emp.legacyAmbiguous && !day && !weekStart ? t('营业额 —') : t('营业额 ¥{amount}', { amount: formatMoney(weekStart || day ? periodRevenue : emp.workedRevenue) }))}</span>
                  </div>

                  {canBigBonus && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setBigBonusEmp(emp)
                      }}
                      className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-amber-500 px-3 py-2 text-xs font-bold text-white shadow-sm transition hover:shadow active:scale-95"
                    >
                      <Award className="h-3.5 w-3.5" />
                      {t('大单奖')}
                    </button>
                  )}

                  {['developer', 'finance', 'admin'].includes(user?.role) && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setAdjustmentEmp(emp)
                      }}
                      className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl bg-violet-600 px-3 py-2 text-xs font-bold text-white shadow-sm transition hover:shadow active:scale-95"
                    >
                      <BadgeDollarSign className="h-3.5 w-3.5" />
                      {t('调整每日薪资')}
                    </button>
                  )}

                  {day || weekStart ? (
                    <div className="mt-3 flex items-center justify-between rounded-xl bg-slate-50/80 px-3 py-2">
                      {status ? (
                        <>
                          <span className="text-xs font-semibold text-slate-500">
                            {status.adjustmentOnly
                              ? t('仅薪资调整 · 无考勤记录')
                              : t(weekStart ? '本周值班 · {count} 天 · {stores} 家店' : '当日值班 · {count} 家店', {
                                  count: weekStart ? status.workedDays : periodStores,
                                  stores: periodStores,
                                })}
                          </span>
                          {isPublic ? (
                            <span className="text-xs font-bold text-slate-300">•••</span>
                          ) : (
                            <span className="text-xs font-bold tabular-nums text-emerald-600">
                              ¥{formatMoney(status.inc)} · {t('{n} 单', { n: Math.round(status.ord) })}
                            </span>
                          )}
                        </>
                      ) : day && dayHasData ? (
                        <span className="text-xs font-medium text-slate-400">{t('当日休息')}</span>
                      ) : (
                        <span className="text-xs text-slate-300">{t('当日无业绩录入')}</span>
                      )}
                    </div>
                  ) : (
                    <div className="mt-3 flex items-center justify-between">
                      <span className="text-[11px] text-slate-300">{t('ROI = 当班营业额 / 工资')}</span>
                      {emp.legacyAmbiguous && !day && !weekStart ? (
                        <span className="rounded-lg bg-slate-50 px-2 py-0.5 text-xs font-bold text-slate-400">{t('ROI —')}</span>
                      ) : (
                        <span
                          className={`rounded-lg px-2 py-0.5 text-xs font-bold ${
                            emp.roi >= 8 ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
                          }`}
                        >
                          {hidePersonal ? '•••' : `ROI ${emp.roi.toFixed(2)}x`}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {list.length === 0 && (
            <div className="card grid place-items-center py-16 text-sm text-slate-300">
              {t('暂无该类人员数据，点击右上角「添加员工」新建')}
            </div>
          )}
        </>
      ) : (
        /* 无薪资数据月份的空态 */
        <div className="card grid place-items-center py-20 text-center">
          <CalendarDays className="h-9 w-9 text-slate-200" />
          <p className="mt-3 text-sm font-semibold text-slate-400">
            {t('{month}暂无薪资数据', { month: monthLabel(month) })}
          </p>
          <p className="mt-1.5 text-xs text-slate-300">
            {t('当前薪资表覆盖 2026.27-31 周（6 月 ~ 8 月）；已录入业绩的月份自动计算薪酬，可切换日历月份或添加本地员工')}
          </p>
        </div>
      )}

      {showAdd && <AddStaffModal onClose={() => setShowAdd(false)} onSave={handleAddStaff} />}
      {pendingDelete && !showSecondPwd && (
        <ConfirmDeleteModal
          name={pendingDelete.name}
          onClose={() => setPendingDelete(null)}
          onConfirm={() => {
            if (canDelete) setShowSecondPwd(true)
            else {
              handleDeleteStaff(pendingDelete)
              setPendingDelete(null)
            }
          }}
        />
      )}
      {pendingDelete && showSecondPwd && (
        <SecondPasswordModal
          name={pendingDelete.name}
          onClose={() => {
            setShowSecondPwd(false)
            setPendingDelete(null)
          }}
          onSuccess={() => {
            handleDeleteStaff(pendingDelete)
            setShowSecondPwd(false)
            setPendingDelete(null)
          }}
        />
      )}
      {showExport && (
        <ExportSalaryModal
          employees={list}
          month={month}
          day={day}
          weekStart={weekStart}
          onClose={() => setShowExport(false)}
        />
      )}
      {detailEmp && (        <DailyPayModal
          emp={detailEmp}
          month={month}
          day={day}
          weekStart={weekStart}
          hidePersonal={hidePersonal}
          stableIdentity={payrollDisplay.mode === 'EMPLOYEE_ID'}
          attendanceRows={day || weekStart ? (periodAttendance.key === periodKey ? periodAttendance.rows : []) : getDailyStoreStaff(month)}
          onClose={() => setDetailEmp(null)}
        />
      )}
      {bigBonusEmp && <BigBonusModal emp={bigBonusEmp} currentUser={user} onClose={() => setBigBonusEmp(null)} />}
      {adjustmentEmp && (
        <DailyPayAdjustmentModal
          emp={adjustmentEmp}
          currentUser={user}
          initialDate={day ? `${month}-${day.slice(3)}` : weekStart || (month === todayParts().month ? `${month}-${todayParts().day.slice(3)}` : `${month}-01`)}
          onClose={() => setAdjustmentEmp(null)}
          onSaved={() => setSyncTick((value) => value + 1)}
        />
      )}
    </div>
  )
}
