import {
  BarChart3,
  CalendarDays,
  LayoutDashboard,
  Menu,
  Settings,
  ShoppingCart,
  Users,
} from 'lucide-react'
import { useI18n } from '../i18n'

export default function MobileBottomNav({ view, user, onNavigate, onMore }) {
  const { t } = useI18n()
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
      className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200/70 bg-white/[0.92] px-2 pt-1.5 shadow-[0_-4px_16px_rgba(15,15,25,0.06)] backdrop-blur-xl lg:hidden"
      style={{ paddingBottom: 'max(0.4rem, env(safe-area-inset-bottom))' }}
      aria-label={t('手机快捷导航')}
    >
      <div className="mx-auto grid max-w-lg grid-cols-5">
        {items.map((item) => {
          const Icon = item.icon
          const active = view === item.key
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onNavigate(item.key)}
              className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-2xl text-[10px] font-semibold transition active:scale-95 ${
                active ? 'text-budu-600' : 'text-slate-400'
              }`}
              aria-current={active ? 'page' : undefined}
            >
              {active && <span className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-budu-500" />}
              <Icon className={`h-5 w-5 ${active ? 'stroke-[2.4]' : ''}`} />
              <span>{t(item.label)}</span>
            </button>
          )
        })}
        <button
          type="button"
          onClick={onMore}
          className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-2xl text-[10px] font-semibold transition active:scale-95 ${
            quickKeys.has(view) ? 'text-slate-400' : 'text-budu-600'
          }`}
          aria-label={t('打开全部功能')}
        >
          {!quickKeys.has(view) && <span className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-budu-500" />}
          <Menu className="h-5 w-5" />
          <span>{t('更多')}</span>
        </button>
      </div>
    </nav>
  )
}
