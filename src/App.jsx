import { lazy, Suspense, useEffect, useState } from 'react'
import LoginPage from './components/LoginPage'
import { api } from './utils/api'
import { loadUserData, resetUserData } from './utils/userData'
import { useI18n } from './i18n'

// 主面板按需加载：未登录时只下载登录页所需代码，首屏体积最小
const Dashboard = lazy(() => import('./components/Dashboard'))

export default function App() {
  const { t } = useI18n()
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

  if (authLoading || !dataReady) {
    return (
      <div className="grid min-h-screen min-h-[100dvh] place-items-center bg-[#F7F4FA]">
        <p className="text-sm font-medium text-slate-400">{t('正在加载 budu 系统…')}</p>
      </div>
    )
  }

  if (!user) {
    return <LoginPage onLogin={handleLogin} />
  }

  return (
    <Suspense
      fallback={
        <div className="grid min-h-screen min-h-[100dvh] place-items-center bg-[#F7F4FA]">
          <p className="text-sm font-medium text-slate-400">{t('正在加载 budu 系统…')}</p>
        </div>
      }
    >
      <Dashboard user={user} onLogout={handleLogout} onUserChange={(u) => setUser(u)} />
    </Suspense>
  )
}
