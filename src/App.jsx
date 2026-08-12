import { Suspense, useEffect, useState } from 'react'
import LoginPage from './components/LoginPage'
import { AppLoading } from './components/LoadingSkeleton'
import { api } from './utils/api'
import { loadUserData, resetUserData } from './utils/userData'
import { useI18n } from './i18n'
import { lazyRetry } from './utils/lazyRetry'

// 主面板按需加载：未登录时只下载登录页所需代码，首屏体积最小
const Dashboard = lazyRetry(() => import('./components/Dashboard'))

export default function App() {
  const { t } = useI18n()
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [dataReady, setDataReady] = useState(false)

  useEffect(() => {
    api('/auth/me')
      .then(async ({ user: u }) => {
        setUser(u)
        await loadUserData().catch(() => {})
        setDataReady(true)
      })
      .catch(() => {
        setUser(null)
        setDataReady(true)
      })
      .finally(() => setAuthLoading(false))
  }, [])

  // 账号权限实时同步：授权/取消授权后，已登录会话在 10 秒内自动生效
  useEffect(() => {
    if (!user) return undefined
    const id = window.setInterval(async () => {
      try {
        const data = await api('/auth/me')
        if (!data || !data.user) return
        setUser((prev) => {
          if (!prev) return prev
          const next = data.user
          const keys = ['role', 'storeKeys', 'staffKey', 'assetCenter', 'permissions']
          const changed = keys.some((key) => JSON.stringify(prev[key]) !== JSON.stringify(next[key]))
          return changed ? next : prev
        })
      } catch {
        /* 网络波动时保留当前账号 */
      }
    }, 10000)
    return () => window.clearInterval(id)
  }, [user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogin = async (u) => {
    setUser(u)
    await loadUserData().catch(() => {})
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
    return <AppLoading />
  }

  if (!user) {
    return <LoginPage onLogin={handleLogin} />
  }

  return (
    <Suspense
      fallback={<AppLoading />}
    >
      <Dashboard user={user} onLogout={handleLogout} onUserChange={(u) => setUser(u)} />
    </Suspense>
  )
}
