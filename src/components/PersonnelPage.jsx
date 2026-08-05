import { useEffect, useState } from 'react'
import { ArrowLeft, CalendarDays, Plus, Trash2, X } from 'lucide-react'
import CalendarPicker from './CalendarPicker'
import {
  employeesByType,
  employeeList,
  EMPLOYEE_MONTHS,
  monthLabel,
  employeeDayStatus,
  hasLocalEntry,
  localStaffList,
  saveLocalStaffList,
  STORES,
} from '../utils/selectors'
import { formatMoney } from '../utils/format'

const AVATAR_GRADIENTS = [
  'from-budu-400 to-rose-400',
  'from-grape-400 to-indigo-400',
  'from-amber-400 to-orange-400',
  'from-emerald-400 to-teal-400',
  'from-sky-400 to-cyan-400',
  'from-violet-400 to-purple-500',
  'from-rose-400 to-pink-500',
]

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
  const [name, setName] = useState('')
  const [type, setType] = useState('parttime')
  const [storeKey, setStoreKey] = useState(STORES[0].key)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const storeName = storeKey === 'multi' ? '多店支援' : (STORES.find((s) => s.key === storeKey) || {}).name || storeKey

  const handleSave = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('请输入员工姓名')
      return
    }
    if (employeeList('all').some((e) => e.name === trimmed)) {
      setError('该员工已存在，请勿重复添加')
      return
    }
    onSave({
      name: trimmed,
      type,
      storeKey,
      storeName,
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
            <h3 className="text-lg font-bold text-slate-800">添加员工</h3>
            <p className="mt-1 text-xs text-slate-400">新员工将保存到本地，并同步到值班选择等关联模块</p>
          </div>
          <button
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label="关闭"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-500">员工姓名</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="请输入姓名"
              className={inputCls}
              autoFocus
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-500">人员类型</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setType('fulltime')}
                className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
                  type === 'fulltime'
                    ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white shadow-md'
                    : 'bg-slate-50 text-slate-500 hover:bg-budu-50 hover:text-budu-600'
                }`}
              >
                全职雇员
              </button>
              <button
                onClick={() => setType('parttime')}
                className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
                  type === 'parttime'
                    ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white shadow-md'
                    : 'bg-slate-50 text-slate-500 hover:bg-budu-50 hover:text-budu-600'
                }`}
              >
                兼职人员
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-500">所属门店</label>
            <select value={storeKey} onChange={(e) => setStoreKey(e.target.value)} className={inputCls}>
              {STORES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
              <option value="multi">多店支援</option>
            </select>
          </div>

          {error && <p className="text-xs font-medium text-rose-500">{error}</p>}

          <button
            onClick={handleSave}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-budu-500 to-grape-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-budu-200/60 transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            确认添加
          </button>
        </div>
      </div>
    </div>
  )
}

