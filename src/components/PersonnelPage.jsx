import { useEffect, useState } from 'react'
import { ArrowLeft, Award, BadgeDollarSign, CalendarDays, FileSpreadsheet, Plus, Trash2, X } from 'lucide-react'
import CalendarPicker from './CalendarPicker'
import BigBonusModal from './BigBonusModal'
import DailyPayAdjustmentModal from './DailyPayAdjustmentModal'
import ExportSalaryModal from './ExportSalaryModal'
import { getWeekDays, isoWeek } from '../utils/schedule'
import {
  employeesByType,
  employeeList,
  allEmployeeMonths,
  monthLabel,
  employeeDayStatus,
  employeeDailyPayDetail,
  employeeWeekStatus,
  hasLocalEntry,
  localStaffList,
  removeStaff,
  saveLocalStaffList,
  allStores,
  storeName,
} from '../utils/selectors'
import { HOLIDAYS_2026, WORKDAYS_2026 } from '../utils/payroll'
import { formatMoney } from '../utils/format'
import { useI18n } from '../i18n'
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

const inputCls = 'input'

/** 添加员工弹窗 */
function AddStaffModal({ onClose, onSave }) {
  const { t } = useI18n()
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
    const storeLabel = storeKey === 'multi' ? '多店支援' : storeName(storeKey)
    if (!trimmed) {
      setError(t('请输入员工姓名'))
      return
    }
    if (employeeList('all').some((e) => e.name === trimmed)) {
      setError(t('该员工已存在，请勿重复添加'))
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
              <option value="multi">{t('多店支援')}</option>
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
  const { t } = useI18n()
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

function DailyPayModal({ emp, month, day, weekStart, hidePersonal, onClose }) {
  const { t } = useI18n()
  const [y, m] = String(month).split('-').map(Number)
  const daysInMonth = new Date(y, m, 0).getDate()
  const weekDays = weekStart ? getWeekDays(weekStart) : null
  const dayRows = []
  const pushDay = (monthKey, dd, label) => {
    const detail = employeeDailyPayDetail(monthKey, dd, emp.name)
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

export default function PersonnelPage({ onBack, canDelete = false, canManage = false, user }) {
  const { t } = useI18n()
  const isPublic = usePublicMode()
  const isStore = useStorePrivacy()
  const hidePersonal = isPublic || isStore
  const [filter, setFilter] = useState(() => (user?.role === 'developer' || user?.role === 'finance' ? 'all' : 'fulltime'))
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
  const hasData = allEmployeeMonths().includes(month) || localStaff.length > 0
  const dayHasData = day ? hasLocalEntry(month, day) : false
  const weekDays = weekStart ? getWeekDays(weekStart) : null
  const weekLabel = weekDays ? `${weekStart} ~ ${weekDays[6].date}` : ''

  const all = hasData ? employeeList('all', month) : []
  const scopedAll =
    user?.role === 'staff' && user.staffKey
      ? all.filter((e) => `${e.storeKey}::${e.name}` === user.staffKey)
      : all
  const fulltime = scopedAll.filter((e) => e.type === 'fulltime')
  const parttime = scopedAll.filter((e) => e.type === 'parttime')
  const list = filter === 'all' ? scopedAll : filter === 'fulltime' ? fulltime : parttime
  const payrollComputed = all.some((e) => e.payrollComputed)

  const handleAddStaff = (emp) => {
    saveLocalStaffList([...localStaffList(), emp])
    setStaffVersion((v) => v + 1)
    setShowAdd(false)
  }

  const handleDeleteStaff = (name) => {
    removeStaff(name)
    setStaffVersion((v) => v + 1)
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
            {(user?.role === 'developer' || user?.role === 'finance') && (
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
          {(user?.role === 'developer' || user?.role === 'finance') && (
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
              const status = weekStart
                ? weekDays
                  ? employeeWeekStatus(month, weekDays.map((w) => w.date), emp.name)
                  : null
                : day
                  ? employeeDayStatus(month, day, emp.name)
                  : null
              const onDuty = Boolean((day || weekStart) && status)
              const periodSalary = onDuty ? status.pay : 0
              const periodHours = onDuty ? status.hours : 0
              const periodPerf = onDuty ? status.commission : 0
              const periodBase = onDuty ? status.basePay : day || weekStart ? 0 : emp.basePay || 0
              const periodTransfer = onDuty ? status.transferSubsidy || 0 : day || weekStart ? 0 : emp.transferSubsidy || 0
              const periodBig = onDuty ? status.bigBonus || 0 : day || weekStart ? 0 : emp.big || 0
              const periodAdjustment = onDuty ? status.salaryAdjustment || 0 : day || weekStart ? 0 : emp.salaryAdjustment || 0
              const periodAdjustmentCount = onDuty ? status.adjustmentCount || (status.payAdjustment ? 1 : 0) : day || weekStart ? 0 : emp.adjustmentCount || 0
              const periodRevenue = onDuty ? status.inc : 0
              const periodStores = onDuty && status.stores ? status.stores.length : 0
              const periodWorkedDays = weekStart
                ? status ? status.workedDays : 0
                : day
                  ? status ? 1 : 0
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
                  key={emp.name}
                  onClick={() => setDetailEmp(emp)}
                  className="card relative cursor-pointer p-5 transition duration-300 hover:-translate-y-0.5 hover:shadow-card-hover"
                >
                  {canDelete && !isPublic && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setPendingDelete(emp.name)
                      }}
                      className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-lg text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"
                      title={t('删除该员工')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
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
                        {(day || weekStart) && status && (
                          <span className="flex items-center gap-1 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                            {t('值班')}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-slate-400">
                        {emp.storeName} · {t('出勤 {days} 天', { days: periodWorkedDays })}
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
                      value={hidePersonal ? '•••' : `¥${formatMoney(weekStart || day ? periodSalary : emp.salary)}`}
                      accent="text-budu-600"
                    />
                    <Stat
                      label={t('基础工资')}
                      value={hidePersonal ? '•••' : `¥${formatMoney(periodBase)}`}
                    />
                    <Stat
                      label={t('业绩提成')}
                      value={hidePersonal ? '•••' : `¥${formatMoney(weekStart || day ? periodPerf : emp.perf + emp.big)}`}
                      accent="text-budu-600"
                    />
                    <Stat
                      label={t('大单奖')}
                      value={hidePersonal ? '•••' : `¥${formatMoney(periodBig)}`}
                      accent="text-amber-600"
                    />
                    <Stat
                      label={t('调货补贴')}
                      value={hidePersonal ? '•••' : `¥${formatMoney(periodTransfer)}`}
                      accent="text-emerald-600"
                      className="col-span-2"
                    />
                    {periodAdjustmentCount > 0 && (
                      <Stat
                        label={t('薪资调整')}
                        value={hidePersonal ? '•••' : signedMoney(periodAdjustment)}
                        accent="text-violet-600"
                        className="col-span-2"
                      />
                    )}
                  </div>

                  <div className="mt-3 flex items-center justify-between rounded-xl bg-slate-50/80 px-3 py-2 text-[11px] text-slate-400">
                    <span>{t('工时 {h}h', { h: Math.round(weekStart || day ? periodHours : emp.hours) })}</span>
                    <span>{isPublic ? '•••' : t('营业额 ¥{amount}', { amount: formatMoney(weekStart || day ? periodRevenue : emp.workedRevenue) })}</span>
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

                  {(user?.role === 'developer' || user?.role === 'finance') && (
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
                            {t(weekStart ? '本周值班 · {count} 天 · {stores} 家店' : '当日值班 · {count} 家店', {
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
                      <span
                        className={`rounded-lg px-2 py-0.5 text-xs font-bold ${
                          emp.roi >= 8 ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
                        }`}
                      >
                        {hidePersonal ? '•••' : `ROI ${emp.roi.toFixed(2)}x`}
                      </span>
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
          name={pendingDelete}
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
          name={pendingDelete}
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
          onClose={() => setDetailEmp(null)}
        />
      )}
      {bigBonusEmp && <BigBonusModal emp={bigBonusEmp} currentUser={user} onClose={() => setBigBonusEmp(null)} />}
      {adjustmentEmp && (
        <DailyPayAdjustmentModal
          emp={adjustmentEmp}
          initialDate={day ? `${month}-${day.slice(3)}` : weekStart || (month === todayParts().month ? `${month}-${todayParts().day.slice(3)}` : `${month}-01`)}
          onClose={() => setAdjustmentEmp(null)}
          onSaved={() => setSyncTick((value) => value + 1)}
        />
      )}
    </div>
  )
}
