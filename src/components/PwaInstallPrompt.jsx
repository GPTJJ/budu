import { useEffect, useState } from 'react'
import { Download, Share, X } from 'lucide-react'
import { useI18n } from '../i18n'

const DISMISS_KEY = 'budu-pwa-install-dismissed-at'
const DISMISS_MS = 7 * 24 * 60 * 60 * 1000

function recentlyDismissed() {
  try {
    return Date.now() - Number(localStorage.getItem(DISMISS_KEY) || 0) < DISMISS_MS
  } catch {
    return false
  }
}

export default function PwaInstallPrompt({ authenticated = false }) {
  const { t } = useI18n()
  const [installEvent, setInstallEvent] = useState(null)
  const [showIosTip, setShowIosTip] = useState(false)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
    const mobile = window.matchMedia('(max-width: 767px)').matches
    if (standalone || !mobile || recentlyDismissed()) return undefined

    const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent)
    const onBeforeInstall = (event) => {
      event.preventDefault()
      setInstallEvent(event)
      setVisible(true)
    }
    const onInstalled = () => setVisible(false)

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    if (isIos) {
      setShowIosTip(true)
      setVisible(true)
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()))
    } catch {
      // Safari 私密模式下可能无法写入，忽略即可。
    }
    setVisible(false)
  }

  const install = async () => {
    if (!installEvent) return
    await installEvent.prompt()
    const { outcome } = await installEvent.userChoice
    if (outcome === 'accepted') setVisible(false)
    setInstallEvent(null)
  }

  if (!visible) return null

  return (
    <aside
      className={`fixed left-3 right-3 z-[60] mx-auto max-w-md rounded-2xl border border-white/80 bg-white/95 p-3 shadow-2xl shadow-grape-200/40 backdrop-blur-xl ${
        authenticated ? 'bottom-[calc(5.2rem+env(safe-area-inset-bottom))] lg:bottom-6' : 'bottom-[calc(1rem+env(safe-area-inset-bottom))]'
      }`}
      aria-label={t('安装 budu 应用')}
    >
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-budu-500 to-grape-500 text-white shadow-md shadow-budu-200">
          {showIosTip ? <Share className="h-5 w-5" /> : <Download className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-slate-800">{t('安装 budu 到手机')}</p>
          <p className="mt-0.5 text-[11px] leading-4 text-slate-400">
            {showIosTip ? t('点击 Safari 分享按钮，再选择“添加到主屏幕”') : t('获得全屏体验，像普通 App 一样快速打开')}
          </p>
        </div>
        {installEvent && (
          <button
            type="button"
            onClick={install}
            className="min-h-10 shrink-0 rounded-xl bg-budu-50 px-3 text-xs font-bold text-budu-600 transition active:scale-95"
          >
            {t('安装')}
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-slate-300 transition hover:bg-slate-50 hover:text-slate-500"
          aria-label={t('稍后再说')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </aside>
  )
}
