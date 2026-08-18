import { useEffect, useState } from 'react'
import { BadgeDollarSign, Bell, RefreshCw } from 'lucide-react'
import {
  getAlerts,
  subscribe,
  ensurePolling,
  markSeen,
  unlockAudio,
  isAlertMuted,
  setAlertMuted,
  refreshAlerts,
} from '../utils/inventoryAlerts'
import { storeName } from '../utils/selectors'
import { periodLabel } from '../utils/payrollSlip'
import PayrollSlipModal from './PayrollSlipModal'
import PayrollHistoryModal from './PayrollHistoryModal'
import { useI18n } from '../i18n'

const yuan = (cents) => (Number(cents || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function NotificationBell({ variant = 'desktop', user, onNavigate }) {
  const { t } = useI18n()
  const [alerts, setAlerts] = useState(getAlerts())
  const [open, setOpen] = useState(false)
  const [muted, setMuted] = useState(isAlertMuted())
  const [payrollNotice, setPayrollNotice] = useState(null)
  const [showPayrollHistory, setShowPayrollHistory] = useState(false)

  useEffect(() => {
    ensurePolling(user)
    const unsub = subscribe(setAlerts)
    window.addEventListener('pointerdown', unlockAudio, { once: true })
    return () => {
      unsub()
      window.removeEventListener('pointerdown', unlockAudio)
    }
  }, [user?.username, user?.role, user?.assetCenter, user?.permissions])

  const isDesktop = variant === 'desktop'
  const unread = alerts.unread

  const openItem = (item) => {
    markSeen()
    setOpen(false)
    if (item.type === 'payroll') {
      setPayrollNotice(item)
      return
    }
    if (onNavigate) {
      onNavigate(
        item.type === 'mailing'
          ? 'store-mailing'
          : item.type === 'invoice'
            ? 'finance-invoice'
            : item.type === 'asset'
              ? 'asset-center'
            : item.type === 'transfer'
              ? 'inventory-transfer'
              : 'inventory-purchase',
      )
    }
  }

  const storeLabel = (key, name) => name || storeName(key)

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          isDesktop
            ? 'hidden h-11 w-11 place-items-center rounded-lg border border-slate-200/70 bg-white/80 text-slate-500 shadow-sm transition hover:border-slate-300 hover:text-budu-500 md:grid'
            : 'relative grid h-10 w-10 place-items-center rounded-lg border border-slate-200/70 bg-white/80 text-slate-500 shadow-sm transition active:scale-95 md:hidden'
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
            className={`absolute right-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-lg ${
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
              {alerts.items.length > 0 &&
                alerts.items.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => openItem(r)}
                    className="block w-full border-b border-slate-50 px-4 py-3 text-left transition hover:bg-budu-50/50"
                  >
                    <p className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-700">
                      <span
                        className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                          r.type === 'invoice'
                            ? 'bg-amber-50 text-amber-600'
                            : r.type === 'mailing'
                              ? 'bg-budu-50 text-budu-600'
                              : r.type === 'asset'
                                ? 'bg-rose-50 text-rose-600'
                              : r.type === 'payroll'
                                ? 'bg-emerald-50 text-emerald-600'
                                : 'bg-sky-50 text-sky-600'
                        }`}
                      >
                        {t(
                          r.type === 'invoice'
                            ? '开票申请'
                            : r.type === 'mailing'
                              ? '发件单'
                              : r.type === 'asset'
                                ? '资产到期'
                              : r.type === 'payroll'
                                ? '工资条'
                              : r.type === 'transfer'
                                ? '调货申请'
                                : '采购申请',
                        )}
                      </span>
                      {r.type === 'payroll'
                        ? t('{name} · {period}', {
                            name: r.employeeName || '',
                            period: periodLabel(r.periodType, r.periodKey),
                          })
                        : r.type === 'mailing'
                          ? t('{recipient} · {address}', { recipient: r.recipient || '', address: r.address || '' })
                          : r.type === 'invoice'
                            ? t('{company} · ¥{amount}', { company: r.companyName || t('个人'), amount: yuan(r.amountCents) })
                            : r.type === 'asset'
                              ? t('{file} · {days}', { file: r.fileName || '', days: r.remindType === 'expired' ? '已过期' : `${r.daysLeft} 天到期` })
                            : t('{count} 种货品', { count: r.items ? r.items.length : 1 })}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-400">
                      {r.type === 'payroll'
                        ? t('待签收 · {total}', { total: yuan(r.totalCents) })
                        : r.type === 'mailing'
                          ? t('{method} · {postage}{fee}', {
                              method: r.method || '',
                              postage: r.postage || '',
                              fee: r.fee ? ` · ${r.fee}` : '',
                            })
                          : r.type === 'invoice'
                            ? t('{store} · {category} · {email}', {
                                store: storeLabel(r.storeKey, r.storeName),
                                category: r.category || t('其他'),
                                email: r.email || '—',
                              })
                            : r.type === 'asset'
                              ? ''
                            : r.type === 'transfer'
                              ? t('从 {from} 调往 {to}', {
                                  from: storeLabel(r.fromStoreKey, r.fromStoreName),
                                  to: storeLabel(r.storeKey, r.storeName),
                                })
                              : t('采购至 {store}', { store: storeLabel(r.storeKey, r.storeName) })}
                    </p>
                    <p className="mt-0.5 text-[10px] text-slate-300">
                      {r.type === 'asset' || r.type === 'payroll' ? '' : t('由 {name} 提交', { name: r.createdBy })} · {new Date(r.createdAt).toLocaleString()}
                    </p>
                  </button>
                ))}
              {alerts.stock.length > 0 && (
                <>
                  <p className="px-4 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-rose-400">
                    {t('库存预警')}
                  </p>
                  {alerts.stock.map((s) => (
                    <div
                      key={`${s.storeKey}-${s.itemId}`}
                      className="flex items-center justify-between gap-2 border-b border-slate-50 px-4 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-semibold text-slate-700">{s.name}</p>
                        <p className="text-[11px] text-slate-400">{s.storeKey}</p>
                      </div>
                      <span className="shrink-0 rounded-md bg-rose-50 px-1.5 py-0.5 text-[11px] font-bold text-rose-500">
                        {s.quantity} / {t('阈值 {n}', { n: s.minQty })}
                      </span>
                    </div>
                  ))}
                </>
              )}
              {alerts.items.length === 0 && alerts.stock.length === 0 && (
                <p className="grid place-items-center py-10 text-xs text-slate-300">{t('暂无新申请通知')}</p>
              )}
            </div>

            {/* 工资条记录入口 + 提示音开关 */}
            <div className="border-t border-slate-100">
              {user && user.role !== 'public' && user.role !== 'cashier' && (
                <button
                  onClick={() => {
                    setShowPayrollHistory(true)
                    setOpen(false)
                  }}
                  className="flex w-full items-center justify-between px-4 py-2.5 text-left text-xs font-semibold text-budu-500 transition hover:bg-budu-50/60"
                >
                  <span className="flex items-center gap-1.5">
                    <BadgeDollarSign className="h-3.5 w-3.5" />
                    {t('工资条记录')}
                  </span>
                  <span className="text-[10px] text-slate-300">查看历史 / 签收留痕</span>
                </button>
              )}
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-xs font-medium text-slate-500">{t('提示音')}</span>
                <button
                  onClick={() => {
                    const next = !muted
                    setMuted(next)
                    setAlertMuted(next)
                    if (!next) unlockAudio()
                  }}
                  className={`relative h-5 w-9 rounded-full transition-colors ${
                    muted ? 'bg-slate-200' : 'bg-budu-400'
                  }`}
                  aria-label={t(muted ? '关闭' : '开启')}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] ${
                      muted ? 'left-0.5' : 'left-[18px]'
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>
        </>
      )}
      {payrollNotice && (
        <PayrollSlipModal
          notice={payrollNotice}
          onClose={() => setPayrollNotice(null)}
          onConfirmed={() => {
            setPayrollNotice(null)
            refreshAlerts()
          }}
        />
      )}
      {showPayrollHistory && (
        <PayrollHistoryModal user={user} onClose={() => setShowPayrollHistory(false)} />
      )}
    </div>
  )
}
