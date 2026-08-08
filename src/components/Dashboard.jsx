import { lazy, Suspense, useState } from 'react'
import Sidebar from './Sidebar'
import Header from './Header'
import KpiCard from './KpiCard'
import StoreRankingTable from './StoreRankingTable'
import RevenueTrendChart from './RevenueTrendChart'
import ChannelChart from './ChannelChart'
import EmployeePerformanceTable from './EmployeePerformanceTable'
import ProductSalesTable from './ProductSalesTable'
import NotificationPanel from './NotificationPanel'
import MobileBottomNav from './MobileBottomNav'
import PwaInstallPrompt from './PwaInstallPrompt'
import PageLoading from './LoadingSkeleton'
import { APP_VERSION } from '../version'
import { allStores, kpiCards } from '../utils/selectors'
import { loadUserData } from '../utils/userData'
import { useI18n } from '../i18n'
import { PublicModeProvider } from '../visibility'
import ErrorBoundary from './ErrorBoundary'

// 功能页面按需加载（登录后进入对应板块才下载，首屏不再包含它们）
const PersonnelPage = lazy(() => import('./PersonnelPage'))
const StoreEntryPage = lazy(() => import('./StoreEntryPage'))
const SchedulePage = lazy(() => import('./SchedulePage'))
const StoreMailingPage = lazy(() => import('./StoreMailingPage'))
const SettingsPage = lazy(() => import('./SettingsPage'))
const AccountAdminPage = lazy(() => import('./AccountAdminPage'))
const DataAnalysisPage = lazy(() => import('./DataAnalysisPage'))
const ProductCatalogPage = lazy(() => import('./ProductCatalogPage'))
const InventoryRequestPage = lazy(() => import('./InventoryRequestPage'))
const FinancePage = lazy(() => import('./FinancePage'))
const InvoicePage = lazy(() => import('./InvoicePage'))
const MemberPage = lazy(() => import('./MemberPage'))

const pageTitles = {
  staff: '雇员',
  'store-entry': '门店业绩录入',
  'store-schedule': '门店排班',
  'store-mailing': '门店邮寄',
  'product-catalog': '商品目录',
  'inventory-transfer': '申请调货',
  'inventory-purchase': '申请采购',
  finance: '财务利润',
  'finance-invoice': '发票开具',
  member: '会员营销',
  analytics: '数据分析',
  settings: '系统设置',
  'account-admin': '账号管理',
}

