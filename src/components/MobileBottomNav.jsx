import {
  BarChart3,
  CalendarDays,
  LayoutDashboard,
  Menu,
  Settings,
  ShoppingCart,
  Users,
} from 'lucide-react'
import { t } from '../utils/text'

export default function MobileBottomNav({ view, user, onNavigate, onMore }) {
  const isPublic = user?.role === 'public'
  const items = isPublic
    ? [
        { key: 'overview', label: '首页', icon: LayoutDashboard },
        { key: 'staff', label: '雇员', icon: Users },
        { key: 'settings', label: '设置', icon: Settings },
      ]
    : [
        { key: 'overview', label: '首页', icon: LayoutDashboard },
        { key: 'store-entry', label: '录入', icon: BarChart3 },
        { key: 'store-schedule', label: '排班', icon: CalendarDays },
        { key: 'store-pos', label: 'POS点单', icon: ShoppingCart },
      ]

  const quickKeys = new Set(items.map((item) => item.key))

  return (
    <nav
      className="mobile-liquid-nav fixed inset-x-0 bottom-0 z-30 px-2 lg:hidden"
      style={{ paddingBottom: 'max(0.45rem, env(safe-area-inset-bottom))' }}
      aria-label={t('手机快捷导航')}
    >
      <div className="mobile-liquid-nav__glass relative mx-auto grid max-w-lg grid-cols-5 overflow-hidden rounded-[1.65rem] px-1 py-1">
        {items.map((item) => {
          const Icon = item.icon
          const active = view === item.key
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onNavigate(item.key)}
              className={`mobile-liquid-nav__item relative flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-[1.2rem] text-[10px] font-semibold transition active:scale-95 ${
                active ? 'text-budu-700' : 'text-slate-500'
              }`}
              aria-current={active ? 'page' : undefined}
            >
              {active && <span className="mobile-liquid-nav__selection absolute inset-0" aria-hidden="true" />}
              <Icon className={`relative z-[1] h-5 w-5 ${active ? 'stroke-[2.4]' : ''}`} />
              <span className="relative z-[1]">{t(item.label)}</span>
            </button>
          )
        })}
        <button
          type="button"
          onClick={onMore}
          className={`mobile-liquid-nav__item relative flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-[1.2rem] text-[10px] font-semibold transition active:scale-95 ${
            quickKeys.has(view) ? 'text-slate-500' : 'text-budu-700'
          }`}
          aria-label={t('打开全部功能')}
        >
          {!quickKeys.has(view) && <span className="mobile-liquid-nav__selection absolute inset-0" aria-hidden="true" />}
          <Menu className="relative z-[1] h-5 w-5" />
          <span className="relative z-[1]">{t('更多')}</span>
        </button>
      </div>
    </nav>
  )
}
