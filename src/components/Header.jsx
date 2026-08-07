import { useEffect, useState } from 'react'
import { MapPin, Bell, Menu, ChevronDown, RefreshCw } from 'lucide-react'
import { allStores } from '../utils/selectors'
import CalendarPicker from './CalendarPicker'
import { useI18n } from '../i18n'

export default function Header({
  month,
  store,
  day,
  title,
  showOverviewTools = false,
  onDaySelect,
  onMonthChange,
  onStoreChange,
  onMenuClick,
  user,
}) {
  const { t } = useI18n()
  const name = user?.username || t('伙伴')
  const [hour, setHour] = useState(() => new Date().getHours())

  useEffect(() => {
    const id = setInterval(() => setHour(new Date().getHours()), 60 * 1000)
    return () => clearInterval(id)
  }, [])

  const greetingKey =
    hour >= 5 && hour < 12
      ? '早上好，{name} 👋'
      : hour >= 12 && hour < 14
        ? '中午好，{name} 👋'
        : hour >= 14 && hour < 18
          ? '下午好，{name} 👋'
          : '晚上好，{name} 👋'

  return (
    <header
      className="sticky top-0 z-20 border-b border-white/60 bg-[#F7F4FA]/88 backdrop-blur-xl"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 sm:gap-3 sm:px-5 sm:py-4 lg:px-8">
        {/* 问候语 */}
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          <button
            onClick={onMenuClick}
            className="hidden h-10 w-10 shrink-0 place-items-center rounded-2xl bg-white text-slate-500 shadow-card sm:grid lg:hidden"
            aria-label={t('打开菜单')}
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-[17px] font-bold text-slate-800 sm:text-lg lg:text-xl">
              {title ? t(title) : t(greetingKey, { name })}
            </h1>
            {!title && (
              <p className="mt-0.5 hidden truncate text-[13px] text-slate-400 sm:block">
                {t('欢迎回来，今天也要元气满满地经营每一家门店！')}
              </p>
            )}
          </div>
        </div>

        {/* 刷新页面（移动端，消息铃铛左侧） */}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-white text-slate-500 shadow-card transition active:scale-95 md:hidden"
          aria-label={t('刷新页面')}
        >
          <RefreshCw className="h-[18px] w-[18px]" />
        </button>

        <button
          type="button"
          className="relative grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-white text-slate-500 shadow-card transition active:scale-95 md:hidden"
          aria-label={t('查看通知')}
        >
          <Bell className="h-[18px] w-[18px]" />
          <span className="absolute right-2 top-2 h-2 w-2 rounded-full border-2 border-white bg-rose-500" />
        </button>

        {/* 右侧工具栏 */}
        <div className="no-scrollbar order-3 flex w-full shrink-0 flex-nowrap items-center gap-2 overflow-x-auto pb-0.5 sm:gap-3 md:order-none md:w-auto md:overflow-visible md:pb-0">
          {showOverviewTools && (
            <>
              {/* 日历选择（月 / 日双模式） */}
              <CalendarPicker month={month} day={day} onSelect={onDaySelect} />

              {/* 门店选择 */}
              <label className="flex shrink-0 items-center gap-2 rounded-2xl bg-white px-3.5 py-2.5 text-sm shadow-card transition hover:shadow-card-hover">
                <MapPin className="h-4 w-4 text-grape-500" />
                <select
                  value={store}
                  onChange={(e) => onStoreChange(e.target.value)}
                  className="max-w-[120px] cursor-pointer appearance-none bg-transparent pr-1 text-sm font-semibold text-slate-600 outline-none sm:max-w-[160px]"
                >
                  <option value="all">{t('全部门店')}</option>
                  {allStores().map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="h-3.5 w-3.5 text-slate-300" />
              </label>
            </>
          )}

          {/* 刷新页面（桌面端，消息铃铛左侧） */}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="hidden h-11 w-11 shrink-0 place-items-center rounded-2xl bg-white text-slate-500 shadow-card transition hover:shadow-card-hover hover:text-budu-500 md:grid"
            aria-label={t('刷新页面')}
          >
            <RefreshCw className="h-[18px] w-[18px]" />
          </button>

          {/* 消息通知 */}
          <button
            type="button"
            className="relative ml-auto hidden h-11 w-11 shrink-0 place-items-center rounded-2xl bg-white text-slate-500 shadow-card transition hover:shadow-card-hover hover:text-budu-500 md:ml-0 md:grid"
            aria-label={t('查看通知')}
          >
            <Bell className="h-[18px] w-[18px]" />
            <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full border-2 border-white bg-rose-500" />
          </button>

        </div>
      </div>
    </header>
  )
}
