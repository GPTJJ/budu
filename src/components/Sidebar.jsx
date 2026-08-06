import { useState } from 'react'
import {
  LayoutDashboard,
  Store,
  Users,
  Package,
  Warehouse,
  Wallet,
  Heart,
  BarChart3,
  Settings,
  CupSoda,
  LogOut,
  ChevronDown,
} from 'lucide-react'
import { useI18n } from '../i18n'

const menus = [
  { key: 'overview', label: '首页概览', icon: LayoutDashboard },
  { key: 'staff', label: '人员管理', icon: Users },
  { key: 'store', label: '门店经营', icon: Store },
  { key: 'product', label: '商品管理', icon: Package },
  { key: 'inventory', label: '库存采购', icon: Warehouse },
  { key: 'finance', label: '财务利润', icon: Wallet },
  { key: 'member', label: '会员营销', icon: Heart },
  { key: 'analytics', label: '数据分析', icon: BarChart3 },
  { key: 'settings', label: '系统设置', icon: Settings },
]

const subMenus = {
  staff: [
    { key: 'staff-fulltime', label: '全职雇员' },
    { key: 'staff-parttime', label: '兼职人员' },
  ],
  store: [{ key: 'store-entry', label: '门店业绩录入' }],
}

export default function Sidebar({ open, onClose, view, onNavigate }) {
  const { t } = useI18n()
  const [expandedKeys, setExpandedKeys] = useState({})

  const toggleExpand = (key) =>
    setExpandedKeys((s) => ({ ...s, [key]: !s[key] }))

  const isSubmenuOpen = (key) => expandedKeys[key] || (view && view.startsWith(`${key}-`))

  const handleNavigate = (key) => {
    onNavigate(key)
    onClose()
  }

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col bg-white/90 backdrop-blur transition-transform duration-300 lg:sticky lg:top-0 lg:z-30 lg:h-screen lg:translate-x-0 lg:bg-white ${
        open ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-6 pb-6 pt-7">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-budu-400 to-grape-500 text-white shadow-lg shadow-budu-200">
          <CupSoda className="h-6 w-6" />
        </div>
        <div>
          <p className="bg-gradient-to-r from-budu-500 to-grape-500 bg-clip-text text-xl font-black tracking-wide text-transparent">
            BUDU
          </p>
          <p className="text-[11px] font-medium tracking-widest text-slate-400">{t('甜蜜治愈日常')}</p>
        </div>
      </div>

      {/* 菜单 */}
      <nav className="flex-1 space-y-1.5 overflow-y-auto px-4">
        <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-300">
          {t('运营管理')}
        </p>
        {menus.map((item) => {
          const Icon = item.icon
          const subs = subMenus[item.key]
          const openSub = isSubmenuOpen(item.key)
          const active = item.key === 'overview' ? view === 'overview' : openSub

          if (subs) {
            return (
              <div key={item.key}>
                <button
                  onClick={() => toggleExpand(item.key)}
                  className={`group flex w-full items-center gap-3 rounded-2xl px-3.5 py-2.5 text-sm font-medium transition-all ${
                    active
                      ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white shadow-lg shadow-budu-200/60'
                      : 'text-slate-500 hover:bg-budu-50 hover:text-budu-600'
                  }`}
                >
                  <Icon className={`h-[18px] w-[18px] ${active ? 'text-white' : 'text-slate-400 group-hover:text-budu-500'}`} />
                  {t(item.label)}
                  <ChevronDown
                    className={`ml-auto h-4 w-4 transition-transform duration-200 ${
                      active ? 'text-white' : 'text-slate-300'
                    } ${openSub ? 'rotate-180' : ''}`}
                  />
                </button>

                {openSub && (
                  <div className="ml-[18px] mt-1 space-y-1 border-l-2 border-budu-100 pl-3">
                    {subs.map((sub) => {
                      const subActive = view === sub.key
                      return (
                        <button
                          key={sub.key}
                          onClick={() => handleNavigate(sub.key)}
                          className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium transition-all ${
                            subActive
                              ? 'bg-gradient-to-r from-budu-100 to-grape-100 text-budu-700 shadow-sm'
                              : 'text-slate-500 hover:bg-budu-50 hover:text-budu-600'
                          }`}
                        >
                          <span className={`text-[9px] ${subActive ? 'text-budu-500' : 'text-slate-300'}`}>●</span>
                          {t(sub.label)}
                          {subActive && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-budu-500" />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          }

          return (
            <button
              key={item.key}
              onClick={() => handleNavigate(item.key)}
              className={`group flex w-full items-center gap-3 rounded-2xl px-3.5 py-2.5 text-sm font-medium transition-all ${
                active
                  ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white shadow-lg shadow-budu-200/60'
                  : 'text-slate-500 hover:bg-budu-50 hover:text-budu-600'
              }`}
            >
              <Icon className={`h-[18px] w-[18px] ${active ? 'text-white' : 'text-slate-400 group-hover:text-budu-500'}`} />
              {t(item.label)}
              {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-white/90" />}
            </button>
          )
        })}
      </nav>

      {/* 底部用户卡片 */}
      <div className="px-4 pb-5 pt-4">
        <div className="rounded-2xl bg-gradient-to-br from-budu-50 via-white to-grape-50 p-4 shadow-inner ring-1 ring-budu-100/60">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-budu-400 to-grape-500 text-sm font-bold text-white">
              YG
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-700">Yue Gu</p>
              <p className="truncate text-xs text-slate-400">{t('总部运营 · 管理员')}</p>
            </div>
            <button className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-xl text-slate-400 transition hover:bg-white hover:text-budu-500">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
        <p className="mt-3 text-center text-[10px] font-medium tracking-[0.18em] text-slate-300">
          BUDU Operating System V1.0
        </p>
      </div>
    </aside>
  )
}
