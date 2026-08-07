import { useEffect, useState } from 'react'
import { Bell, RefreshCw } from 'lucide-react'
import { getAlerts, subscribe, ensurePolling, markSeen } from '../utils/inventoryAlerts'
import { storeName } from '../utils/selectors'
import { useI18n } from '../i18n'

export default function NotificationBell({ variant = 'desktop', user, onNavigate }) {
  const { t } = useI18n()
  const [alerts, setAlerts] = useState(getAlerts())
  const [open, setOpen] = useState(false)

  useEffect(() => {
    ensurePolling(user)
    return subscribe(setAlerts)
  }, [user?.username, user?.role])

  const isDesktop = variant === 'desktop'
  const unread = alerts.unread

  const openItem = (item) => {
    markSeen()
    setOpen(false)
    if (onNavigate) onNavigate(item.type === 'transfer' ? 'inventory-transfer' : 'inventory-purchase')
  }

  const storeLabel = (key, name) => name || storeName(key)

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          isDesktop
            ? 'hidden h-11 w-11 place-items-center rounded-2xl bg-white text-slate-500 shadow-card transition hover:shadow-card-hover hover:text-budu-500 md:grid'
            : 'relative grid h-10 w-10 place-items-center rounded-2xl bg-white text-slate-500 shadow-card transition active:scale-95 md:hidden'
        }
        aria-label={t('查看通知')}
      >
        <Bell className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full border-2 border-white bg-rose-500 px-0.5 text-[9px] font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className={`absolute right-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-2xl ${
              isDesktop ? 'w-80' : 'w-[calc(100vw-3rem)] max-w-80'
            }`}
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <p className="text-sm font-bold text-slate-800">
                {t('通知')}
                {unread > 0 && (
                  <span className="ml-2 rounded-md bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-500">
                    {unread}
                  </span>
                )}
              </p>
              {unread > 0 && (
                <button
                  onClick={markSeen}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-budu-500 transition hover:bg-budu-50"
                >
                  <RefreshCw className="h-3 w-3" />
                  {t('全部已读')}
                </button>
              )}
            </div>

            <div className="max-h-80 overflow-y-auto">
              {alerts.items.length > 0 ? (
                alerts.items.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => openItem(r)}
                    className="block w-full border-b border-slate-50 px-4 py-3 text-left transition hover:bg-budu-50/50"
                  >
                    <p className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-700">
                      <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-600">
                        {t(r.type === 'transfer' ? '调货申请' : '采购申请')}
                      </span>
                      {t('{count} 种货品', { count: r.items ? r.items.length : 1 })}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-400">
                      {r.type === 'transfer'
                        ? t('从 {from} 调往 {to}', {
                            from: storeLabel(r.fromStoreKey, r.fromStoreName),
                            to: storeLabel(r.storeKey, r.storeName),
                          })
                        : t('采购至 {store}', { store: storeLabel(r.storeKey, r.storeName) })}
                    </p>
                    <p className="mt-0.5 text-[10px] text-slate-300">
                      {t('由 {name} 提交', { name: r.createdBy })} · {new Date(r.createdAt).toLocaleString()}
                    </p>
                  </button>
                ))
              ) : (
                <p className="grid place-items-center py-10 text-xs text-slate-300">{t('暂无新申请通知')}</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
