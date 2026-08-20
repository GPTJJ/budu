import { useEffect, useState } from 'react'
import {
  BadgePercent,
  BarChart3,
  Boxes,
  ChevronRight,
  CircleCheck,
  ClipboardCheck,
  PackageSearch,
  ShoppingBag,
  Store,
  TriangleAlert,
  WalletCards,
  X,
} from 'lucide-react'
import { api } from '../utils/api'
import { formatMoney } from '../utils/format'
import {
  aggregate,
  allStores,
  kpiCards,
  localEntries,
  pctText,
  ranking,
} from '../utils/selectors'
import {
  ensurePolling,
  getAlerts,
  refreshAlerts,
  subscribe,
} from '../utils/inventoryAlerts'
import { notificationTargetView, prepareApprovalScope } from '../utils/notificationNavigation'
import { getWeekDays } from '../utils/schedule'
import { useI18n } from '../i18n'
import { usePublicMode, useStorePrivacy } from '../visibility'

const SUPER_ROLES = new Set(['developer', 'finance', 'admin'])

function shanghaiToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

function visibleStoresFor(user) {
  const stores = allStores()
  if (SUPER_ROLES.has(user?.role) || user?.role === 'public') return stores
  const allowed = new Set(user?.storeKeys || [])
  return stores.filter((item) => allowed.has(item.key))
}

function periodTitle(month, day, weekStart) {
  const today = shanghaiToday()
  if (weekStart) {
    const dates = getWeekDays(weekStart).map((item) => item.date)
    return dates.includes(today) ? '本周经营' : '周经营'
  }
  if (!day) return '本月经营'
  return `${month}-${day.slice(3)}` === today ? '今日经营' : '当日经营'
}

function comparisonLabel(day, weekStart) {
  if (weekStart) return '较上周'
  return day ? '较上月同日' : '较上月'
}

function MiniTrend({ values, hidden }) {
  if (hidden) return <div className="h-16 rounded-xl bg-slate-50" />
  if (!values || values.length === 0) {
    return <div className="grid h-16 place-items-center text-[11px] text-slate-300">暂无趋势数据</div>
  }
  const width = 320
  const height = 64
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const points = values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width
    const y = height - 7 - ((value - min) / span) * (height - 14)
    return [x, y]
  })
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = values.length > 1 ? `${line} L${width},${height} L0,${height} Z` : ''
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-16 w-full" aria-label="营业趋势">
      <defs>
        <linearGradient id="home-revenue-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#BC4F7E" stopOpacity="0.26" />
          <stop offset="100%" stopColor="#BC4F7E" stopOpacity="0" />
        </linearGradient>
      </defs>
      {area && <path d={area} fill="url(#home-revenue-gradient)" />}
      {values.length > 1 ? (
        <path d={line} fill="none" stroke="#BC4F7E" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <circle cx={points[0][0]} cy={points[0][1]} r="3.5" fill="#BC4F7E" />
      )}
    </svg>
  )
}

function BottomSheet({ title, onClose, children }) {
  useEffect(() => {
    const onKeyDown = (event) => event.key === 'Escape' && onClose()
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]" onClick={onClose} aria-label="关闭" />
      <div className="relative flex max-h-[82dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-[1.75rem] bg-white shadow-2xl sm:rounded-[1.75rem]">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-200 sm:hidden" />
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 className="font-bold text-slate-800">{title}</h3>
          <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 sm:px-5">
          {children}
        </div>
      </div>
    </div>
  )
}

