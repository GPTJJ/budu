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
import { kpiCards, MONTHS } from './utils/selectors'
import LoginPage from './components/LoginPage'
import { api } from './utils/api'
import { loadUserData, resetUserData } from './utils/userData'
import { useI18n } from './i18n'

export default function App() {
  const { lang, t } = useI18n()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [month, setMonth] = useState(MONTHS[MONTHS.length - 1].key)
  const [store, setStore] = useState('all')
  const [day, setDay] = useState(null) // 'MM-DD' 按日查看；null 按整月查看
  const [view, setView] = useState('overview')
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [dataReady, setDataReady] = useState(false)

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

  const cards = kpiCards(month, store, day, lang)
  const isStaffView = view === 'staff-fulltime' || view === 'staff-parttime'
  const isStoreEntryView = view === 'store-entry'
  const isSettingsView = view === 'settings'

  if (authLoading || !dataReady) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#F7F4FA]">
        <p className="text-sm font-medium text-slate-400">{t('正在加载 BUDU 系统…')}</p>
      </div>
    )
  }

  if (!user) {
    return <LoginPage onLogin={handleLogin} />
  }

  return (
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
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          month={month}
          store={store}
          day={day}
          user={user}
          onLogout={handleLogout}
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

        <main className="flex-1 space-y-6 px-5 py-6 lg:px-8">
          {isStaffView ? (
            <PersonnelPage
              type={view === 'staff-fulltime' ? 'fulltime' : 'parttime'}
              onTypeChange={(t) => setView(t === 'fulltime' ? 'staff-fulltime' : 'staff-parttime')}
              onBack={() => setView('overview')}
            />
          ) : isStoreEntryView ? (
            <StoreEntryPage onBack={() => setView('overview')} />
          ) : isSettingsView ? (
            <SettingsPage onBack={() => setView('overview')} />
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
                  <EmployeePerformanceTable store={store} />
                </div>
                <div className="xl:col-span-5">
                  <ProductSalesTable month={month} store={store} />
                </div>
                <div className="xl:col-span-3">
                  <NotificationPanel month={month} day={day} />
                </div>
              </section>
            </>
          )}

          <footer className="pb-2 pt-1 text-center text-[11px] text-slate-300">
            {t('© 2026 BUDU 甜品 · BUDU Operating System V1.0 · 数据来源：budu OS文档（三店4-7月报表 / 薪资表27-31周）')}
          </footer>
        </main>
      </div>
    </div>
  )
}
