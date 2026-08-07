import { useEffect, useState } from 'react'
import { ArrowLeft, CalendarDays, Download, Plus, Trash2, X } from 'lucide-react'
import CalendarPicker from './CalendarPicker'
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
import { formatMoney } from '../utils/format'
import { useI18n } from '../i18n'
import { usePublicMode, useStorePrivacy } from '../visibility'

const AVATAR_GRADIENTS = [
  'from-budu-400 to-rose-400',
  'from-grape-400 to-indigo-400',
  'from-amber-400 to-orange-400',
  'from-emerald-400 to-teal-400',
  'from-sky-400 to-cyan-400',
  'from-violet-400 to-purple-500',
  'from-rose-400 to-pink-500',
]

function todayParts() {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return { month: `${d.getFullYear()}-${mm}`, day: `${mm}-${dd}` }
}

function Stat({ label, value, accent }) {
  return (
    <div className="rounded-xl bg-slate-50/80 px-3 py-2">
      <p className="text-[10px] text-slate-400">{label}</p>
      <p className={`mt-0.5 text-sm font-bold tabular-nums ${accent || 'text-slate-700'}`}>{value}</p>
    </div>
  )
}

const inputCls =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-budu-400 focus:ring-2 focus:ring-budu-100'

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
      <div className="relative w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
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
                    ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white shadow-md'
                    : 'bg-slate-50 text-slate-500 hover:bg-budu-50 hover:text-budu-600'
                }`}
              >
                {t('全职雇员')}
              </button>
              <button
                onClick={() => setType('parttime')}
                className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
                  type === 'parttime'
                    ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white shadow-md'
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
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-budu-500 to-grape-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-budu-200/60 transition hover:opacity-90"
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
      <div className="relative w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl">
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

function DailyPayModal({ emp, month, hidePersonal, onClose }) {
  const { t } = useI18n()
  const [y, m] = String(month).split('-').map(Number)
  const daysInMonth = new Date(y, m, 0).getDate()
  const dayRows = []
  for (let d = 1; d <= daysInMonth; d += 1) {
    const dd = `${String(d).padStart(2, '0')}`
    const detail = employeeDailyPayDetail(month, `${String(m).padStart(2, '0')}-${dd}`, emp.name)
    dayRows.push({
      day: dd,
      revenue: detail ? detail.totals.inc : 0,
      orders: detail ? detail.totals.ord : 0,
      hours: detail ? detail.totals.hours : 0,
      basePay: detail ? detail.totals.basePay : 0,
      commission: detail ? detail.totals.commission : 0,
      pay: detail ? detail.totals.pay : 0,
      hasData: Boolean(detail),
      stores: detail ? detail.rows.map((r) => r.storeName).join('、') : '',
    })
  }
  const totals = dayRows.reduce(
    (s, r) => ({
      revenue: s.revenue + r.revenue,
      orders: s.orders + r.orders,
      hours: s.hours + r.hours,
      basePay: s.basePay + r.basePay,
      commission: s.commission + r.commission,
      pay: s.pay + r.pay,
    }),
    { revenue: 0, orders: 0, hours: 0, basePay: 0, commission: 0, pay: 0 },
  )

  const download = () => {
    const lines = [
      'BUDU 员工工资明细',
      `员工：${emp.name}`,
      `月份：${month}`,
      '',
      '日期\t营业额(元)\t订单\t工时(h)\t基础工资(元)\t提成(元)\t当日工资(元)',
      ...dayRows.map((r) =>
        [r.day, r.revenue.toFixed(2), r.orders, r.hours, r.basePay.toFixed(2), r.commission.toFixed(2), r.pay.toFixed(2)].join('\t'),
      ),
      '',
      ['合计', totals.revenue.toFixed(2), totals.orders, totals.hours, totals.basePay.toFixed(2), totals.commission.toFixed(2), totals.pay.toFixed(2)].join('\t'),
      '',
      '说明：基础工资=基础时薪×工时；提成=提成时薪×工时；1人值班按门店标准工时，2人及以上各8h；节假日/调休按2026年规则计算；未录入日期计 0。',
    ]
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `工资明细-${emp.name}-${month}.txt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h3 className="text-lg font-bold text-slate-800">{emp.name} · {t('当月每日工资明细')}</h3>
            <p className="mt-0.5 text-xs text-slate-400">{t('{month} · 按日期正序排列', { month })}</p>
          </div>
          <button onClick={onClose} className="ml-auto grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400">
            <X className="h-5 w-5" />
          </button>
        </div>

        {hidePersonal ? (
          <p className="grid place-items-center py-16 text-sm text-slate-300">{t('工资详情仅开发者/店长可见')}</p>
        ) : (
          <>
            <div className="mt-4 max-h-[52vh] overflow-y-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="py-2 pr-2">{t('日期')}</th>
                    <th className="py-2 pr-2 text-right">{t('营业额')}</th>
                    <th className="py-2 pr-2 text-right">{t('订单')}</th>
                    <th className="py-2 pr-2 text-right">{t('工时')}</th>
                    <th className="py-2 pr-2 text-right">{t('基础工资')}</th>
                    <th className="py-2 pr-2 text-right">{t('提成')}</th>
                    <th className="py-2 pr-2 text-right">{t('当日工资')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {dayRows.map((r) => (
                    <tr key={r.day} className={r.hasData ? '' : 'text-slate-300'}>
                      <td className="py-1.5 pr-2 font-semibold text-slate-700">
                        {r.day}
                        {r.stores && <span className="ml-1 text-[10px] font-normal text-slate-400">({r.stores})</span>}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{r.hasData ? `¥${r.revenue.toFixed(2)}` : '—'}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{r.hasData ? r.orders : '—'}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{r.hasData ? `${r.hours}h` : '—'}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{r.hasData ? `¥${r.basePay.toFixed(2)}` : '—'}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{r.hasData ? `¥${r.commission.toFixed(2)}` : '—'}</td>
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
                    <td className="py-2 pr-2 text-right tabular-nums text-budu-600">¥{totals.pay.toFixed(2)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <button
              onClick={download}
              className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-budu-500 to-grape-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-budu-200/60 transition hover:opacity-90"
            >
              <Download className="h-4 w-4" />
              {t('下载文档')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default function PersonnelPage({ type, onTypeChange, onBack, canDelete = false, canManage = false, user }) {
  const { t } = useI18n()
  const isPublic = usePublicMode()
  const isStore = useStorePrivacy()
  const hidePersonal = isPublic || isStore
  const [month, setMonth] = useState(() => todayParts().month)
  const [day, setDay] = useState(null)
  const [weekStart, setWeekStart] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [detailEmp, setDetailEmp] = useState(null)
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
  const list = type === 'fulltime' ? fulltime : parttime
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
              className="flex items-center gap-1.5 rounded-2xl bg-gradient-to-r from-budu-500 to-grape-500 px-3.5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-budu-200/60 transition hover:opacity-90"
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
      <div className="inline-flex rounded-2xl bg-white p-1.5 shadow-card">
        <button
          onClick={() => onTypeChange('fulltime')}
          className={`rounded-xl px-5 py-2 text-sm font-semibold transition-all ${
            type === 'fulltime'
              ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white shadow-md'
              : 'text-slate-500 hover:text-budu-600'
          }`}
        >
          {t('全职雇员')}（{fulltime.length}）
        </button>
        <button
          onClick={() => onTypeChange('parttime')}
          className={`rounded-xl px-5 py-2 text-sm font-semibold transition-all ${
            type === 'parttime'
              ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white shadow-md'
              : 'text-slate-500 hover:text-budu-600'
          }`}
        >
          {t('兼职人员')}（{parttime.length}）
        </button>
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
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
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
              const periodRevenue = onDuty ? status.inc : 0
              const periodStores = onDuty && status.stores ? status.stores.length : 0
              const periodText = weekStart
                ? `${Number(weekStart.slice(5, 7))}.${Number(weekStart.slice(8, 10))} - ${Number(weekDays[6].date.slice(5, 7))}.${Number(weekDays[6].date.slice(8, 10))}`
                : day
                  ? `${Number(day.slice(0, 2))}.${Number(day.slice(3, 5))}`
                  : monthLabel(month)
              return (
                <div
                  key={emp.name}
                  onClick={() => setDetailEmp(emp)}
                  className="card relative cursor-pointer p-5 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-card-hover"
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
                      className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br text-base font-bold text-white shadow-md ${
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
                              ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white'
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
                        {emp.storeName} · {t('出勤 {days} 天', { days: emp.workedDays })}
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
                      label={weekStart ? t('周工时') : day ? t('当日工时') : t('工时')}
                      value={hidePersonal ? '•••' : `${Math.round(weekStart || day ? periodHours : emp.hours)}h`}
                    />
                    <Stat
                      label={weekStart ? t('周提成') : day ? t('当日提成') : t('业绩提成')}
                      value={hidePersonal ? '•••' : `¥${formatMoney(weekStart || day ? periodPerf : emp.perf + emp.big)}`}
                      accent="text-grape-600"
                    />
                    <Stat
                      label={weekStart ? t('周营业额') : day ? t('当日营业额') : t('当班营业额')}
                      value={isPublic ? '•••' : `¥${formatMoney(weekStart || day ? periodRevenue : emp.workedRevenue)}`}
                    />
                  </div>

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
      {pendingDelete && (
        <ConfirmDeleteModal
          name={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onConfirm={() => {
            handleDeleteStaff(pendingDelete)
            setPendingDelete(null)
          }}
        />
      )}
      {detailEmp && (
        <DailyPayModal
          emp={detailEmp}
          month={month}
          hidePersonal={hidePersonal}
          onClose={() => setDetailEmp(null)}
        />
      )}
    </div>
  )
}