function SectionHeader({ title, action, onAction }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 px-0.5">
      <h2 className="text-[17px] font-bold text-slate-800">{title}</h2>
      {action && (
        <button type="button" onClick={onAction} className="flex min-h-10 items-center gap-0.5 px-1 text-xs font-semibold text-budu-600">
          {action}
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

function OperationsCard({ month, store, day, weekStart }) {
  const { lang, t } = useI18n()
  const isPublic = usePublicMode()
  const isStore = useStorePrivacy()
  const hidden = isPublic || isStore
  const cards = kpiCards(month, store, day, lang, weekStart)
  const income = cards.find((item) => item.key === 'income')
  const orders = cards.find((item) => item.key === 'orders')
  const avgOrder = cards.find((item) => item.key === 'avgOrder')
  const discount = cards.find((item) => item.key === 'discount')
  const productSales = cards.find((item) => item.key === 'dish')
  const monthTotal = aggregate(month, store)
  const changeUp = income?.change == null ? null : income.change >= 0

  return (
    <section className="overflow-hidden rounded-[1.5rem] border border-white/80 bg-white shadow-card">
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[17px] font-bold text-slate-800">{t(periodTitle(month, day, weekStart))}</p>
            <p className="mt-0.5 text-[11px] text-slate-400">{t(income?.note || '')}</p>
          </div>
          <span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${
            hidden || changeUp == null
              ? 'bg-slate-50 text-slate-400'
              : changeUp
                ? 'bg-emerald-50 text-emerald-600'
                : 'bg-rose-50 text-rose-500'
          }`}>
            {hidden ? '—' : `${t(comparisonLabel(day, weekStart))} ${income?.change == null ? '—' : pctText(income.change)}`}
          </span>
        </div>

        <div className="mt-3">
          <p className="whitespace-nowrap text-[32px] font-semibold leading-none tracking-tight tabular-nums text-slate-900 sm:text-4xl">
            {hidden ? '•••' : `¥${income?.value || '0.00'}`}
          </p>
          <p className="mt-1.5 text-xs font-medium text-slate-400">{t('营业收入')}</p>
        </div>

        <div className="mt-4 grid grid-cols-3 divide-x divide-slate-100 rounded-2xl bg-slate-50/80 px-1 py-3">
          {[
            { label: '订单数', value: hidden ? '•••' : `${orders?.value || 0} 单`, icon: ShoppingBag },
            { label: '客单价', value: hidden ? '•••' : `¥${avgOrder?.value || '0.00'}`, icon: WalletCards },
            { label: '优惠金额', value: hidden ? '•••' : `¥${discount?.value || '0.00'}`, icon: BadgePercent },
          ].map((item) => {
            const Icon = item.icon
            return (
              <div key={item.label} className="min-w-0 px-2 text-center">
                <div className="mb-1 flex items-center justify-center gap-1 text-slate-400">
                  <Icon className="h-3.5 w-3.5" />
                  <span className="truncate text-[10px] font-medium">{t(item.label)}</span>
                </div>
                <p className="truncate text-[13px] font-bold tabular-nums text-slate-700">{item.value}</p>
              </div>
            )
          })}
        </div>

        <div className="mt-4 flex items-end justify-between gap-4 border-b border-slate-100 pb-3">
          <div>
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
              <Boxes className="h-3.5 w-3.5" />
              {t('商品销量')}
            </p>
            <p className="mt-1 text-base font-bold tabular-nums text-slate-700">{hidden ? '•••' : `${productSales?.value || 0} 件`}</p>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-medium text-slate-400">{t('本月累计')}</p>
            <p className="mt-1 whitespace-nowrap text-base font-bold tabular-nums text-slate-800">
              {hidden ? '•••' : `¥${formatMoney(monthTotal.inc)}`}
            </p>
          </div>
        </div>

        <div className="pt-2">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
              <BarChart3 className="h-3.5 w-3.5 text-budu-500" />
              {t('营业趋势')}
            </p>
            <p className="text-[10px] text-slate-300">{weekStart ? t('按周') : day ? t('按日') : t('按月')}</p>
          </div>
          <MiniTrend values={income?.spark || []} hidden={hidden} />
        </div>
      </div>
    </section>
  )
}

const TODO_META = {
  approvals: { label: '待审批', icon: ClipboardCheck, active: 'bg-violet-50 text-violet-600' },
  stock: { label: '库存预警', icon: PackageSearch, active: 'bg-amber-50 text-amber-600' },
  missing: { label: '门店待录入', icon: Store, active: 'bg-sky-50 text-sky-600' },
  abnormal: { label: '异常事项', icon: TriangleAlert, active: 'bg-rose-50 text-rose-600' },
}

function TodoGrid({ counts, loading, onOpen }) {
  const { t } = useI18n()
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {Object.entries(TODO_META).map(([key, meta]) => {
        const Icon = meta.icon
        const count = counts[key]
        const active = Number(count) > 0
        return (
          <button
            key={key}
            type="button"
            onClick={() => onOpen(key)}
            className={`flex min-h-[76px] items-center gap-3 rounded-2xl border p-3 text-left transition active:scale-[0.98] ${
              active ? 'border-transparent bg-white shadow-sm' : 'border-slate-100 bg-slate-50/65'
            }`}
          >
            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${active ? meta.active : 'bg-white text-slate-300'}`}>
              <Icon className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0">
              <span className={`block text-lg font-bold leading-none tabular-nums ${active ? 'text-slate-800' : 'text-slate-300'}`}>
                {loading && count == null ? <span className="inline-block h-4 w-7 animate-pulse rounded bg-slate-200" /> : count ?? '—'}
              </span>
              <span className={`mt-1.5 block truncate text-[11px] font-medium ${active ? 'text-slate-500' : 'text-slate-300'}`}>{t(meta.label)}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function ActivityRow({ item, onOpen }) {
  const date = new Date(item.createdAt)
  const time = Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  return (
    <button type="button" onClick={() => onOpen(item)} className="flex w-full items-start gap-3 rounded-xl px-1 py-2.5 text-left transition hover:bg-slate-50 active:bg-slate-50">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.status === 'unread' ? 'bg-budu-500' : 'bg-slate-200'}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-slate-700">{item.title || '系统动态'}</span>
        {item.content && <span className="mt-0.5 block truncate text-[11px] text-slate-400">{item.content}</span>}
      </span>
      <span className="shrink-0 pt-0.5 text-[10px] tabular-nums text-slate-300">{time}</span>
    </button>
  )
}

export default function HomeWorkspace({ month, store, day, weekStart, user, onNavigate, onSelectStore }) {
  const { t } = useI18n()
  const isPublic = usePublicMode()
  const isStorePrivacy = useStorePrivacy()
  const canUseOperations = Boolean(user && user.role !== 'public' && user.role !== 'cashier')
  const [approvalRows, setApprovalRows] = useState(null)
  const [notifications, setNotifications] = useState(null)
  const [approvalError, setApprovalError] = useState(false)
  const [activityError, setActivityError] = useState(false)
  const [alerts, setAlerts] = useState(getAlerts())
  const [sheet, setSheet] = useState(null)

  const authorizedStores = visibleStoresFor(user)
  const missingStores = (() => {
    if (!canUseOperations) return []
    const today = shanghaiToday()
    const prefix = `${today.slice(0, 7)}|`
    const suffix = `|${today.slice(5)}`
    const completed = new Set()
    for (const key of Object.keys(localEntries())) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) completed.add(key.split('|')[1])
    }
    return authorizedStores.filter((item) => !completed.has(item.key))
  })()

  useEffect(() => {
    ensurePolling(user)
    const unsubscribe = subscribe(setAlerts)
    if (canUseOperations) refreshAlerts()
    return unsubscribe
  }, [user?.username, user?.role, user?.assetCenter, JSON.stringify(user?.permissions || [])]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false
    if (!canUseOperations) {
      setApprovalRows([])
      setNotifications([])
      return undefined
    }
    setApprovalRows(null)
    setNotifications(null)
    setApprovalError(false)
    setActivityError(false)
    Promise.allSettled([
      api('/v2/approvals/requests?scope=todo'),
      api('/v2/notifications?limit=50'),
    ]).then(([approvals, activity]) => {
      if (cancelled) return
      if (approvals.status === 'fulfilled') setApprovalRows(Array.isArray(approvals.value?.rows) ? approvals.value.rows : [])
      else {
        setApprovalRows([])
        setApprovalError(true)
      }
      if (activity.status === 'fulfilled') {
        const rows = Array.isArray(activity.value?.rows) ? activity.value.rows : []
        setNotifications([...rows].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))))
      } else {
        setNotifications([])
        setActivityError(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [canUseOperations, user?.username])

  const abnormalRows = (notifications || []).filter(
    (item) => item.status === 'unread'
      && item.priority === 'high'
      && item.templateKey !== 'approval_todo'
      && item.templateKey !== 'stock_low'
      && item.refType !== 'approval',
  )
  const counts = {
    approvals: approvalError ? null : approvalRows?.length,
    stock: Array.isArray(alerts.stock) ? alerts.stock.length : 0,
    missing: missingStores.length,
    abnormal: activityError ? null : abnormalRows.length,
  }
  const storeRows = ranking(month, store, day, weekStart).filter((row) => authorizedStores.some((item) => item.key === row.key))
  const activityRows = (notifications || []).slice(0, 5)

  const openApproval = () => {
    try {
      sessionStorage.setItem('budu-approval-scope', 'todo')
    } catch {
      /* 忽略 */
    }
    setSheet(null)
    onNavigate('approval')
  }

  const openTodo = (key) => {
    if (key === 'approvals') return openApproval()
    if (key === 'stock') {
      setSheet(null)
      return onNavigate('inventory-purchase')
    }
    setSheet(key)
  }

  const openActivity = (item) => {
    if (!item) return
    if (item.status === 'unread') {
      api('/v2/notifications/read', { method: 'POST', body: JSON.stringify({ ids: [item.id] }) }).catch(() => {})
      setNotifications((rows) => (rows || []).map((row) => row.id === item.id ? { ...row, status: 'read' } : row))
    }
    prepareApprovalScope(item)
    const target = notificationTargetView(item.target)
    setSheet(null)
    if (target !== 'overview') onNavigate(target)
  }

  const openStore = (key) => {
    onSelectStore(key)
    onNavigate('analysis')
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      <OperationsCard month={month} store={store} day={day} weekStart={weekStart} />

      <section>
        <SectionHeader title={t('待办事项')} action={t('查看全部')} onAction={() => setSheet('todos')} />
        {canUseOperations ? (
          <TodoGrid counts={counts} loading={approvalRows == null || notifications == null} onOpen={openTodo} />
        ) : (
          <div className="rounded-2xl border border-slate-100 bg-white p-5 text-center text-xs text-slate-300">{t('当前账号无管理待办')}</div>
        )}
      </section>

      <section>
        <SectionHeader title={t('门店经营')} action={t('详情')} onAction={() => onNavigate('analysis')} />
        <div className="overflow-hidden rounded-[1.35rem] border border-slate-100 bg-white px-3 py-1 shadow-sm">
          {isPublic || isStorePrivacy ? (
            <div className="grid min-h-28 place-items-center text-xs text-slate-300">{t(isPublic ? '对外展示模式 · 数据已隐藏' : '门店运营模式 · 经营数据已隐藏')}</div>
          ) : storeRows.length ? (
            storeRows.map((row, index) => {
              const up = row.change == null ? null : row.change >= 0
              const max = Math.max(1, ...storeRows.map((item) => item.income))
              return (
                <button key={row.key} type="button" onClick={() => openStore(row.key)} className="block w-full border-b border-slate-50 px-1 py-3 text-left last:border-b-0 active:bg-slate-50">
                  <div className="flex items-center gap-3">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-budu-50 text-xs font-bold text-budu-600">{index + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-slate-700">{row.name}</span>
                      <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <span className="block h-full rounded-full bg-budu-400" style={{ width: `${Math.max(4, (row.income / max) * 100)}%` }} />
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block whitespace-nowrap text-[13px] font-bold tabular-nums text-slate-800">¥{formatMoney(row.income)}</span>
                      <span className={`mt-0.5 block text-[10px] font-semibold ${up == null ? 'text-slate-300' : up ? 'text-emerald-600' : 'text-rose-500'}`}>
                        {row.change == null ? '—' : pctText(row.change)}
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
                  </div>
                </button>
              )
            })
          ) : (
            <div className="grid min-h-28 place-items-center text-xs text-slate-300">{t('暂无门店经营数据')}</div>
          )}
        </div>
      </section>

      <section>
        <SectionHeader title={t('最近动态')} action={t('查看全部')} onAction={() => setSheet('activity')} />
        <div className="overflow-hidden rounded-[1.35rem] border border-slate-100 bg-white px-3 py-1 shadow-sm">
          {notifications == null ? (
            <div className="space-y-3 p-3">
              {[1, 2, 3].map((item) => <div key={item} className="h-10 animate-pulse rounded-xl bg-slate-100" />)}
            </div>
          ) : activityRows.length ? (
            activityRows.map((item) => <ActivityRow key={item.id} item={item} onOpen={openActivity} />)
          ) : (
            <div className="grid min-h-28 place-items-center text-xs text-slate-300">
              {activityError ? t('动态加载失败，请稍后刷新') : t('暂无最近动态')}
            </div>
          )}
        </div>
      </section>

      {sheet && (
        <BottomSheet
          title={t(sheet === 'activity' ? '全部动态' : sheet === 'missing' ? '待录入门店' : sheet === 'abnormal' ? '异常事项' : '待办详情')}
          onClose={() => setSheet(null)}
        >
          {sheet === 'activity' && (
            <div className="divide-y divide-slate-50">
              {(notifications || []).map((item) => <ActivityRow key={item.id} item={item} onOpen={openActivity} />)}
              {!notifications?.length && <p className="py-10 text-center text-sm text-slate-300">{t('暂无最近动态')}</p>}
            </div>
          )}
          {sheet === 'missing' && (
            <div className="space-y-2">
              {missingStores.map((item) => (
                <div key={item.key} className="flex items-center gap-3 rounded-2xl bg-sky-50/70 p-3">
                  <Store className="h-5 w-5 text-sky-500" />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700">{item.name}</span>
                  <span className="text-xs text-sky-600">{t('今日待录入')}</span>
                </div>
              ))}
              {!missingStores.length && (
                <div className="py-10 text-center">
                  <CircleCheck className="mx-auto h-8 w-8 text-emerald-400" />
                  <p className="mt-2 text-sm text-slate-400">{t('今日门店均已完成录入')}</p>
                </div>
              )}
              <button type="button" onClick={() => { setSheet(null); onNavigate('store-entry') }} className="mt-3 w-full rounded-2xl bg-budu-500 py-3 text-sm font-semibold text-white">
                {t('进入业绩录入')}
              </button>
            </div>
          )}
          {sheet === 'abnormal' && (
            <div className="divide-y divide-slate-50">
              {abnormalRows.map((item) => <ActivityRow key={item.id} item={item} onOpen={openActivity} />)}
              {!abnormalRows.length && <p className="py-10 text-center text-sm text-slate-300">{t('暂无异常事项')}</p>}
            </div>
          )}
          {sheet === 'todos' && (
            <div className="space-y-2.5">
              {Object.entries(TODO_META).map(([key, meta]) => {
                const Icon = meta.icon
                return (
                  <button key={key} type="button" onClick={() => openTodo(key)} className="flex min-h-14 w-full items-center gap-3 rounded-2xl bg-slate-50 px-3 text-left active:bg-slate-100">
                    <span className={`grid h-9 w-9 place-items-center rounded-xl ${meta.active}`}><Icon className="h-[18px] w-[18px]" /></span>
                    <span className="flex-1 text-sm font-semibold text-slate-700">{t(meta.label)}</span>
                    <span className="font-bold tabular-nums text-slate-700">{counts[key] ?? '—'}</span>
                    <ChevronRight className="h-4 w-4 text-slate-300" />
                  </button>
                )
              })}
            </div>
          )}
        </BottomSheet>
      )}
    </div>
  )
}
