import { Suspense, useEffect, useState } from 'react'
import LoginPage from './components/LoginPage'
import { AppLoading } from './components/LoadingSkeleton'
import { api } from './utils/api'
import { loadUserData, prepareUserDataForUser, resetUserData } from './utils/userData'
import { t } from './utils/text'
import { lazyRetry } from './utils/lazyRetry'
import { OverlayStackManager } from './components/overlay/OverlayPrimitives'

// 主面板按需加载：未登录时只下载登录页所需代码，首屏体积最小
const loadDashboard = () => import('./components/Dashboard')
const Dashboard = lazyRetry(loadDashboard)
const CustomerRequestPage = lazyRetry(() => import('./components/CustomerRequestPage'))

export default function App() {
  if (window.location.pathname.replace(/\/+$/, '') === '/customer-request') {
    return (
      <>
        <OverlayStackManager />
        <Suspense fallback={<AppLoading />}>
          <CustomerRequestPage />
        </Suspense>
      </>
    )
  }
  return <><OverlayStackManager /><AuthenticatedApp /></>
}

function AuthenticatedApp() {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [dataReady, setDataReady] = useState(false)
  const [, setDataRevision] = useState(0)

  useEffect(() => {
    let cancelled = false
    const bootstrap = async () => {
      try {
        const { user: u } = await api('/auth/me')
        if (cancelled) return
        const restored = prepareUserDataForUser(u.id)
        setUser(u)
        // 登录确认后立即并行下载 Dashboard，不再等待所有业务接口结束后才开始。
        loadDashboard().catch(() => {})
        if (restored) {
          setDataReady(true)
          setAuthLoading(false)
        }
        await loadUserData({
          userId: u.id,
          onBaseReady: () => {
            if (cancelled) return
            setDataReady(true)
            setAuthLoading(false)
          },
        }).catch(() => {})
        if (cancelled) return
        setDataReady(true)
        setDataRevision((value) => value + 1)
      } catch {
        if (cancelled) return
        setUser(null)
        setDataReady(true)
      } finally {
        if (!cancelled) setAuthLoading(false)
      }
    }
    bootstrap()
    return () => {
      cancelled = true
    }
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
          const keys = ['role', 'storeKeys', 'staffKey', 'employeeId', 'assetCenter', 'permissions', 'status', 'bindingComplete', 'bindingLegacyExempt']
          const changed = keys.some((key) => JSON.stringify(prev[key]) !== JSON.stringify(next[key]))
          return changed ? next : prev
        })
      } catch (error) {
        if (error?.status === 401 || error?.status === 403) {
          resetUserData()
          setUser(null)
        }
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

  const handleLogin = (u) => {
    const restored = prepareUserDataForUser(u.id)
    setDataReady(restored)
    setUser(u)
    loadDashboard().catch(() => {})
    loadUserData({
      userId: u.id,
      onBaseReady: () => setDataReady(true),
    })
      .catch(() => {})
      .finally(() => {
        setDataReady(true)
        setDataRevision((value) => value + 1)
      })
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
