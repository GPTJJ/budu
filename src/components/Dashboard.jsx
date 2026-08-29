import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import Sidebar from './Sidebar'
import Header from './Header'
import HomeWorkspace from './HomeWorkspace'
import MobileBottomNav from './MobileBottomNav'
import PwaInstallPrompt from './PwaInstallPrompt'
import ComplianceFooter from './ComplianceFooter'
import PageLoading from './LoadingSkeleton'
import PullToRefresh from './PullToRefresh'
import { allStores } from '../utils/selectors'
import { loadUserData } from '../utils/userData'
import { t } from '../utils/text'
import { PublicModeProvider } from '../visibility'
import ErrorBoundary from './ErrorBoundary'
import { lazyRetry } from '../utils/lazyRetry'
import useSwipeBack from '../hooks/useSwipeBack'
import { firstAccessibleModule, hasModuleAccess, hasPageAccess } from '../../shared/accountPermissions'
import { consumeNotificationDeepLink } from '../utils/notificationNavigation'

// 功能页面按需加载（登录后进入对应板块才下载，首屏不再包含它们）
const BusinessAnalysisPage = lazy(() => import('./BusinessAnalysisPage'))
const PersonnelPage = lazy(() => import('./PersonnelPage'))
const EmployeeProfilePage = lazy(() => import('./EmployeeProfilePage'))
const PayrollPage = lazy(() => import('./PayrollPage'))
const StoreEntryPage = lazy(() => import('./StoreEntryPage'))
const SchedulePage = lazy(() => import('./SchedulePage'))
const StoreMailingPage = lazy(() => import('./StoreMailingPage'))
const OrderRecordsPage = lazy(() => import('./OrderRecordsPage'))
const SettingsPage = lazy(() => import('./SettingsPage'))
const AccountAdminPage = lazy(() => import('./AccountAdminPage'))
const ProductCenterPage = lazy(() => import('./ProductCenterPage'))
const PosPage = lazyRetry(() => import('./PosPage'))
const InventoryRequestPage = lazy(() => import('./InventoryRequestPage'))
const ProductMaterialManagementPage = lazy(() => import('./ProductMaterialManagementPage'))
const PartnerSupplyPage = lazy(() => import('./PartnerSupplyPage'))
const FinancePage = lazy(() => import('./FinancePage'))
const InvoicePage = lazy(() => import('./InvoicePage'))
const ApprovalCenterPage = lazy(() => import('./ApprovalCenterPage'))
const AssetCenterPage = lazy(() => import('./AssetCenterPage'))

const pageTitles = {
  analysis: '经营分析',
  staff: '雇员',
  'employee-profile': '员工档案',
  'staff-payroll': '工资条',
  'store-entry': '门店业绩录入',
  'store-schedule': '门店排班',
  'store-mailing': '门店邮寄',
  'store-orders': '订单记录',
  'store-pos': 'POS 点单',
  'product-center': '商品中心',
  'inventory-transfer': '门店调拨',
  'inventory-purchase': '申请采购',
  'partner-supply': '合作商供货',
  'product-material-management': '产品物料管理',
  finance: '财务利润',
  'finance-invoice': '发票开具',
  approval: '审批中心',
  'asset-center': 'budu档案馆',
  settings: '系统设置',
  'account-admin': '账号管理',
}