export default function PersonnelPage({ type, onTypeChange, onBack }) {
  const [month, setMonth] = useState('2026-07') // 薪资主月
  const [day, setDay] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [staffVersion, setStaffVersion] = useState(0)

  const localStaff = localStaffList()
  const hasData = EMPLOYEE_MONTHS.includes(month) || localStaff.length > 0
  const dayHasData = day ? hasLocalEntry(month, day) : false

  const all = hasData ? employeeList('all', month) : []
  const fulltime = all.filter((e) => e.type === 'fulltime')
  const parttime = all.filter((e) => e.type === 'parttime')
  const list = type === 'fulltime' ? fulltime : parttime

  const handleAddStaff = (emp) => {
    saveLocalStaffList([...localStaffList(), emp])
    setStaffVersion((v) => v + 1)
    setShowAdd(false)
  }

  const handleDeleteStaff = (name) => {
    saveLocalStaffList(localStaffList().filter((e) => e.name !== name))
    setStaffVersion((v) => v + 1)
  }

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-2xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-500 shadow-card transition hover:text-budu-600"
        >
          <ArrowLeft className="h-4 w-4" />
          返回首页
        </button>
        <div>
          <h2 className="text-xl font-bold text-slate-800">人员管理</h2>
          <p className="mt-0.5 text-[13px] text-slate-400">
            薪资表 2026.27-31 周 · 按所选月份显示 · 全职 {fulltime.length} 人 / 兼职 {parttime.length} 人
            {day ? ` · 当日值班查询中` : ''}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 rounded-2xl bg-gradient-to-r from-budu-500 to-grape-500 px-3.5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-budu-200/60 transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            添加员工
          </button>
          <CalendarPicker
            month={month}
            day={day}
            onSelect={(m, d) => {
              setMonth(m)
              setDay(d)
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
          全职雇员（{fulltime.length}）
        </button>
        <button
          onClick={() => onTypeChange('parttime')}
          className={`rounded-xl px-5 py-2 text-sm font-semibold transition-all ${
            type === 'parttime'
              ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white shadow-md'
              : 'text-slate-500 hover:text-budu-600'
          }`}
        >
          兼职人员（{parttime.length}）
        </button>
      </div>

      {day && !dayHasData && (
        <div className="rounded-2xl border border-amber-100 bg-amber-50/70 px-4 py-3 text-xs font-medium text-amber-600">
          所选日期 {month.slice(5)}-{day} 暂无业绩录入，请先在「门店经营 → 门店业绩录入」登记当日值班人员与业绩
        </div>
      )}

      {hasData ? (
        <>
          {/* 员工卡片 */}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {list.map((emp, i) => {
              const status = day ? employeeDayStatus(month, day, emp.name) : null
              const onDuty = Boolean(day && status)
              const workDays = Math.max(emp.workedDays || 0, 1)
              const daySalary = onDuty ? emp.salary / workDays : 0
              const dayHours = onDuty ? emp.hours / workDays : 0
              const dayPerf = onDuty ? (emp.perf + emp.big) / workDays : 0
              return (
                <div key={emp.name} className="card relative p-5 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-card-hover">
                  {emp.local && (
                    <button
                      onClick={() => handleDeleteStaff(emp.name)}
                      className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-lg text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"
                      title="删除该员工"
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
                          {emp.type === 'fulltime' ? '全职' : '兼职'}
                        </span>
                        {emp.local && (
                          <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-600">
                            本地
                          </span>
                        )}
                        {day && status && (
                          <span className="flex items-center gap-1 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                            值班
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-slate-400">
                        {emp.storeName} · 出勤 {emp.workedDays} 天
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <Stat
                      label={day ? '当日工资' : '工资合计'}
                      value={`¥${formatMoney(day ? daySalary : emp.salary)}`}
                      accent="text-budu-600"
                    />
                    <Stat label={day ? '当日工时' : '工时'} value={`${Math.round(day ? dayHours : emp.hours)}h`} />
                    <Stat
                      label={day ? '当日提成' : '业绩提成'}
                      value={`¥${formatMoney(day ? dayPerf : emp.perf + emp.big)}`}
                      accent="text-grape-600"
                    />
                    <Stat
                      label={day ? '当日营业额' : '当班营业额'}
                      value={`¥${formatMoney(day ? (status ? status.inc : 0) : emp.workedRevenue)}`}
                    />
                  </div>

                  {day ? (
                    <div className="mt-3 flex items-center justify-between rounded-xl bg-slate-50/80 px-3 py-2">
                      {status ? (
                        <>
                          <span className="text-xs font-semibold text-slate-500">
                            当日值班 · {status.stores.length} 家店
                          </span>
                          <span className="text-xs font-bold tabular-nums text-emerald-600">
                            ¥{formatMoney(status.inc)} · {Math.round(status.ord)} 单
                          </span>
                        </>
                      ) : dayHasData ? (
                        <span className="text-xs font-medium text-slate-400">当日休息</span>
                      ) : (
                        <span className="text-xs text-slate-300">当日无业绩录入</span>
                      )}
                    </div>
                  ) : (
                    <div className="mt-3 flex items-center justify-between">
                      <span className="text-[11px] text-slate-300">ROI = 当班营业额 / 工资</span>
                      <span
                        className={`rounded-lg px-2 py-0.5 text-xs font-bold ${
                          emp.roi >= 8 ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
                        }`}
                      >
                        ROI {emp.roi.toFixed(2)}x
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {list.length === 0 && (
            <div className="card grid place-items-center py-16 text-sm text-slate-300">
              暂无该类人员数据，点击右上角「添加员工」新建
            </div>
          )}
        </>
      ) : (
        /* 无薪资数据月份的空态 */
        <div className="card grid place-items-center py-20 text-center">
          <CalendarDays className="h-9 w-9 text-slate-200" />
          <p className="mt-3 text-sm font-semibold text-slate-400">{monthLabel(month)}暂无薪资数据</p>
          <p className="mt-1.5 text-xs text-slate-300">
            当前薪资表覆盖 2026.27-31 周（6 月 ~ 8 月），可切换日历月份或添加本地员工
          </p>
        </div>
      )}

      {showAdd && <AddStaffModal onClose={() => setShowAdd(false)} onSave={handleAddStaff} />}
    </div>
  )
}