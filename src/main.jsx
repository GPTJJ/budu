import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n'
import ErrorBoundary from './components/ErrorBoundary'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </I18nProvider>
  </React.StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // PWA 安装能力不应影响主系统启动。
    })
    // 新版本 Service Worker 接管时自动刷新一次，确保总是最新版（避免旧页面缓存导致功能异常）
    let refreshed = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshed) return
      refreshed = true
      window.location.reload()
    })
  })
}
