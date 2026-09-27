import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bell, RefreshCw } from 'lucide-react'
import {
  getAlerts,
  subscribe,
  ensurePolling,
  markSeen,
  unlockAudio,
  isAlertMuted,
  setAlertMuted,
  markNotificationRead,
  markApprovalRead,
  markAllAlertsRead,
} from '../utils/inventoryAlerts'
import { storeName } from '../utils/selectors'
import { periodLabel } from '../utils/payrollSlip'
import { t } from '../utils/text'
import { notificationTargetView, prepareNotificationRecordFocus } from '../utils/notificationNavigation'

const yuan = (cents) => (Number(cents || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function NotificationBell({ variant = 'desktop', user, onNavigate }) {
  const [alerts, setAlerts] = useState(getAlerts())
  const [open, setOpen] = useState(false)
  const [muted, setMuted] = useState(isAlertMuted())
  const [readBusy, setReadBusy] = useState(false)
  const [readError, setReadError] = useState('')

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
  const total = alerts.total ?? alerts.items.length

  const openItem = async (item) => {
    setReadError('')
    setReadBusy(true)
    try {
      // 通知中心消息：以服务端 read fact 更新共享 unread projection 后再跳转。
      if (item.type === 'center') {
        await markNotificationRead([item.id])
        if (onNavigate) {
          prepareNotificationRecordFocus(item)
          onNavigate(notificationTargetView(item.target))
        }
        setOpen(false)
        return
      }
      // 工资条：铃铛只负责提醒，点击跳转到「人员管理 → 工资条」板块查看/签收
      if (item.type === 'payroll') {
        if (onNavigate) onNavigate('staff-payroll')
        setOpen(false)
        return
      }
      // 审批中心：标记已读并跳转（按通知类型打开对应列表页）
      if (item.type === 'approval') {
        await markApprovalRead([item.id])
        try {
          // 待审批 → 待我审批；抄送 → 抄送我的；结果 → 我发起的
          const target = item.noticeType === 'todo' ? 'todo' : item.noticeType === 'cc' ? 'cc' : 'my'
          sessionStorage.setItem('budu-approval-scope', target)
        } catch {
          /* 忽略 */
        }
        if (onNavigate) onNavigate('approval')
        setOpen(false)
        return
      }

      markSeen()
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
      setOpen(false)
    } catch (error) {
      setReadError(error?.message || t('标记已读失败，请重试'))
    } finally {
      setReadBusy(false)
    }
  }

  const markAllRead = async () => {
    setReadError('')
    setReadBusy(true)
    try {
      await markAllAlertsRead()
    } catch (error) {
      setReadError(error?.message || t('全部已读失败，请重试'))
    } finally {
      setReadBusy(false)
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

      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[129] bg-transparent" onClick={() => setOpen(false)} />
          <div
            className={`fixed top-[calc(env(safe-area-inset-top)+4.5rem)] z-[130] max-h-[calc(100dvh-env(safe-area-inset-top)-5.5rem)] overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-2xl ${
              isDesktop ? 'right-8 w-80' : 'right-3 w-[calc(100vw-1.5rem)] max-w-80'
            }`}
            role="dialog"
            aria-modal="true"
            aria-label={t('通知')}
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <p className="text-sm font-bold text-slate-800">
                {t('通知')}
                {total > 0 && (
                  <span className="ml-2 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
                    {total}
                  </span>
                )}
              </p>
              {unread > 0 && (
                <button
                  onClick={markAllRead}
                  disabled={readBusy}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-budu-500 transition hover:bg-budu-50"
                >
                  <RefreshCw className={`h-3 w-3 ${readBusy ? 'animate-spin' : ''}`} />
                  {t(readBusy ? '处理中…' : '全部已读')}
                </button>
              )}
            </div>

            {readError && (
              <p role="alert" className="border-b border-rose-100 bg-rose-50 px-4 py-2 text-xs font-medium text-rose-600">
                {readError}
              </p>
            )}

            <div className="max-h-80 overflow-y-auto">
              {alerts.items.length > 0 &&
                alerts.items.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => void openItem(r)}
                    disabled={readBusy}
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
                              : r.type === 'approval'
                                ? 'bg-violet-50 text-violet-600'
                              : r.type === 'center'
                                ? r.priority === 'high'
                                  ? 'bg-rose-50 text-rose-600'
                                  : 'bg-violet-50 text-violet-600'
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
                              : r.type === 'approval'
                                ? '审批'
                              : r.type === 'center'
                                ? r.priority === 'high' ? '重要' : '通知'
                              : r.type === 'transfer'
                                ? '门店调拨'
                                : '采购申请',
                        )}
                      </span>
                      {r.type === 'center'
                        ? r.title || ''
                        : r.type === 'approval'
                          ? r.title
                        : r.type === 'payroll'
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
                      {r.type === 'center'
                        ? r.content || ''
                        : r.type === 'approval'
                          ? r.content
                        : r.type === 'payroll'
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
                                  ? t('调出 {from} → 调入 {to}', {
                                      from: storeLabel(r.fromStoreKey, r.fromStoreName),
                                      to: storeLabel(r.storeKey, r.storeName),
                                    })
                                  : t('采购至 {store}', { store: storeLabel(r.storeKey, r.storeName) })}
                    </p>
                    <p className="mt-0.5 text-[10px] text-slate-300">
                      {r.type === 'asset' || r.type === 'payroll' || r.type === 'center' ? '' : t('由 {name} 提交', { name: r.createdBy })} · {new Date(r.createdAt).toLocaleString()}
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

            {/* 提示音开关 */}
            <div className="border-t border-slate-100">
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
        </>,
        document.body,
      )}
    </div>
  )
}
