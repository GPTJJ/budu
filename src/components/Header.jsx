import { useEffect, useState } from 'react'
import { ArrowLeft, MapPin, Menu, ChevronDown, Eye, EyeOff, RefreshCw } from 'lucide-react'
import { allStores } from '../utils/selectors'
import CalendarPicker from './CalendarPicker'
import NotificationBell from './NotificationBell'
import { t } from '../utils/text'
import { usePrivacyMode } from '../visibility'

function PrivacyToggleButton({ variant = 'mobile' }) {
  const { effectivePrivacy, isLockedByRole, autoLockRemainingSec, togglePrivacyMode } = usePrivacyMode()
  const label = isLockedByRole
    ? t('当前账号固定开启防窥保护')
    : effectivePrivacy
      ? t('防窥已开启，点击显示金额（Shift+H）')
      : t('明文显示中，点击开启防窥（Shift+H）')

  const sizeClass = variant === 'desktop' ? 'hidden h-11 min-w-11 px-2.5 md:inline-flex' : 'inline-flex h-10 min-w-10 px-2 md:hidden'

  return (
    <button
      type="button"
      data-testid={`privacy-toggle-${variant}`}
      onClick={() => {
        if (!isLockedByRole) togglePrivacyMode()
      }}
      disabled={isLockedByRole}
      aria-pressed={!effectivePrivacy}
      aria-label={label}
      title={label}
      className={`${sizeClass} shrink-0 items-center justify-center gap-1 rounded-lg border shadow-sm transition ${
        isLockedByRole
          ? 'cursor-not-allowed border-slate-200/70 bg-slate-50 text-slate-300'
          : effectivePrivacy
            ? 'border-slate-200/70 bg-white/80 text-slate-500 hover:border-budu-300 hover:text-budu-500'
            : 'border-budu-200 bg-budu-50 text-budu-600 hover:border-budu-300 hover:bg-budu-100/70'
      }`}
    >
      {effectivePrivacy ? <EyeOff className="h-4 w-4 shrink-0" /> : <Eye className="h-4 w-4 shrink-0" />}
      {!effectivePrivacy && autoLockRemainingSec > 0 && (
        <span className="text-[10px] font-bold tabular-nums leading-none text-budu-600">
          {autoLockRemainingSec}s
        </span>
      )}
    </button>
  )
}

export default function Header({
  month,
  store,
  day,
  weekStart,
  title,
  showOverviewTools = false,
  onDaySelect,
  onMonthChange,
  onWeekSelect,
  onStoreChange,
  onMenuClick,
  onBack,
  onNavigate,
  onRefresh,
  user,
}) {
  const name = user?.username || t('伙伴')
  const visibleStores =
    user?.role === 'developer' || user?.role === 'public' || user?.role === 'finance' || user?.role === 'admin'
      ? allStores()
      : allStores().filter((s) => (user.storeKeys || []).includes(s.key))
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
      className="sticky top-0 z-20 border-b border-slate-200/70 bg-canvas/88 backdrop-blur-xl"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 sm:gap-3 sm:px-5 sm:py-4 lg:px-8">
        {/* 问候语 */}
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          {onBack ? (
            <button
              onClick={onBack}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-budu-600 transition hover:bg-white/80 lg:hidden"
              aria-label={t('返回首页')}
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          ) : (
            <button
              onClick={onMenuClick}
              className="hidden h-10 w-10 shrink-0 place-items-center rounded-lg border border-slate-200/70 bg-white/80 text-slate-500 shadow-sm sm:grid lg:hidden"
              aria-label={t('打开菜单')}
            >
              <Menu className="h-5 w-5" />
            </button>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-[17px] font-semibold text-slate-900 sm:text-lg lg:text-xl">
              {title ? t(title) : t(greetingKey, { name })}
            </h1>
            {!title && (
              <p className="mt-0.5 hidden truncate text-[13px] text-slate-400 sm:block">
                {t('欢迎回来，今天也要元气满满地经营每一家门店！')}
              </p>
            )}
          </div>
        </div>

        <PrivacyToggleButton variant="mobile" />

        <button
          onClick={onRefresh}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-slate-200/70 bg-white/80 text-slate-500 shadow-sm transition hover:border-budu-300 hover:text-budu-500 md:hidden"
          aria-label={t('刷新当前界面')}
          title={t('刷新当前界面')}
        >
          <RefreshCw className="h-4 w-4" />
        </button>

        <NotificationBell variant="mobile" user={user} onNavigate={onNavigate} />

        {/* 右侧工具栏 */}
        <div
          data-testid="overview-toolbar"
          className={`order-3 w-full shrink-0 items-center gap-2 pb-0.5 sm:gap-3 md:order-none md:flex md:w-auto md:flex-nowrap md:overflow-visible md:pb-0 ${
            showOverviewTools ? 'grid grid-cols-1 sm:grid-cols-2' : 'hidden'
          }`}
        >
          {showOverviewTools && (
            <>
              {/* 日历选择（月 / 日双模式） */}
              <CalendarPicker
                month={month}
                day={day}
                weekStart={weekStart}
                onSelect={onDaySelect}
                onWeekSelect={onWeekSelect}
              />

              {/* 门店选择 */}
              <label data-testid="overview-store-picker" className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-slate-200/70 bg-white/80 px-3 py-2 text-sm shadow-sm transition hover:border-slate-300 md:w-auto md:shrink-0">
                <MapPin className="h-4 w-4 text-budu-500" />
                <select
                  value={store}
                  onChange={(e) => onStoreChange(e.target.value)}
                  className="min-w-0 flex-1 cursor-pointer appearance-none bg-transparent pr-1 text-sm font-semibold text-slate-600 outline-none md:max-w-[160px]"
                >
                  {(user?.role === 'developer' || user?.role === 'public' || user?.role === 'finance' || user?.role === 'admin') && (
                    <option value="all">{t('全部门店')}</option>
                  )}
                  {visibleStores.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="h-3.5 w-3.5 text-slate-300" />
              </label>
            </>
          )}

          <PrivacyToggleButton variant="desktop" />

          <button
            onClick={onRefresh}
            className="hidden h-11 w-11 shrink-0 place-items-center rounded-lg border border-slate-200/70 bg-white/80 text-slate-500 shadow-sm transition hover:border-budu-300 hover:text-budu-500 md:grid"
            aria-label={t('刷新当前界面')}
            title={t('刷新当前界面')}
          >
            <RefreshCw className="h-4 w-4" />
          </button>

          <NotificationBell variant="desktop" user={user} onNavigate={onNavigate} />

        </div>
      </div>
    </header>
  )
}
