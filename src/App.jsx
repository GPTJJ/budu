import { useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import Header from './components/Header'
import KpiCard from './components/KpiCard'
import StoreRankingTable from './components/StoreRankingTable'
import RevenueTrendChart from './components/RevenueTrendChart'
import ChannelChart from './components/ChannelChart'
import EmployeePerformanceTable from './components/EmployeePerformanceTable'
import ProductSalesTable from './components/ProductSalesTable'
import NotificationPanel from './components/NotificationPanel'
import PersonnelPage from './components/PersonnelPage'
import StoreEntryPage from './components/StoreEntryPage'
import SettingsPage from './components/SettingsPage'
import AccountAdminPage from './components/AccountAdminPage'
import DataAnalysisPage from './components/DataAnalysisPage'
import ProductCatalogPage from './components/ProductCatalogPage'
import { kpiCards } from './utils/selectors'
import LoginPage from './components/LoginPage'
import { api } from './utils/api'
import { loadUserData, resetUserData } from './utils/userData'
import { useI18n } from './i18n'
import { PublicModeProvider } from './visibility'

export default function App() {
  const { lang, t } = useI18n()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [store, setStore] = useState('all')
  const [day, setDay] = useState(null) // 'MM-DD' 按日查看；null 按整月查看
  const [view, setView] = useState('overview')
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [dataReady, setDataReady] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState(null)

  useEffect(() => {
    api('/auth/me')
      .then(async ({ user: u }) => {
        setUser(u)
        await loadUserData()
        setDataReady(true)
      })
      .catch(() => {
        setUser(null)
        setDataReady(true)
      })
      .finally(() => setAuthLoading(false))
  }, [])

  const handleLogin = async (u) => {
    setUser(u)
    await loadUserData()
    setDataReady(true)
  }

  const handleLogout = async () => {
    try {
      await api('/auth/logout', { method: 'POST' })
    } catch {
      /* 忽略退出失败 */
    }
    resetUserData()
    setUser(null)
  }

  const handleUserChange = (u) => setUser(u)

  const cards = kpiCards(month, store, day, lang)
  const isStaffView = view === 'staff-fulltime' || view === 'staff-parttime'
  const isStoreEntryView = view === 'store-entry'
  const isSettingsView = view === 'settings'
  const isAccountAdminView = view === 'account-admin'
  const isAnalyticsView = view === 'analytics'
  const isProductCatalogView = view === 'product-catalog'

  const openProduct = (name) => {
    setSelectedProduct(name)
    setView('product-catalog')
  }

  if (authLoading || !dataReady) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#F7F4FA]">
        <p className="text-sm font-medium text-slate-400">{t('正在加载 budu 系统…')}</p>
      </div>
    )
  }

  if (!user) {
    return <LoginPage onLogin={handleLogin} />
  }

  return (
    <PublicModeProvider isPublic={user?.role === 'public'} isStore={user?.role === 'store'}>
      <div className="flex min-h-screen bg-[#F7F4FA]">
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
        onNavigate={setView}
        user={user}
        onUserChange={handleUserChange}
        onLogout={handleLogout}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          month={month}
          store={store}
          day={day}
          user={user}
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
        />

        <main className="flex-1 space-y-6 px-4 py-5 sm:px-5 sm:py-6 lg:px-8">
          {isStaffView ? (
            <PersonnelPage
              type={view === 'staff-fulltime' ? 'fulltime' : 'parttime'}
              onTypeChange={(t) => setView(t === 'fulltime' ? 'staff-fulltime' : 'staff-parttime')}
              onBack={() => setView('overview')}
              canDelete={user?.role === 'developer'}
              canManage={user?.role === 'developer'}
            />
          ) : isStoreEntryView && user?.role !== 'public' ? (
            <StoreEntryPage onBack={() => setView('overview')} />
          ) : isSettingsView ? (
            <SettingsPage user={user} onBack={() => setView('overview')} />
          ) : isAccountAdminView && user?.role === 'developer' ? (
            <AccountAdminPage currentUser={user} onBack={() => setView('overview')} />
          ) : isAnalyticsView && user?.role !== 'public' ? (
            <DataAnalysisPage onBack={() => setView('overview')} />
          ) : isProductCatalogView && user?.role !== 'public' ? (
            <ProductCatalogPage
              initialProduct={selectedProduct}
              onBack={() => {
                setSelectedProduct(null)
                setView('overview')
              }}
            />
          ) : (
            <>
              {/* 核心 KPI 统计 */}
              <section className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
                {cards.map((card) => (
                  <KpiCard key={card.key} card={card} />
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
                  <EmployeePerformanceTable store={store} month={month} />
                </div>
                <div className="xl:col-span-5">
                  <ProductSalesTable month={month} store={store} onOpenProduct={openProduct} />
                </div>
                <div className="xl:col-span-3">
                  <NotificationPanel month={month} day={day} />
                </div>
              </section>
            </>
          )}

          <footer className="pb-2 pt-1 text-center text-[11px] text-slate-300">
            {t('© 2026 budu 甜品 · budu Operating System V1.0 · 数据来源：budu OS文档（三店4-7月报表 / 薪资表27-31周）')}
          </footer>
        </main>
      </div>
      </div>
    </PublicModeProvider>
  )
}