export default function Dashboard({ user, onLogout, onUserChange }) {
  const { lang, t } = useI18n()
  const needsBinding =
    user && user.role !== 'developer' && user.role !== 'public' && (!user.storeKeys || user.storeKeys.length === 0)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [store, setStore] = useState(() => {
    if (user?.role === 'developer' || user?.role === 'public') return 'all'
    const list = allStores().filter((s) => (user.storeKeys || []).includes(s.key))
    return list[0] ? list[0].key : 'all'
  })
  const [day, setDay] = useState(null) // 'MM-DD' 按日查看；null 按整月查看
  const [view, setView] = useState('overview')
  const [selectedProduct, setSelectedProduct] = useState(null)
  const [pageKey, setPageKey] = useState(0)

  const cards = kpiCards(month, store, day, lang)
  const isStaffView = view === 'staff'
  const isStoreEntryView = view === 'store-entry'
  const isScheduleView = view === 'store-schedule'
  const isMailingView = view === 'store-mailing'
  const isSettingsView = view === 'settings'
  const isAccountAdminView = view === 'account-admin'
  const isAnalyticsView = view === 'analytics'
  const isProductCatalogView = view === 'product-catalog'
  const isInventoryTransferView = view === 'inventory-transfer'
  const isInventoryPurchaseView = view === 'inventory-purchase'
  const isFinanceView = view === 'finance'
  const isInvoiceView = view === 'finance-invoice'
  const isMemberView = view === 'member'

  const openProduct = (name) => {
    setSelectedProduct(name)
    setView('product-catalog')
  }

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

  const handleNavigate = (nextView) => {
    setView(nextView)
    if (nextView !== 'product-catalog') setSelectedProduct(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
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

  return (
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
            title={view === 'overview' ? null : pageTitles[view]}
            showOverviewTools={view === 'overview'}
            user={user}
            onNavigate={handleNavigate}
            onDaySelect={(m, d) => {
              setMonth(m)
              setDay(d)
            }}
            onMonthChange={(m) => {
              setMonth(m)
              setDay(null)
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
              {isStaffView ? (
                <PersonnelPage
                  onBack={() => setView('overview')}
                  canDelete={user?.role === 'developer'}
                  canManage={user?.role === 'developer'}
                  user={user}
                />
              ) : isStoreEntryView && user?.role !== 'public' ? (
                <StoreEntryPage onBack={() => setView('overview')} />
              ) : isScheduleView ? (
                <SchedulePage onBack={() => setView('overview')} canEdit={user?.role !== 'public'} />
              ) : isMailingView && user?.role !== 'public' ? (
                <StoreMailingPage onBack={() => setView('overview')} />
              ) : isSettingsView ? (
                <SettingsPage user={user} onBack={() => setView('overview')} />
              ) : isAccountAdminView && user?.role === 'developer' ? (
                <AccountAdminPage currentUser={user} onBack={() => setView('overview')} />
              ) : isAnalyticsView && user?.role !== 'public' ? (
                <DataAnalysisPage onBack={() => setView('overview')} />
              ) : isProductCatalogView && user?.role !== 'public' ? (
                <ProductCatalogPage
                  initialProduct={selectedProduct}
                  canEdit={user?.role !== 'public'}
                  onBack={() => {
                    setSelectedProduct(null)
                    setView('overview')
                  }}
                />
              ) : isInventoryTransferView && user?.role !== 'public' ? (
                <InventoryRequestPage
                  type="transfer"
                  currentUser={user}
                  onBack={() => setView('overview')}
                />
              ) : isInventoryPurchaseView && user?.role !== 'public' ? (
                <InventoryRequestPage
                  type="purchase"
                  currentUser={user}
                  onBack={() => setView('overview')}
                />
              ) : isFinanceView && (user?.role === 'developer' || user?.role === 'manager') ? (
                <FinancePage currentUser={user} onBack={() => setView('overview')} />
              ) : isInvoiceView && user?.role !== 'public' ? (
                <InvoicePage currentUser={user} onBack={() => setView('overview')} />
              ) : isMemberView && user?.role !== 'public' ? (
                <MemberPage currentUser={user} onBack={() => setView('overview')} />
              ) : (
                <>
                  {/* 核心 KPI 统计 */}
                  <section className="grid grid-cols-2 gap-3 sm:gap-5 xl:grid-cols-3 2xl:grid-cols-6">
                    {cards.map((card, i) => (
                      <KpiCard key={card.key} card={card} featured={i === 0} />
                    ))}
                  </section>

                  {/* 中部分析模块 */}
                  <section className="grid grid-cols-1 gap-5 xl:grid-cols-12">
                    <div className="xl:col-span-4">
                      <StoreRankingTable month={month} store={store} day={day} />
                    </div>
                    <div className="xl:col-span-5">
                      <RevenueTrendChart month={month} store={store} day={day} />
                    </div>
                    <div className="xl:col-span-3">
                      <ChannelChart month={month} store={store} day={day} />
                    </div>
                  </section>

                  {/* 底部业绩与数据模块 */}
                  <section className="grid grid-cols-1 gap-5 xl:grid-cols-12">
                    <div className="xl:col-span-4">
                      <EmployeePerformanceTable store={store} month={month} user={user} />
                    </div>
                    <div className="xl:col-span-5">
                      <ProductSalesTable month={month} store={store} onOpenProduct={openProduct} />
                    </div>
                    <div className="xl:col-span-3">
                      <NotificationPanel month={month} day={day} user={user} />
                    </div>
                  </section>
                </>
              )}
              </Suspense>
            </ErrorBoundary>

            <footer className="pb-2 pt-1 text-center text-[11px] text-slate-300">
              {t('© 2026 budu 甜品 · budu Operating System {version}', { version: APP_VERSION })}
            </footer>
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
  )
}
