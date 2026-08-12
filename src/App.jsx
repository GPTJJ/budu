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

  // 账号权限实时同步：3 秒轮询 + 回到前台立即刷新 + 同浏览器多标签页授权后即时广播
  useEffect(() => {
    if (!user) return undefined
    let busy = false
    const sync = async () => {
      if (busy) return
      busy = true
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
      } finally {
        busy = false
      }
    }
    const id = window.setInterval(sync, 3000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync()
    }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    let bc = null
    try {
      bc = new BroadcastChannel('budu-auth-sync')
      bc.onmessage = (e) => {
        if (e && e.data && e.data.type === 'auth-changed') sync()
      }
    } catch {
      /* 浏览器不支持 BroadcastChannel 时忽略 */
    }
    return () => {
      window.clearInterval(id)
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
      if (bc) bc.close()
    }
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
