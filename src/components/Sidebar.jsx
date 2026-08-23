import { useState } from 'react'
import {
  LayoutDashboard,
  ChartNoAxesCombined,
  Store,
  Users,
  Package,
  Warehouse,
  Wallet,
  Settings,
  FolderArchive,
  ChevronDown,
  ClipboardCheck,
} from 'lucide-react'
import { t } from '../utils/text'
import AccountMenu from './AccountMenu'
import logoUrl from '../assets/logo.jpg'
import { APP_VERSION } from '../version'
import { MODULE_KEYS, hasModuleAccess } from '../../shared/accountPermissions'

const menus = [
  { key: 'overview', label: '首页概览', icon: LayoutDashboard },
  { key: 'analysis', label: '经营分析', icon: ChartNoAxesCombined },
  { key: 'staff', label: '人员管理', icon: Users },
  { key: 'store', label: '门店经营', icon: Store },
  { key: 'inventory', label: '库存调拨', icon: Warehouse },
  { key: 'finance', label: '财务利润', icon: Wallet },
  { key: 'finance-invoice', label: '发票开具', icon: Wallet },
  { key: 'approval', label: '审批中心', icon: ClipboardCheck },
  { key: 'asset-center', label: 'budu档案馆', icon: FolderArchive },
  { key: 'settings', label: '系统设置', icon: Settings },
]

const subMenus = {
  staff: [
    { key: 'staff', label: '雇员' },
    { key: 'staff-payroll', label: '工资条' },
    { key: 'employee-profile', label: '员工档案' },
  ],
  store: [
    { key: 'store-entry', label: '门店业绩录入' },
    { key: 'store-schedule', label: '门店排班' },
    { key: 'store-mailing', label: '门店邮寄' },
    { key: 'store-pos', label: 'POS 点单' },
    { key: 'product-center', label: '商品中心' },
  ],
  inventory: [
    { key: 'inventory-transfer', label: '申请调货' },
    { key: 'inventory-purchase', label: '申请采购' },
  ],
}

export default function Sidebar({ open, onClose, view, onNavigate, user, onUserChange, onLogout }) {
  const [expandedKeys, setExpandedKeys] = useState({})
  const groupModules = {
    staff: [MODULE_KEYS.STAFF, MODULE_KEYS.STAFF_PAYROLL, MODULE_KEYS.EMPLOYEE_PROFILE],
    store: [MODULE_KEYS.STORE_ENTRY, MODULE_KEYS.STORE_SCHEDULE, MODULE_KEYS.STORE_MAILING, MODULE_KEYS.STORE_POS, MODULE_KEYS.PRODUCT_CENTER],
    inventory: [MODULE_KEYS.INVENTORY_TRANSFER, MODULE_KEYS.INVENTORY_PURCHASE],
  }
  const visibleMenus = menus.filter((item) => {
    const keys = groupModules[item.key]
    return keys ? keys.some((key) => hasModuleAccess(user, key)) : hasModuleAccess(user, item.key)
  })

  const toggleExpand = (key) =>
    setExpandedKeys((s) => ({ ...s, [key]: !s[key] }))

  const isSubmenuOpen = (key) => expandedKeys[key] || (view && (view === key || view.startsWith(`${key}-`)))

  const handleNavigate = (key) => {
    onNavigate(key)
    onClose()
  }

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-slate-200/70 bg-white/95 backdrop-blur transition-transform duration-300 lg:sticky lg:top-0 lg:z-30 lg:h-screen lg:translate-x-0 lg:bg-white ${
        open ? 'translate-x-0' : '-translate-x-full'
      }`}
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-6 pb-6 pt-7">
        <img src={logoUrl} alt="budu" className="h-11 w-11 rounded-2xl object-cover shadow-sm" />
        <div>
          <p className="text-xl font-bold tracking-wide text-slate-900">
            budu
          </p>
          <p className="text-[11px] font-medium tracking-widest text-slate-400">{t('甜蜜治愈日常')}</p>
        </div>
      </div>

      {/* 菜单（移动端内容超出时可滚动，底部渐变提示可继续滑动） */}
      <nav className="relative flex-1 space-y-1.5 overflow-y-auto px-4">
        <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
          {t('运营管理')}
        </p>
        {visibleMenus.map((item) => {
          const Icon = item.icon
          // 商品中心已并入「门店经营」：staff 无商品权限，子菜单中隐藏（与页面权限一致）
          const subs = (subMenus[item.key] || []).filter((sub) => hasModuleAccess(user, sub.key))
          const openSub = isSubmenuOpen(item.key)
          const active = item.key === 'overview' ? view === 'overview' : openSub

          if (subs.length > 0) {
            return (
              <div key={item.key}>
                <button
                  onClick={() => toggleExpand(item.key)}
                  className={`group flex min-h-10 w-full items-center gap-3 rounded-2xl px-3.5 py-2 text-sm font-medium transition lg:min-h-11 lg:py-2.5 ${
                    active
                      ? 'bg-budu-50 text-budu-700'
                      : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  <Icon className={`h-[18px] w-[18px] ${active ? 'text-budu-600' : 'text-slate-400 group-hover:text-budu-500'}`} />
                  {t(item.label)}
                  <ChevronDown
                    className={`ml-auto h-4 w-4 transition-transform duration-200 ${
                      active ? 'text-budu-600' : 'text-slate-300'
                    } ${openSub ? 'rotate-180' : ''}`}
                  />
                </button>

                {openSub && (
                  <div className="ml-[18px] mt-1 space-y-1 border-l-2 border-slate-200/80 pl-3">
                    {subs.map((sub) => {
                      const subActive = view === sub.key
                      return (
                        <button
                          key={sub.key}
                          onClick={() => handleNavigate(sub.key)}
                          className={`flex min-h-10 w-full items-center gap-2.5 rounded-xl px-3 py-1.5 text-[13px] font-medium transition lg:min-h-11 lg:py-2 ${
                            subActive
                              ? 'bg-budu-50 text-budu-700'
                              : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'
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
              className={`group flex min-h-10 w-full items-center gap-3 rounded-2xl px-3.5 py-2 text-sm font-medium transition lg:min-h-11 lg:py-2.5 ${
                active
                      ? 'bg-budu-50 text-budu-700'
                      : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <Icon className={`h-[18px] w-[18px] ${active ? 'text-budu-600' : 'text-slate-400 group-hover:text-budu-500'}`} />
              {t(item.label)}
              {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-budu-500" />}
            </button>
          )
        })}
        {/* 移动端滚动提示：底部渐变淡出，暗示菜单可继续滑动（不影响点击） */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-7 rounded-b-2xl bg-gradient-to-t from-white via-white/70 to-transparent lg:hidden" />
      </nav>

      {/* 底部用户卡片 */}
      <div className="px-4 pb-5 pt-4">
        <div className="rounded-xl bg-slate-50/80 p-2 ring-1 ring-slate-200/70">
          <AccountMenu
            user={user}
            onUserChange={onUserChange}
            onLogout={onLogout}
            onManageAccounts={() => onNavigate('account-admin')}
            variant="sidebar"
          />
        </div>
        <p className="mt-3 text-center text-[10px] font-medium tracking-[0.18em] text-slate-300">
          budu Operating System {APP_VERSION}
        </p>
      </div>
    </aside>
  )
}
