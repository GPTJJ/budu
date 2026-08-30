import { useState } from 'react'
import { CalendarDays, CalendarRange, ChevronDown, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { HOLIDAYS_2026, WORKDAYS_2026 } from '../utils/payroll'
import { getWeekDays } from '../utils/schedule'
import { t } from '../utils/text'

function pad(n) {
  return String(n).padStart(2, '0')
}

function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 日历格是 MM-DD，统一转成完整日期 YYYY-MM-DD（兼容不带月份的 DD） */
function fullDateOf(monthKey, day) {
  const d = String(day || '')
  return d.includes('-') ? `${monthKey}-${d.slice(3)}` : `${monthKey}-${d}`
}

function fmtMonth(key) {
  const [y, m] = String(key).split('-')
  if (!m) return key
  return `${y}年${m}月`
}

/** 生成该月日历格子（MM-DD，周一开头，前面补空） */
function buildMonthCells(monthKey) {
  const [y, m] = monthKey.split('-').map(Number)
  const total = new Date(y, m, 0).getDate()
  const offset = (new Date(y, m - 1, 1).getDay() + 6) % 7
  const cells = []
  for (let i = 0; i < offset; i++) cells.push(null)
  for (let d = 1; d <= total; d++) cells.push(`${pad(m)}-${pad(d)}`)
  return cells
}

function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`)
  const diff = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - diff)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default function CalendarPicker({ month, day, weekStart, onSelect, onWeekSelect }) {
  const [open, setOpen] = useState(false)
  const [viewMonth, setViewMonth] = useState(month)
  const today = todayKey()
  const WEEK = ['一', '二', '三', '四', '五', '六', '日']

  const toggle = () => {
    if (!open) setViewMonth(month)
    setOpen((v) => !v)
  }

  const cells = buildMonthCells(viewMonth)
  const jumpToday = () => setViewMonth(today.slice(0, 7))
  const weekDays = weekStart ? getWeekDays(weekStart) : []
  const selectedWeek = new Set(weekDays.map((item) => item.date))
  const weekEnd = weekDays[6]?.date || ''

  return (
    <div className="relative block w-full min-w-0 md:w-auto md:shrink-0">
      <button
        onClick={toggle}
        className={`flex w-full min-w-0 items-center gap-2 rounded-2xl bg-white px-3.5 py-2.5 text-sm shadow-card transition hover:shadow-card-hover md:w-auto ${
          open ? 'ring-2 ring-budu-200' : ''
        }`}
      >
        <CalendarDays className={`h-4 w-4 ${day ? 'text-budu-500' : 'text-budu-500'}`} />
        <span className="min-w-0 flex-1 truncate text-left font-semibold text-slate-600 md:flex-none">
          {weekStart
            ? `${weekStart.slice(5)} ~ ${weekEnd.slice(5)}`
            : day
              ? `${fmtMonth(month)} · ${day}`
              : fmtMonth(month)}
        </span>
        {(day || weekStart) && (
          <span className="rounded-md bg-budu-50 px-1.5 py-0.5 text-[10px] font-bold text-budu-600">
            {t(weekStart ? '按周' : '按日')}
          </span>
        )}
        <ChevronDown className={`h-3.5 w-3.5 text-slate-300 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <div data-budu-overlay-ignore className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="fixed left-3 right-3 top-[calc(7rem+env(safe-area-inset-top))] z-40 mx-auto w-auto max-w-[340px] rounded-2xl bg-white p-4 shadow-lg ring-1 ring-slate-100 sm:absolute sm:left-0 sm:right-auto sm:top-full sm:mt-2 sm:w-[300px]">
            {/* 年月切换 + 今天 */}
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={() => setViewMonth(shiftMonth(viewMonth, -1))}
                className="grid h-8 w-8 place-items-center rounded-xl text-slate-400 transition hover:bg-budu-50 hover:text-budu-600"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <p className="text-sm font-bold text-slate-700">{fmtMonth(viewMonth)}</p>
              <button
                onClick={() => setViewMonth(shiftMonth(viewMonth, 1))}
                className="grid h-8 w-8 place-items-center rounded-xl text-slate-400 transition hover:bg-budu-50 hover:text-budu-600"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <button
                onClick={jumpToday}
                className="ml-1 rounded-xl bg-budu-50 px-2.5 py-1.5 text-xs font-semibold text-budu-600 transition hover:bg-budu-100"
              >
                {t('今天')}
              </button>
            </div>

            {/* 快速选择日期 */}
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-slate-300" />
              <input
                type="date"
                value={day && month === viewMonth ? `${viewMonth}-${day}` : ''}
                onChange={(e) => {
                  const v = e.target.value
                  if (v) {
                    onSelect(v.slice(0, 7), v.slice(5))
                    setOpen(false)
                  }
                }}
                className="w-full bg-transparent text-xs font-medium text-slate-600 outline-none"
                aria-label={t('快速选择日期')}
              />
            </div>

            {/* 星期头 */}
            <div className="mt-3 grid grid-cols-7 text-center text-[11px] font-semibold text-slate-400">
              {WEEK.map((w) => (
                <span key={w} className="py-1">
                  {w}
                </span>
              ))}
            </div>

            {/* 日期网格 */}
            <div className="mt-1 grid grid-cols-7 gap-y-0.5">
              {cells.map((d, i) => {
                if (!d) return <span key={`e${i}`} />
                const full = fullDateOf(viewMonth, d)
                const isToday = fullDateOf(viewMonth, d) === today
                const selected = day === d && month === viewMonth
                const inSelectedWeek = selectedWeek.has(full)
                const isHolidayDay = HOLIDAYS_2026.has(full)
                const isMakeupDay = WORKDAYS_2026.has(full)
                const dow = new Date(`${full}T00:00:00`).getDay()
                const isWeekendDay = !isHolidayDay && !isMakeupDay && (dow === 0 || dow === 6)
                return (
                  <button
                    key={d}
                    onClick={() => {
                      onSelect(viewMonth, d)
                      setOpen(false)
                    }}
                    className={`relative mx-auto grid h-9 w-9 place-items-center rounded-xl text-[13px] font-medium transition ${
                      selected
                        ? 'bg-budu-500 text-white shadow-sm/60'
                        : inSelectedWeek
                          ? 'bg-budu-100 text-budu-700 ring-1 ring-budu-200'
                        : isToday
                          ? 'text-budu-600 ring-2 ring-budu-200 hover:bg-budu-50'
                          : isMakeupDay
                            ? 'text-emerald-600 hover:bg-emerald-50'
                            : isHolidayDay || isWeekendDay
                              ? 'text-rose-500 hover:bg-rose-50'
                              : 'text-slate-600 hover:bg-budu-50 hover:text-budu-600'
                    }`}
                  >
                    {Number(d.slice(3))}
                    {isToday && !selected && <span className="absolute bottom-1 h-1 w-1 rounded-full bg-budu-400" />}
                    {isHolidayDay && (
                      <span className="absolute right-0.5 top-0 text-[8px] font-bold text-rose-400">假</span>
                    )}
                    {isMakeupDay && (
                      <span className="absolute right-0.5 top-0 text-[8px] font-bold text-emerald-500">班</span>
                    )}
                  </button>
                )
              })}
            </div>

            {/* 周末 / 法定节假日 / 调休上班图例 */}
            <div className="mt-2 flex items-center justify-center gap-4 text-[10px] font-medium text-slate-400">
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
                {t('周末 / 节假日')}
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {t('调休上班')}
              </span>
            </div>

            {/* 底部：整周 / 整月 */}
            <div className="mt-3 flex gap-1.5">
              {onWeekSelect && (
                <button
                  onClick={() => {
                    const base = weekStart && weekDays.some((item) => item.date.startsWith(viewMonth))
                      ? weekStart
                      : fullDateOf(
                          viewMonth,
                          day || (viewMonth === today.slice(0, 7) ? today.slice(8) : '01'),
                        )
                    onWeekSelect(mondayOf(base), viewMonth)
                    setOpen(false)
                  }}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-budu-100 bg-budu-50/60 px-3 py-2 text-xs font-semibold text-budu-600 transition hover:bg-budu-100"
                >
                  <CalendarRange className="h-3.5 w-3.5" />
                  {t('查看整周')}
                </button>
              )}
              <button
                onClick={() => {
                  onSelect(viewMonth, null)
                  setOpen(false)
                }}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-budu-100 bg-budu-50/60 px-3 py-2 text-xs font-semibold text-budu-600 transition hover:bg-budu-100"
              >
                <CalendarRange className="h-3.5 w-3.5" />
                {t('查看整月（{month}）', { month: fmtMonth(viewMonth) })}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
