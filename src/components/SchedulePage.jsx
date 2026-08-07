import { useState } from 'react'
import {
  ArrowLeft,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { allStores, employeeList } from '../utils/selectors'
import { getSchedules, commitSchedules } from '../utils/userData'
import { addWeeks, getWeekDays, getWeekStart, isoWeek, todayStr, weekRangeLabel } from '../utils/schedule'
import { useI18n } from '../i18n'

const inputCls =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-budu-400 focus:ring-2 focus:ring-budu-100'

export default function SchedulePage({ onBack, canEdit = true }) {
  const { t } = useI18n()
  const stores = allStores()
  const [weekStart, setWeekStart] = useState(() => getWeekStart())
  const [storeKey, setStoreKey] = useState(() => (stores[0] ? stores[0].key : ''))
  const [version, setVersion] = useState(0)
  const [editingDate, setEditingDate] = useState(null)
  const [draft, setDraft] = useState({ staff: '', time: '', note: '' })
  const [errorTip, setErrorTip] = useState('')
  const [savedTip, setSavedTip] = useState('')

  const schedules = getSchedules()
  const days = getWeekDays(weekStart)
  const weekData = (schedules[weekStart] || {})[storeKey] || {}
  const totalShifts = days.reduce((s, d) => s + (weekData[d.date] || []).length, 0)
  const today = todayStr()
  const storeInfo = stores.find((s) => s.key === storeKey)
  const staffNames = [...new Set(employeeList('all').map((e) => e.name))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN'),
  )

  const commit = (next) => {
    commitSchedules(next)
    setVersion((v) => v + 1)
  }

  const setWeekShifts = (date, shifts) => {
    const nextWeek = { ...(schedules[weekStart] || {}) }
    const nextStoreDays = { ...(nextWeek[storeKey] || {}) }
    if (shifts.length > 0) {
      nextStoreDays[date] = shifts
      nextWeek[storeKey] = nextStoreDays
    } else {
      delete nextStoreDays[date]
      if (Object.keys(nextStoreDays).length > 0) nextWeek[storeKey] = nextStoreDays
      else delete nextWeek[storeKey]
    }
    if (Object.keys(nextWeek).length === 0) {
      const next = { ...schedules }
      delete next[weekStart]
      commit(next)
    } else {
      commit({ ...schedules, [weekStart]: nextWeek })
    }
  }

  const openEditor = (date) => {
    setEditingDate(date)
    setDraft({ staff: '', time: '', note: '' })
    setErrorTip('')
  }

  const confirmAdd = () => {
    const staff = draft.staff.trim()
    if (!staff) {
      setErrorTip(t('请填写员工姓名'))
      return
    }
    const shifts = [
      ...(weekData[editingDate] || []),
      {
        staff,
        time: draft.time.trim(),
        note: draft.note.trim(),
      },
    ]
    setWeekShifts(editingDate, shifts)
    setEditingDate(null)
    setSavedTip(t('已保存 ✓'))
    setTimeout(() => setSavedTip(''), 2200)
  }

  const removeShift = (date, index) => {
    const shifts = (weekData[date] || []).filter((_, i) => i !== index)
    setWeekShifts(date, shifts)
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
          {t('返回首页')}
        </button>
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t('门店排班')}</h2>
          <p className="mt-0.5 text-[13px] text-slate-400">
            {t('按周为各个门店安排值班人员与班次，保存后所有登录账号实时同步')}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {savedTip && (
            <span className="flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-600">
              <Check className="h-3.5 w-3.5" />
              {savedTip}
            </span>
          )}
          <span className="rounded-lg bg-budu-50 px-2.5 py-1 text-xs font-semibold text-budu-600">
            {t('共 {n} 个班次', { n: totalShifts })}
          </span>
        </div>
      </div>

      {/* 周切换 + 门店选择 */}
      <div className="card flex flex-wrap items-center gap-3 p-4">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setWeekStart(addWeeks(weekStart, -1))}
            className="grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-500 transition hover:bg-budu-50 hover:text-budu-600"
            aria-label={t('上一周')}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => setWeekStart(getWeekStart())}
            className="rounded-xl bg-budu-50 px-3 py-2 text-xs font-semibold text-budu-600 transition hover:bg-budu-100"
          >
            {t('本周')}
          </button>
          <button
            onClick={() => setWeekStart(addWeeks(weekStart, 1))}
            className="grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-500 transition hover:bg-budu-50 hover:text-budu-600"
            aria-label={t('下一周')}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="min-w-0">
          <p className="text-sm font-bold text-slate-700">{weekRangeLabel(weekStart)}</p>
          <p className="text-[11px] font-medium text-slate-400">
            {t('第 {n} 周', { n: isoWeek(weekStart) })} · {storeInfo ? storeInfo.name : ''}
          </p>
        </div>

        <div className="ml-auto flex flex-wrap gap-1.5">
          {stores.map((s) => (
            <button
              key={s.key}
              onClick={() => setStoreKey(s.key)}
              className={`rounded-xl px-3 py-2 text-[13px] font-semibold transition ${
                s.key === storeKey
                  ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white shadow-lg shadow-budu-200/60'
                  : 'bg-slate-50 text-slate-500 hover:bg-budu-50 hover:text-budu-600'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>

      {/* 周排班表 */}
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
          <h3 className="flex items-center gap-2 text-[15px] font-bold text-slate-800">
            <CalendarClock className="h-4 w-4 text-budu-500" />
            {t('周排班表')}
          </h3>
          <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
            {weekRangeLabel(weekStart)} · {storeInfo ? storeInfo.name : ''}
          </span>
          {!canEdit && (
            <span className="ml-auto rounded-lg bg-slate-50 px-2 py-0.5 text-[11px] text-slate-400">
              {t('只读模式')}
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <div className="grid min-w-[980px] grid-cols-7 divide-x divide-slate-100">
            {days.map((d) => {
              const shifts = weekData[d.date] || []
              const isToday = d.date === today
              return (
                <div key={d.date} className={`flex min-h-[280px] flex-col ${isToday ? 'bg-budu-50/50' : ''}`}>
                  <div className={`border-b px-3 py-3 text-center ${isToday ? 'border-budu-100' : 'border-slate-100'}`}>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{t(d.label)}</p>
                    <p className={`mt-0.5 text-lg font-black ${isToday ? 'text-budu-600' : 'text-slate-700'}`}>{d.day}</p>
                    {shifts.length > 0 && (
                      <span className="mt-1 inline-block rounded-md bg-budu-100 px-1.5 py-0.5 text-[10px] font-bold text-budu-600">
                        {t('{n} 人', { n: shifts.length })}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-2 p-2.5">
                    {shifts.map((s, i) => (
                      <div key={i} className="rounded-xl bg-white p-2 shadow-sm ring-1 ring-slate-100">
                        <div className="flex items-start justify-between gap-1">
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-bold text-slate-700">{s.staff}</p>
                            {s.time && <p className="mt-0.5 text-[11px] font-semibold text-budu-500">{s.time}</p>}
                          </div>
                          {canEdit && (
                            <button
                              onClick={() => removeShift(d.date, i)}
                              className="shrink-0 rounded-lg p-1 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"
                              aria-label={t('删除')}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                        {s.note && <p className="mt-1 truncate text-[10px] text-slate-400">{s.note}</p>}
                      </div>
                    ))}
                    {shifts.length === 0 && (
                      <p className="grid flex-1 place-items-center pb-4 text-[11px] text-slate-300">{t('暂无排班')}</p>
                    )}
                    {canEdit && (
                      <button
                        onClick={() => openEditor(d.date)}
                        className="mt-auto flex items-center justify-center gap-1 rounded-xl border border-dashed border-budu-200 py-2 text-xs font-semibold text-budu-500 transition hover:bg-budu-50"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t('添加排班')}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <p className="text-center text-[11px] text-slate-300">
        {t('排班保存后自动同步到云端，所有登录账号实时可见；可与门店业绩录入中的值班人员互相参照')}
      </p>

      {/* 添加排班弹窗 */}
      {editingDate && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4 backdrop-blur-sm"
          onClick={() => setEditingDate(null)}
        >
          <div
            className="w-full max-w-md rounded-3xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-800">{t('添加员工排班')}</h3>
                <p className="mt-0.5 text-xs text-slate-400">
                  {weekRangeLabel(weekStart)} · {storeInfo ? storeInfo.name : ''} · {editingDate}
                </p>
              </div>
              <button
                onClick={() => setEditingDate(null)}
                className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-50 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <span className="mb-1.5 block text-xs font-semibold text-slate-500">{t('员工姓名')}</span>
                <input
                  list={`budu-schedule-staff-${storeKey}`}
                  value={draft.staff}
                  onChange={(e) => setDraft((s) => ({ ...s, staff: e.target.value }))}
                  placeholder={t('输入或选择员工姓名')}
                  className={inputCls}
                  autoFocus
                />
                <datalist id={`budu-schedule-staff-${storeKey}`}>
                  {staffNames.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
              </div>

              <div>
                <span className="mb-1.5 block text-xs font-semibold text-slate-500">{t('班次时间')}</span>
                <select
                  value={draft.time}
                  onChange={(e) => setDraft((s) => ({ ...s, time: e.target.value }))}
                  className={inputCls}
                >
                  <option value="">{t('选择班次')}</option>
                  <option value="早班">{t('早班')}</option>
                  <option value="晚班">{t('晚班')}</option>
                  <option value="通班">{t('通班')}</option>
                </select>
              </div>

              <div>
                <span className="mb-1.5 block text-xs font-semibold text-slate-500">{t('备注')}</span>
                <input
                  value={draft.note}
                  onChange={(e) => setDraft((s) => ({ ...s, note: e.target.value }))}
                  placeholder={t('选填，例如 主理/备货')}
                  className={inputCls}
                />
              </div>

              {errorTip && <p className="text-xs font-medium text-rose-500">{errorTip}</p>}
            </div>

            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setEditingDate(null)}
                className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-200"
              >
                {t('取消')}
              </button>
              <button
                onClick={confirmAdd}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-budu-500 to-grape-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-budu-200/60 transition hover:opacity-90"
              >
                <Check className="h-4 w-4" />
                {t('确认添加')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