export default function Dashboard({ user, onLogout, onUserChange }) {
  const needsBinding =
    user &&
    ['manager', 'staff'].includes(user.role) &&
    (user.bindingComplete === false || (user.bindingComplete === undefined && (!user.storeKeys || user.storeKeys.length === 0))) &&
    user.bindingLegacyExempt !== true
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [store, setStore] = useState(() => {
    if (user?.role === 'developer' || user?.role === 'public' || user?.role === 'finance' || user?.role === 'admin') return 'all'
    const list = allStores().filter((s) => (user.storeKeys || []).includes(s.key))
    return list[0] ? list[0].key : 'all'
  })
  const [day, setDay] = useState(() => {
    const d = new Date()
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` // 默认当天
  })
  const [weekStart, setWeekStart] = useState(null)
  const [view, setView] = useState(() => {
    const deepLinkTarget = consumeNotificationDeepLink((target) => hasModuleAccess(user, target))
    if (deepLinkTarget) return deepLinkTarget
    if (typeof window !== 'undefined' && window.location.hash === '#pos' && hasModuleAccess(user, 'store-pos')) return 'store-pos'
    return firstAccessibleModule(user)
  })
  const [pageKey, setPageKey] = useState(0)
  // 从人员管理跳转员工档案时的初始搜索目标（员工姓名/员工编号）
  const [profileTarget, setProfileTarget] = useState('')
  // Gate 7：有稳定 Employee.id 时直接以 id 打开档案（重名员工不再按姓名命中错误档案）
  const [profileTargetId, setProfileTargetId] = useState('')
  const [pendingPosOrder, setPendingPosOrder] = useState(null)
  // 移动端右滑返回的轻量页面栈：记录进入顺序，返回时回到真正的“上一页”
  const viewStackRef = useRef([])

  const openEmployeeProfile = (name, id) => {
    setProfileTarget(name || '')
    setProfileTargetId(id || '')
    handleNavigate('employee-profile')
  }

  // 桌面端空闲时预加载 POS；移动端/省流网络不抢占首页图表和数据带宽。
  useEffect(() => {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection
    const isMobile = window.matchMedia?.('(max-width: 1023px)').matches
    const isConstrained = connection?.saveData || ['slow-2g', '2g', '3g'].includes(connection?.effectiveType)
    if (isMobile || isConstrained) return undefined

    const preload = () => {
      import('./PosPage').catch(() => {})
      import('./OrderRecordsPage').catch(() => {})
    }
    if ('requestIdleCallback' in window) {
      const idleId = window.requestIdleCallback(preload, { timeout: 6000 })
      return () => window.cancelIdleCallback(idleId)
    }
    const timer = window.setTimeout(preload, 3000)
    return () => window.clearTimeout(timer)
  }, [])

  const isStaffView = view === 'staff'
  const isEmployeeProfileView = view === 'employee-profile'
  const isAnalysisView = view === 'analysis'
  const isPayrollView = view === 'staff-payroll'
  const isStoreEntryView = view === 'store-entry'
  const isScheduleView = view === 'store-schedule'
  const isMailingView = view === 'store-mailing'
  const isOrdersView = view === 'store-orders'
  const isPosView = view === 'store-pos'
  const isSettingsView = view === 'settings'
  const isAccountAdminView = view === 'account-admin'
  const isProductCenterView = view === 'product-center'
  const isInventoryTransferView = view === 'inventory-transfer'
  const isInventoryPurchaseView = view === 'inventory-purchase'
  const isPartnerSupplyView = view === 'partner-supply'
  const isProductMaterialManagementView = view === 'product-material-management'
  const isFinanceView = view === 'finance'
  const isInvoiceView = view === 'finance-invoice'
  const isApprovalView = view === 'approval'
  const isAssetCenterView = view === 'asset-center'

  const returnToOverview = () => {
    viewStackRef.current = []
    setView(hasModuleAccess(user, 'overview') ? 'overview' : firstAccessibleModule(user))
    if (typeof window !== 'undefined' && window.location.hash === '#pos') {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    }
    window.scrollTo?.({ top: 0, behavior: 'smooth' })
  }

  // 右滑返回：优先回到进入当前页之前的“上一页”（与动画快照一致），栈空则回首页
  const handleSwipeBack = () => {
    const prev = viewStackRef.current.pop()
    if (prev && hasPageAccess(user, prev)) {
      setView(prev)
      window.scrollTo?.({ top: 0, behavior: 'smooth' })
    } else {
      returnToOverview()
    }
  }

  const swipeBack = useSwipeBack({
    enabled: Boolean(view) && view !== 'overview' && !isPosView,
    onBack: () => {
      if (sidebarOpen) setSidebarOpen(false)
      else handleSwipeBack()
    },
  })

  useEffect(() => {
    if (view && hasPageAccess(user, view)) return
    const fallback = firstAccessibleModule(user)
    if (fallback !== view) setView(fallback)
  }, [user?.permissions, user?.role, view])

  if (needsBinding) {
    return (
      <div className="grid min-h-[70vh] place-items-center px-4">
        <div className="card w-full max-w-md p-8 text-center">
          <p className="text-4xl">🏬</p>
          <h2 className="mt-4 text-lg font-bold text-slate-800">{t('账号尚未绑定门店')}</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            {t('请联系开发者为你绑定门店后再使用；绑定后即可查看和操作本店数据')}
          </p>
          <button
            onClick={onLogout}
            className="mt-6 rounded-xl bg-budu-500 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
          >
            {t('退出登录')}
          </button>
        </div>
      </div>
    )
  }

  // 门店收银：仅 POS 点单，全屏进入（无侧边栏/首页/其他功能），退出 POS 即退出登录
  if (user?.role === 'cashier') {
    return (
      <PublicModeProvider isPublic={false} isStore={false}>
        <ErrorBoundary>
          <Suspense fallback={<PageLoading />}>
            <PosPage user={user} onExit={onLogout} />
          </Suspense>
        </ErrorBoundary>
      </PublicModeProvider>
    )
  }

  const handleNavigate = (nextView) => {
    if (!hasPageAccess(user, nextView)) return
    if (nextView !== view) {
      // 记录来源页并捕获其快照（右滑返回时作为“上一页”真实参与过渡）
      viewStackRef.current.push(view)
      swipeBack.capture()
    }
    setView(nextView)
    if (nextView === 'store-pos') window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#pos`)
    else if (window.location.hash === '#pos') window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const exitPos = () => {
    setPendingPosOrder(null)
    returnToOverview()
  }

  /** 局部刷新：先拉取最新共享数据，再重挂载当前页面组件（Header/Sidebar 保持不动） */
  const handleRefresh = async () => {
    try {
      await loadUserData()
    } catch {
      /* 网络异常时仍重挂载当前页，页面会读取本地缓存 */
    }
    setPageKey((v) => v + 1)
  }

  if (isPosView && hasModuleAccess(user, 'store-pos')) {
    return (
      <PublicModeProvider isPublic={false} isStore={false}>
        <ErrorBoundary>
          <Suspense fallback={<PageLoading />}>
            <PosPage user={user} onExit={exitPos} initialOrder={pendingPosOrder} />
          </Suspense>
        </ErrorBoundary>
      </PublicModeProvider>
    )
  }

  return (
    <PullToRefresh onRefresh={handleRefresh}>
      <PublicModeProvider isPublic={user?.role === 'public'} isStore={user?.role === 'store'}>
        <div className="flex min-h-screen min-h-[100dvh] bg-canvas">
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <Sidebar
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          view={view}
          onNavigate={handleNavigate}
          user={user}
          onUserChange={onUserChange}
          onLogout={onLogout}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <Header
            month={month}
            store={store}
            day={day}
            weekStart={weekStart}
            title={view === 'overview' ? null : pageTitles[view]}
            showOverviewTools={view === 'overview' || isAnalysisView}
            user={user}
            onNavigate={handleNavigate}
            onDaySelect={(m, d) => {
              setMonth(m)
              setDay(d)
              setWeekStart(null)
            }}
            onWeekSelect={(start, anchorMonth) => {
              setMonth(anchorMonth || start.slice(0, 7))
              setDay(null)
              setWeekStart(start)
            }}
            onMonthChange={(m) => {
              setMonth(m)
              setDay(null)
              setWeekStart(null)
            }}
            onStoreChange={setStore}
            onMenuClick={() => setSidebarOpen(true)}
            onRefresh={handleRefresh}
          />

          <main className="mx-auto w-full max-w-[1600px] flex-1 space-y-4 px-3 py-4 pb-[calc(6rem+env(safe-area-inset-bottom))] sm:space-y-6 sm:px-5 sm:py-6 sm:pb-[calc(6rem+env(safe-area-inset-bottom))] lg:px-8 lg:pb-6">
            <ErrorBoundary key={`${view}-${pageKey}`}>
              <Suspense
                fallback={<PageLoading />}
              >
              {!view ? (
                <div className="card mx-auto max-w-lg p-8 text-center">
                  <p className="text-4xl">🔒</p>
                  <h2 className="mt-4 text-lg font-bold text-slate-800">{t('暂未授权功能')}</h2>
                  <p className="mt-2 text-sm text-slate-400">{t('请联系开发者为当前账号开通所需版块')}</p>
                </div>
              ) : isAnalysisView && hasModuleAccess(user, 'analysis') ? (
                <BusinessAnalysisPage
                  month={month}
                  store={store}
                  day={day}
                  weekStart={weekStart}
                  user={user}
                  onBack={returnToOverview}
                />
              ) : isStaffView && hasModuleAccess(user, 'staff') ? (
                <PersonnelPage
                  onBack={returnToOverview}
                  canDelete={user?.role === 'developer' || user?.role === 'finance' || user?.role === 'admin'}
                  canManage={user?.role === 'developer' || user?.role === 'finance' || user?.role === 'admin'}
                  user={user}
                  onOpenProfile={openEmployeeProfile}
                />
              ) : isEmployeeProfileView && hasModuleAccess(user, 'employee-profile') ? (
                <EmployeeProfilePage
                  user={user}
                  onBack={returnToOverview}
                  initialQuery={profileTarget}
                  initialId={profileTargetId}
                />
              ) : isPayrollView && hasModuleAccess(user, 'staff-payroll') ? (
                <PayrollPage user={user} onBack={returnToOverview} onOpenProfile={openEmployeeProfile} />
              ) : isStoreEntryView && hasModuleAccess(user, 'store-entry') ? (
                <StoreEntryPage user={user} onBack={returnToOverview} />
              ) : isScheduleView && hasModuleAccess(user, 'store-schedule') ? (
                <SchedulePage user={user} onBack={returnToOverview} canEdit={user?.role !== 'public' && user?.role !== 'staff'} />
              ) : isMailingView && hasModuleAccess(user, 'store-mailing') ? (
                <StoreMailingPage currentUser={user} onBack={returnToOverview} />
              ) : isOrdersView && hasModuleAccess(user, 'store-pos') ? (
                <OrderRecordsPage
                  user={user}
                  onBack={returnToOverview}
                  onPay={(order) => {
                    setPendingPosOrder(order)
                    handleNavigate('store-pos')
                  }}
                />
              ) : isProductCenterView && hasModuleAccess(user, 'product-center') ? (
                <ProductCenterPage user={user} onBack={returnToOverview} />
              ) : isSettingsView && hasModuleAccess(user, 'settings') ? (
                <SettingsPage user={user} onBack={returnToOverview} />
              ) : isAccountAdminView && user?.role === 'developer' ? (
                <AccountAdminPage currentUser={user} onBack={returnToOverview} />
              ) : isInventoryTransferView && hasModuleAccess(user, 'inventory-transfer') ? (
                <InventoryRequestPage
                  type="transfer"
                  currentUser={user}
                  onBack={returnToOverview}
                />
              ) : isInventoryPurchaseView && hasModuleAccess(user, 'inventory-purchase') ? (
                <InventoryRequestPage
                  type="purchase"
                  currentUser={user}
                  onBack={returnToOverview}
                />
              ) : isPartnerSupplyView && hasModuleAccess(user, 'partner-supply') ? (
                <PartnerSupplyPage currentUser={user} onBack={returnToOverview} />
              ) : isProductMaterialManagementView && hasModuleAccess(user, 'product-material-management') ? (
                <ProductMaterialManagementPage onBack={returnToOverview} />
              ) : isFinanceView && hasModuleAccess(user, 'finance') ? (
                <FinancePage currentUser={user} onBack={returnToOverview} />
              ) : isInvoiceView && hasModuleAccess(user, 'finance-invoice') ? (
                <InvoicePage currentUser={user} onBack={returnToOverview} />
              ) : isApprovalView && hasModuleAccess(user, 'approval') ? (
                <ApprovalCenterPage user={user} onBack={returnToOverview} />
              ) : isAssetCenterView && hasModuleAccess(user, 'asset-center') ? (
                <AssetCenterPage user={user} onBack={returnToOverview} />
              ) : (
                <>
                  <HomeWorkspace
                    month={month}
                    store={store}
                    day={day}
                    weekStart={weekStart}
                    user={user}
                    onNavigate={handleNavigate}
                    onSelectStore={setStore}
                  />
                </>
              )}
              </Suspense>
            </ErrorBoundary>

            <ComplianceFooter className="pb-2 pt-1" />
          </main>
        </div>
        <MobileBottomNav
          view={view}
          user={user}
          onNavigate={handleNavigate}
          onMore={() => setSidebarOpen(true)}
        />
        <PwaInstallPrompt authenticated />
        </div>
      </PublicModeProvider>
    </PullToRefresh>
  )
}
