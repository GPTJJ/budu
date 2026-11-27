import { useEffect, useMemo, useState } from 'react'
import {
  BadgePercent,
  BarChart3,
  Boxes,
  ChartNoAxesCombined,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  ClipboardCheck,
  Eye,
  FileText,
  FolderArchive,
  Gift,
  Handshake,
  LayoutGrid,
  Layers,
  Lock,
  PackageSearch,
  Search,
  Settings,
  ShieldAlert,
  ShoppingBag,
  Store,
  TriangleAlert,
  Users,
  Wallet,
  WalletCards,
  Warehouse,
  X,
} from 'lucide-react'
import {
  MODULE_KEYS,
  SWEET_CARD_CAPABILITIES,
  hasModuleAccess,
  hasPageAccess,
  hasSweetCardCapability,
  isSuperUser,
} from '../../shared/accountPermissions'
import useOperatingStores from '../hooks/useOperatingStores'
import { api } from '../utils/api'
import { formatMoney } from '../utils/format'
import {
  ensurePolling,
  getAlerts,
  refreshAlerts,
  subscribe,
} from '../utils/inventoryAlerts'
import { notificationTargetView, prepareApprovalScope } from '../utils/notificationNavigation'
import {
  calcTargetProgressPct,
  maskSensitiveAmounts,
  periodTargetTotal,
} from '../utils/privacyMask'
import { getWeekDays } from '../utils/schedule'
import {
  aggregate,
  allStores,
  getPosDaily,
  kpiCards,
  localEntries,
  pctText,
  periodStats,
  ranking,
} from '../utils/selectors'
import { storeVisibleInOperatingPeriod } from '../utils/storeOperations'
import { t } from '../utils/text'
import { usePrivacyMode, usePublicMode, useStorePrivacy } from '../visibility'

const SUPER_ROLES = new Set(['developer', 'finance', 'admin'])

// 与服务端 requireCatalogManager 及 Sidebar 保持一致的线上目录入口可见性
const canManageOnlineCatalog = (user) =>
  Boolean(
    isSuperUser(user) ||
      (user?.role === 'manager' &&
        user?.status !== 'disabled' &&
        hasModuleAccess(user, MODULE_KEYS.PRODUCT_CENTER)),
  )

const WORKBENCH_GROUPS = [
  {
    key: 'daily',
    label: '日常运营',
    items: [
      {
        key: 'store',
        label: '门店经营',
        icon: Store,
        tone: 'bg-budu-50 text-budu-600',
        groupKeys: [
          MODULE_KEYS.STORE_ENTRY,
          MODULE_KEYS.STORE_SCHEDULE,
          MODULE_KEYS.STORE_MAILING,
          MODULE_KEYS.STORE_POS,
          MODULE_KEYS.PRODUCT_CENTER,
          MODULE_KEYS.PRODUCT_MATERIAL_MANAGEMENT,
        ],
        subs: [
          { key: 'store-entry', label: '门店业绩录入' },
          { key: 'store-schedule', label: '门店排班' },
          { key: 'store-mailing', label: '门店邮寄' },
          { key: 'store-pos', label: 'POS 点单' },
          { key: 'product-center', label: '商品中心' },
          { key: 'online-catalog', label: '小程序管理台', href: '/mini-program' },
        ],
      },
      {
        key: 'inventory',
        label: '库存调拨',
        icon: Warehouse,
        tone: 'bg-amber-50 text-amber-600',
        groupKeys: [MODULE_KEYS.INVENTORY_TRANSFER, MODULE_KEYS.INVENTORY_PURCHASE],
        subs: [
          { key: 'inventory-transfer', label: '门店调拨' },
          { key: 'inventory-purchase', label: '采购入库' },
        ],
      },
      {
        key: 'staff',
        label: '人员管理',
        icon: Users,
        tone: 'bg-sky-50 text-sky-600',
        groupKeys: [MODULE_KEYS.STAFF, MODULE_KEYS.STAFF_PAYROLL, MODULE_KEYS.EMPLOYEE_PROFILE],
        subs: [
          { key: 'staff', label: '雇员' },
          { key: 'staff-payroll', label: '工资条' },
          { key: 'employee-profile', label: '员工档案' },
        ],
      },
      {
        key: 'approval',
        label: '审批中心',
        icon: ClipboardCheck,
        tone: 'bg-violet-50 text-violet-600',
      },
    ],
  },
  {
    key: 'business',
    label: '业务与卡券',
    items: [
      {
        key: 'finance-invoice',
        label: '发票开具',
        icon: FileText,
        tone: 'bg-emerald-50 text-emerald-600',
      },
      {
        key: 'sweet-card',
        label: 'budu 甜意卡',
        icon: Gift,
        tone: 'bg-pink-50 text-budu-600',
      },
      {
        key: 'partner-management',
        label: '合作商管理',
        icon: Handshake,
        tone: 'bg-indigo-50 text-indigo-600',
        groupKeys: [MODULE_KEYS.PARTNER_MANAGEMENT, MODULE_KEYS.PARTNER_REPLENISHMENT_REVIEW],
        subs: [
          { key: 'partner-management', label: '合作商档案' },
          { key: 'partner-replenishment-review', label: '补货订单' },
          { key: 'partner-after-sales', label: '售后处理', moduleKey: 'partner-management' },
        ],
      },
      {
        key: 'asset-center',
        label: 'budu档案馆',
        icon: FolderArchive,
        tone: 'bg-orange-50 text-orange-600',
      },
    ],
  },
  {
    key: 'data-system',
    label: '数据与系统',
    items: [
      {
        key: 'analysis',
        label: '经营分析',
        icon: ChartNoAxesCombined,
        tone: 'bg-budu-50 text-budu-600',
        sensitive: true,
      },
      {
        key: 'finance',
        label: '报表中心',
        icon: Wallet,
        tone: 'bg-rose-50 text-rose-600',
        sensitive: true,
      },
      {
        key: 'settings',
        label: '系统设置',
        icon: Settings,
        tone: 'bg-slate-100 text-slate-600',
      },
    ],
  },
]

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
    return dates.includes(today) ? '本周经营状态' : '周经营状态'
  }
  if (!day) return '本月经营状态'
  return `${month}-${day.slice(-2)}` === today ? '今日经营状态' : '当日经营状态'
}

function safePeriodSubtitle(month, day, weekStart) {
  if (weekStart) return `自然周 ${weekStart} 起 · 无金额脱敏视图`
  if (day) return `日期 ${month}-${String(day).slice(-2)} · 实时经营脉搏`
  return `${month} 整月周期汇总`
}

function comparisonLabel(day, weekStart) {
  if (weekStart) return '较上周'
  return day ? '较上月同日' : '较上月'
}

function enteredStoreSetOnDate(dateStr) {
  const set = new Set()
  if (!dateStr || dateStr.length < 10) return set
  const prefix = `${dateStr.slice(0, 7)}|`
  const suffix = `|${dateStr.slice(5)}`
  for (const key of Object.keys(localEntries())) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      set.add(key.split('|')[1])
    }
  }
  for (const row of getPosDaily()) {
    if (String(row.date || '') === dateStr && (Number(row.orderCount) > 0 || Number(row.paidCents) > 0)) {
      set.add(row.storeKey)
    }
  }
  return set
}

function resolveWorkbenchItem(item, user) {
  if (item.key === MODULE_KEYS.SWEET_CARD) {
    if (!hasModuleAccess(user, item.key) || !hasSweetCardCapability(user, SWEET_CARD_CAPABILITIES.VIEW)) return null
    return { ...item, subs: [] }
  }
  if (item.groupKeys) {
    const allowedGroup =
      item.groupKeys.some((key) => hasModuleAccess(user, key)) ||
      (item.key === 'store' && canManageOnlineCatalog(user))
    if (!allowedGroup) return null
    const subs = (item.subs || []).filter((sub) =>
      sub.href ? canManageOnlineCatalog(user) : hasPageAccess(user, sub.moduleKey || sub.key),
    )
    if (subs.length === 0) return null
    return { ...item, subs }
  }
  if (!hasModuleAccess(user, item.key)) return null
  return { ...item, subs: [] }
}

function MiniTrend({ values, hidden }) {
  if (hidden) return <div className="h-11 rounded-xl bg-slate-50" />
  if (!values || values.length === 0) {
    return <div className="grid h-11 place-items-center text-[11px] text-slate-300">暂无趋势数据</div>
  }
  const width = 320
  const height = 44
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const points = values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width
    const y = height - 6 - ((value - min) / span) * (height - 12)
    return [x, y]
  })
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = values.length > 1 ? `${line} L${width},${height} L0,${height} Z` : ''
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-11 w-full" aria-label="营业趋势">
      <defs>
        <linearGradient id="home-revenue-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#BC4F7E" stopOpacity="0.24" />
          <stop offset="100%" stopColor="#BC4F7E" stopOpacity="0" />
        </linearGradient>
      </defs>
      {area && <path d={area} fill="url(#home-revenue-gradient)" />}
      {values.length > 1 ? (
        <path d={line} fill="none" stroke="#BC4F7E" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <circle cx={points[0][0]} cy={points[0][1]} r="3" fill="#BC4F7E" />
      )}
    </svg>
  )
}

function BottomSheet({ title, onClose, children }) {
  useEffect(() => {
    const onKeyDown = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div className="budu-overlay-viewport fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="budu-overlay-backdrop absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]" onClick={onClose} aria-label="关闭" />
      <div className="budu-overlay-panel relative flex max-h-[82dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-[1.75rem] bg-white shadow-2xl sm:rounded-[1.75rem]">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-200 sm:hidden" />
        <div className="budu-overlay-header flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 className="font-bold text-slate-800">{title}</h3>
          <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="budu-overlay-scroll px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 sm:px-5">
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

function OperationsCard({ month, store, day, weekStart, periodStores }) {
  const isPublic = usePublicMode()
  const isStore = useStorePrivacy()
  const { effectivePrivacy, isLockedByRole } = usePrivacyMode()
  const [peeking, setPeeking] = useState(false)

  const roleRestricted = Boolean(isPublic || isStore || isLockedByRole)

  useEffect(() => {
    if (roleRestricted || !effectivePrivacy) {
      setPeeking(false)
    }
  }, [roleRestricted, effectivePrivacy])

  useEffect(() => {
    if (!peeking || typeof window === 'undefined') return undefined
    const stopPeek = () => setPeeking(false)
    const onVisibilityChange = () => setPeeking(false)
    window.addEventListener('blur', stopPeek)
    window.addEventListener('pagehide', stopPeek)
    window.addEventListener('pointerup', stopPeek)
    window.addEventListener('pointercancel', stopPeek)
    window.addEventListener('touchend', stopPeek)
    window.addEventListener('touchcancel', stopPeek)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    return () => {
      window.removeEventListener('blur', stopPeek)
      window.removeEventListener('pagehide', stopPeek)
      window.removeEventListener('pointerup', stopPeek)
      window.removeEventListener('pointercancel', stopPeek)
      window.removeEventListener('touchend', stopPeek)
      window.removeEventListener('touchcancel', stopPeek)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    }
  }, [peeking])

  const revealAmounts = !roleRestricted && (!effectivePrivacy || peeking)

  const cards = kpiCards(month, store, day, weekStart)
  const income = cards.find((item) => item.key === 'income')
  const orders = cards.find((item) => item.key === 'orders')
  const avgOrder = cards.find((item) => item.key === 'avgOrder')
  const discount = cards.find((item) => item.key === 'discount')
  const productSales = cards.find((item) => item.key === 'dish')
  const monthTotal = aggregate(month, store)
  const changeUp = income?.change == null ? null : income.change >= 0

  // 严格按在营期间可见门店（剔除已闭店门店）计算录入进度分母与目标汇总
  const scopedStores = useMemo(() => {
    if (!periodStores?.length) return []
    if (store === 'all') return periodStores
    return periodStores.filter((item) => item.key === store)
  }, [periodStores, store])

  const activeDate = day ? `${month}-${String(day).slice(-2)}` : shanghaiToday()
  const enteredSet = enteredStoreSetOnDate(activeDate)
  const enteredCount = scopedStores.filter((item) => enteredSet.has(item.key)).length

  const configuredStores = useMemo(
    () => scopedStores.filter((item) => periodTargetTotal([item.key], month, day, weekStart) != null),
    [scopedStores, month, day, weekStart],
  )

  const actualIncome = useMemo(() => {
    const targetPool = configuredStores.length ? configuredStores : scopedStores
    if (targetPool.length === 0) return 0
    return targetPool.reduce((sum, item) => sum + periodStats(month, item.key, day, weekStart).inc, 0)
  }, [month, day, weekStart, configuredStores, scopedStores])

  const targetTotal = useMemo(
    () => periodTargetTotal(
      configuredStores.map((item) => item.key),
      month,
      day,
      weekStart,
    ),
    [configuredStores, month, day, weekStart],
  )
  const targetPct = calcTargetProgressPct(actualIncome, targetTotal)
  const progressBarWidth = roleRestricted || targetPct == null
    ? 0
    : Math.min(100, Math.max(actualIncome > 0 ? 4 : 0, targetPct))
  const targetLabel = weekStart ? '本周目标达成率' : day ? '今日目标达成率' : '本月目标达成率'

  return (
    <section
      data-testid="operations-status-card"
      className="overflow-hidden rounded-[1.5rem] border border-white/80 bg-white shadow-card"
    >
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0">
            <p className="truncate text-[17px] font-bold text-slate-800">{t(periodTitle(month, day, weekStart))}</p>
            <p className="mt-0.5 truncate text-[11px] text-slate-400">
              {revealAmounts ? t(income?.note || '') : safePeriodSubtitle(month, day, weekStart)}
            </p>
          </div>
          <span
            className={`shrink-0 rounded-lg px-2 py-1 text-[11px] font-semibold ${
              !revealAmounts
                ? 'bg-budu-50 text-budu-600'
                : changeUp == null
                  ? 'bg-slate-50 text-slate-400'
                  : changeUp
                    ? 'bg-emerald-50 text-emerald-600'
                    : 'bg-rose-50 text-rose-500'
            }`}
          >
            {!revealAmounts
              ? t('防窥保护中')
              : `${t(comparisonLabel(day, weekStart))} ${income?.change == null ? '—' : pctText(income.change)}`}
          </span>
        </div>

        {/* 默认可见核心状态：录入进度 / 订单数 / 商品销量 */}
        <div className="mt-3 grid grid-cols-3 divide-x divide-slate-100 rounded-2xl bg-slate-50/85 px-1 py-2.5">
          {[
            {
              label: '门店录入',
              value: roleRestricted ? '•••' : `${enteredCount}/${scopedStores.length} 已录入`,
              icon: Store,
            },
            {
              label: '订单数',
              value: roleRestricted ? '•••' : `${orders?.value || 0} 单`,
              icon: ShoppingBag,
            },
            {
              label: '商品销量',
              value: roleRestricted ? '•••' : `${productSales?.value || 0} 件`,
              icon: Boxes,
            },
          ].map((item) => {
            const Icon = item.icon
            return (
              <div key={item.label} className="min-w-0 px-2 text-center">
                <div className="mb-1 flex items-center justify-center gap-1 text-slate-400">
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate text-[10px] font-medium">{t(item.label)}</span>
                </div>
                <p className="truncate text-[13px] font-bold tabular-nums text-slate-700">{item.value}</p>
              </div>
            )
          })}
        </div>

        {/* 无金额刻度的目标达成率进度条 */}
        <div className="mt-3">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-medium text-slate-500">{t(targetLabel)}</span>
            <span className="font-bold tabular-nums text-budu-600">
              {roleRestricted ? '•••' : targetPct == null ? t('未设目标') : `${targetPct}%`}
            </span>
          </div>
          <div
            className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100"
            role="progressbar"
            aria-label={t(targetLabel)}
            aria-valuenow={roleRestricted || targetPct == null ? 0 : targetPct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-budu-400 to-budu-500 transition-all duration-300"
              style={{ width: `${progressBarWidth}%` }}
            />
          </div>
        </div>

        {/* 隐藏 Y 轴金额数值的极简营业趋势曲线 */}
        <div className="mt-3 border-t border-slate-100 pt-2.5">
          <div className="mb-1 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
              <BarChart3 className="h-3.5 w-3.5 text-budu-500" />
              {t('营业趋势')}
            </p>
            <p className="text-[10px] text-slate-300">{weekStart ? t('按周 · 无刻度') : day ? t('按日 · 无刻度') : t('按月 · 无刻度')}</p>
          </div>
          <MiniTrend values={income?.spark || []} hidden={roleRestricted} />
        </div>

        {/* 防窥隐藏区 / 按住偷看业绩触发条 */}
        {roleRestricted ? (
          <div className="mt-2.5 flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50/80 px-3.5 py-2.5 text-xs text-slate-400">
            <span className="truncate">{t('营业收入 · 客单价 · 优惠金额 · 本月累计')}</span>
            <span className="shrink-0 font-bold tracking-widest text-slate-400">••••</span>
          </div>
        ) : effectivePrivacy ? (
          <button
            type="button"
            data-testid="peek-revenue-btn"
            onPointerDown={(event) => {
              if (event.button != null && event.button !== 0) return
              setPeeking(true)
            }}
            onPointerUp={() => setPeeking(false)}
            onPointerLeave={() => setPeeking(false)}
            onPointerOut={(event) => {
              if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget)) {
                setPeeking(false)
              }
            }}
            onPointerCancel={() => setPeeking(false)}
            onContextMenu={(event) => event.preventDefault()}
            className={`budu-no-callout mt-2.5 flex w-full select-none touch-manipulation items-center justify-between gap-2 rounded-2xl border px-3.5 py-2.5 text-left transition ${
              peeking
                ? 'border-budu-300 bg-budu-50 text-budu-700 shadow-sm'
                : 'border-budu-100/90 bg-budu-50/45 text-slate-600 hover:border-budu-200 hover:bg-budu-50/80'
            }`}
          >
            <span className="pointer-events-none flex min-w-0 items-center gap-2">
              <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-xl ${peeking ? 'bg-budu-500 text-white' : 'bg-white text-budu-500 shadow-subtle'}`}>
                <Eye className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-bold text-slate-800">
                  {peeking ? t('松开立即隐藏业绩') : t('按住偷看业绩')}
                </span>
                <span className="block truncate text-[10px] text-slate-400">
                  {t('营业收入 · 客单价 · 优惠金额 · 本月累计')}
                </span>
              </span>
            </span>
            <span className="pointer-events-none shrink-0 rounded-lg bg-white/90 px-2 py-1 text-xs font-bold tracking-widest text-budu-600">
              {peeking ? t('预览中') : '••••'}
            </span>
          </button>
        ) : null}

        {/* 明文态或按住偷看时展开核心金额指标 */}
        {revealAmounts && (
          <div
            data-testid="revenue-details-panel"
            className="mt-3 rounded-2xl border border-budu-100/80 bg-gradient-to-br from-budu-50/45 via-white to-slate-50/70 p-3.5"
          >
            <div className="flex items-baseline justify-between gap-2">
              <div>
                <p className="text-[11px] font-medium text-slate-400">{t('营业收入')}</p>
                <p className="mt-1 whitespace-nowrap text-2xl font-bold leading-none tracking-tight tabular-nums text-slate-900 sm:text-[28px]">
                  ¥{income?.value || '0.00'}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[11px] font-medium text-slate-400">{t('本月累计')}</p>
                <p className="mt-1 whitespace-nowrap text-sm font-bold tabular-nums text-slate-800">
                  ¥{formatMoney(monthTotal.inc)}
                </p>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-slate-100 pt-2.5">
              <div className="flex items-center justify-between rounded-xl bg-white/90 px-2.5 py-2">
                <span className="flex items-center gap-1 text-[11px] text-slate-400">
                  <WalletCards className="h-3.5 w-3.5 text-budu-400" />
                  {t('客单价')}
                </span>
                <span className="text-xs font-bold tabular-nums text-slate-700">¥{avgOrder?.value || '0.00'}</span>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-white/90 px-2.5 py-2">
                <span className="flex items-center gap-1 text-[11px] text-slate-400">
                  <BadgePercent className="h-3.5 w-3.5 text-budu-400" />
                  {t('优惠金额')}
                </span>
                <span className="text-xs font-bold tabular-nums text-slate-700">¥{discount?.value || '0.00'}</span>
              </div>
            </div>
          </div>
        )}
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

function WorkbenchTile({ item, effectivePrivacy, onSelect }) {
  const Icon = item.icon
  const hasSubmenu = item.subs && item.subs.length > 0
  const showLock = Boolean(item.sensitive && effectivePrivacy)

  return (
    <button
      type="button"
      data-testid={`workbench-item-${item.key}`}
      onClick={() => onSelect(item)}
      className="group relative flex flex-col items-center justify-start rounded-2xl px-1.5 py-2.5 text-center transition hover:bg-slate-50 active:scale-[0.97] active:bg-slate-100/70"
    >
      <span className={`relative grid h-11 w-11 place-items-center rounded-2xl transition group-hover:scale-[1.03] ${item.tone}`}>
        <Icon className="h-5 w-5" />
        {showLock && (
          <span
            data-testid={`sensitive-lock-${item.key}`}
            title={t('防窥保护中，点击需二次确认')}
            className="absolute -right-1 -top-1 grid h-4 w-4 place-items-center rounded-full bg-budu-500 text-white ring-2 ring-white"
          >
            <Lock className="h-2.5 w-2.5" />
          </span>
        )}
        {hasSubmenu && !showLock && (
          <span
            title={t('点击展开子菜单')}
            className="absolute -bottom-1 -right-1 grid h-4 w-4 place-items-center rounded-full bg-white text-slate-400 shadow-sm ring-1 ring-slate-200/80"
          >
            <ChevronDown className="h-2.5 w-2.5" />
          </span>
        )}
      </span>
      <span className="mt-1.5 line-clamp-2 w-full text-[11px] font-semibold leading-tight text-slate-700 sm:text-xs">
        {t(item.label)}
      </span>
    </button>
  )
}

function WorkbenchSection({ user, effectivePrivacy, onActivateItem, onDirectSubNavigate }) {
  const [layout, setLayout] = useState('grouped')
  const [keyword, setKeyword] = useState('')

  const authorizedGroups = useMemo(() => {
    return WORKBENCH_GROUPS.map((group) => ({
      ...group,
      items: group.items.map((item) => resolveWorkbenchItem(item, user)).filter(Boolean),
    })).filter((group) => group.items.length > 0)
  }, [user])

  const normalizedQuery = keyword.trim().toLowerCase()

  const filteredGroups = useMemo(() => {
    if (!normalizedQuery) return authorizedGroups
    return authorizedGroups
      .map((group) => {
        const groupMatch = group.label.toLowerCase().includes(normalizedQuery)
        const items = group.items.filter((item) => {
          if (groupMatch) return true
          if (item.label.toLowerCase().includes(normalizedQuery)) return true
          return (item.subs || []).some((sub) => sub.label.toLowerCase().includes(normalizedQuery))
        })
        return { ...group, items }
      })
      .filter((group) => group.items.length > 0)
  }, [authorizedGroups, normalizedQuery])

  const matchedSubShortcuts = useMemo(() => {
    if (!normalizedQuery) return []
    const list = []
    for (const group of authorizedGroups) {
      for (const item of group.items) {
        for (const sub of item.subs || []) {
          if (sub.label.toLowerCase().includes(normalizedQuery)) {
            list.push({ ...sub, parentLabel: item.label })
          }
        }
      }
    }
    return list
  }, [authorizedGroups, normalizedQuery])

  if (authorizedGroups.length === 0) return null

  const flatItems = filteredGroups.flatMap((group) => group.items)

  return (
    <section data-testid="home-workbench">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-0.5">
        <h2 className="text-[17px] font-bold text-slate-800">{t('功能工作台')}</h2>
        <div className="inline-flex items-center rounded-xl border border-slate-200/80 bg-white p-0.5 shadow-subtle">
          <button
            type="button"
            data-testid="workbench-mode-grouped"
            onClick={() => setLayout('grouped')}
            className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
              layout === 'grouped' ? 'bg-budu-50 text-budu-700' : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <Layers className="h-3 w-3" />
            {t('分组')}
          </button>
          <button
            type="button"
            data-testid="workbench-mode-grid"
            onClick={() => setLayout('grid')}
            className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
              layout === 'grid' ? 'bg-budu-50 text-budu-700' : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <LayoutGrid className="h-3 w-3" />
            {t('宫格')}
          </button>
        </div>
      </div>

      {/* 轻量关键词过滤 */}
      <div className="mb-2.5 flex items-center gap-2 rounded-2xl border border-slate-200/70 bg-white px-3 py-2 shadow-subtle">
        <Search className="h-4 w-4 shrink-0 text-slate-400" />
        <input
          type="text"
          data-testid="workbench-search-input"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={t('搜索功能或子菜单（如排班、甜意卡、小程序）')}
          className="min-w-0 flex-1 bg-transparent text-xs text-slate-700 placeholder:text-slate-300 outline-none sm:text-[13px]"
        />
        {keyword && (
          <button
            type="button"
            onClick={() => setKeyword('')}
            aria-label={t('清空搜索')}
            className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-400 hover:text-slate-600"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {matchedSubShortcuts.length > 0 && (
        <div className="mb-2.5 flex flex-wrap items-center gap-1.5 px-0.5">
          <span className="text-[11px] text-slate-400">{t('匹配子菜单：')}</span>
          {matchedSubShortcuts.map((sub) =>
            sub.href ? (
              <a
                key={sub.key}
                href={sub.href}
                className="inline-flex items-center gap-1 rounded-full border border-budu-200 bg-budu-50/70 px-2.5 py-1 text-[11px] font-semibold text-budu-700 no-underline transition hover:bg-budu-100"
              >
                <span>{t(sub.label)}</span>
                <ChevronRight className="h-3 w-3" />
              </a>
            ) : (
              <button
                key={sub.key}
                type="button"
                onClick={() => onDirectSubNavigate(sub.key)}
                className="inline-flex items-center gap-1 rounded-full border border-budu-200 bg-budu-50/70 px-2.5 py-1 text-[11px] font-semibold text-budu-700 transition hover:bg-budu-100"
              >
                <span>{t(sub.label)}</span>
                <ChevronRight className="h-3 w-3" />
              </button>
            ),
          )}
        </div>
      )}

      {flatItems.length === 0 ? (
        <div className="rounded-[1.35rem] border border-slate-100 bg-white py-8 text-center text-xs text-slate-300 shadow-sm">
          {t('未找到匹配的功能入口')}
        </div>
      ) : layout === 'grid' ? (
        <div
          data-testid="workbench-compact-grid"
          className="grid grid-cols-4 gap-y-1 rounded-[1.35rem] border border-slate-100 bg-white p-2.5 shadow-sm max-[339px]:grid-cols-3 sm:grid-cols-6"
        >
          {flatItems.map((item) => (
            <WorkbenchTile
              key={item.key}
              item={item}
              effectivePrivacy={effectivePrivacy}
              onSelect={onActivateItem}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-2.5">
          {filteredGroups.map((group) => (
            <div
              key={group.key}
              className="overflow-hidden rounded-[1.35rem] border border-slate-100 bg-white px-2.5 pb-2 pt-3 shadow-sm"
            >
              <p className="mb-1 px-2 text-[11px] font-bold tracking-wide text-slate-400">{t(group.label)}</p>
              <div className="grid grid-cols-4 gap-y-1 max-[339px]:grid-cols-3 sm:grid-cols-4">
                {group.items.map((item) => (
                  <WorkbenchTile
                    key={item.key}
                    item={item}
                    effectivePrivacy={effectivePrivacy}
                    onSelect={onActivateItem}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function ActivityRow({ item, masked, onOpen }) {
  const date = new Date(item.createdAt)
  const time = Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  const displayTitle = maskSensitiveAmounts(item.title || '系统动态', masked)
  const displayContent = item.content ? maskSensitiveAmounts(item.content, masked) : ''

  return (
    <button type="button" onClick={() => onOpen(item)} className="flex w-full items-start gap-3 rounded-xl px-1 py-2.5 text-left transition hover:bg-slate-50 active:bg-slate-50">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.status === 'unread' ? 'bg-budu-500' : 'bg-slate-200'}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-slate-700">{displayTitle}</span>
        {displayContent && <span className="mt-0.5 block truncate text-[11px] text-slate-400">{displayContent}</span>}
      </span>
      <span className="shrink-0 pt-0.5 text-[10px] tabular-nums text-slate-300">{time}</span>
    </button>
  )
}

export default function HomeWorkspace({ month, store, day, weekStart, user, onNavigate, onSelectStore }) {
  const isPublic = usePublicMode()
  const isStorePrivacy = useStorePrivacy()
  const { effectivePrivacy } = usePrivacyMode()
  const canUseOperations = Boolean(user && user.role !== 'public' && user.role !== 'cashier')
  const [approvalRows, setApprovalRows] = useState(null)
  const [notifications, setNotifications] = useState(null)
  const [approvalError, setApprovalError] = useState(false)
  const [activityError, setActivityError] = useState(false)
  const [alerts, setAlerts] = useState(getAlerts())
  const [sheet, setSheet] = useState(null)
  const [submenuGroup, setSubmenuGroup] = useState(null)
  const [sensitiveConfirm, setSensitiveConfirm] = useState(null)

  const operating = useOperatingStores()
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
    return authorizedStores.filter(
      (item) => operating.some((operatingStore) => operatingStore.key === item.key) && !completed.has(item.key),
    )
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

  const firstPeriodDate = weekStart || (day ? `${month}-${String(day).slice(-2)}` : `${month}-01`)
  const monthParts = String(month || '').split('-').map(Number)
  const daysInMonth = monthParts[0] && monthParts[1] ? new Date(monthParts[0], monthParts[1], 0).getDate() : 30
  const lastPeriodDate = weekStart
    ? getWeekDays(weekStart).at(-1).date
    : day
      ? firstPeriodDate
      : `${month}-${String(daysInMonth).padStart(2, '0')}`
  const periodStores = authorizedStores.filter((item) =>
    storeVisibleInOperatingPeriod(item, firstPeriodDate, lastPeriodDate),
  )

  const storeRows = ranking(month, store, day, weekStart).filter((row) =>
    periodStores.some((item) => item.key === row.key),
  )
  const activityRows = (notifications || []).slice(0, 5)
  const activeDate = day ? `${month}-${String(day).slice(-2)}` : shanghaiToday()
  const activeEnteredStores = enteredStoreSetOnDate(activeDate)

  const navigateGuardedSensitive = (targetKey, label, beforeNavigate) => {
    if (effectivePrivacy && (targetKey === 'analysis' || targetKey === 'finance')) {
      setSensitiveConfirm({ targetKey, label, beforeNavigate })
      return
    }
    if (beforeNavigate) beforeNavigate()
    onNavigate(targetKey)
  }

  const handleWorkbenchActivate = (item) => {
    if (item.subs && item.subs.length > 0) {
      setSubmenuGroup(item)
      return
    }
    if (item.sensitive) {
      navigateGuardedSensitive(item.key, item.label)
      return
    }
    onNavigate(item.key)
  }

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
    if (target !== 'overview') {
      if (target === 'analysis' || target === 'finance') {
        navigateGuardedSensitive(target, target === 'finance' ? '报表中心' : '经营分析')
      } else {
        onNavigate(target)
      }
    }
  }

  const openStore = (key) => {
    navigateGuardedSensitive('analysis', '经营分析', () => onSelectStore(key))
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      <OperationsCard
        month={month}
        store={store}
        day={day}
        weekStart={weekStart}
        periodStores={periodStores}
      />

      <section>
        <SectionHeader title={t('待办事项')} action={t('查看全部')} onAction={() => setSheet('todos')} />
        {canUseOperations ? (
          <TodoGrid counts={counts} loading={approvalRows == null || notifications == null} onOpen={openTodo} />
        ) : (
          <div className="rounded-2xl border border-slate-100 bg-white p-5 text-center text-xs text-slate-300">{t('当前账号无管理待办')}</div>
        )}
      </section>

      <WorkbenchSection
        user={user}
        effectivePrivacy={effectivePrivacy}
        onActivateItem={handleWorkbenchActivate}
        onDirectSubNavigate={(subKey) => onNavigate(subKey)}
      />

      <section data-testid="home-store-section">
        <SectionHeader
          title={t('门店经营')}
          action={t('详情')}
          onAction={() => navigateGuardedSensitive('analysis', '经营分析')}
        />
        <div className="overflow-hidden rounded-[1.35rem] border border-slate-100 bg-white px-3 py-1 shadow-sm">
          {isPublic || isStorePrivacy ? (
            <div className="grid min-h-28 place-items-center text-xs text-slate-300">{t(isPublic ? '对外展示模式 · 数据已隐藏' : '门店运营模式 · 经营数据已隐藏')}</div>
          ) : storeRows.length ? (
            storeRows.map((row, index) => {
              const up = row.change == null ? null : row.change >= 0
              const max = Math.max(1, ...storeRows.map((item) => item.income))
              const storeTarget = periodTargetTotal([row.key], month, day, weekStart)
              const storeTargetPct = calcTargetProgressPct(row.income, storeTarget)
              const hasEntered = activeEnteredStores.has(row.key) || (Boolean(day) && (row.income > 0 || row.orders > 0))
              const barWidth = effectivePrivacy
                ? (storeTargetPct == null ? 0 : Math.min(100, Math.max(row.income > 0 ? 4 : 0, storeTargetPct)))
                : Math.max(4, (row.income / max) * 100)

              return (
                <button key={row.key} type="button" onClick={() => openStore(row.key)} className="block w-full border-b border-slate-50 px-1 py-3 text-left last:border-b-0 active:bg-slate-50">
                  <div className="flex items-center gap-3">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-budu-50 text-xs font-bold text-budu-600">{index + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-slate-700">{row.name}</span>
                      <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <span className="block h-full rounded-full bg-budu-400 transition-all duration-300" style={{ width: `${barWidth}%` }} />
                      </span>
                    </span>
                    {effectivePrivacy ? (
                      <span className="shrink-0 text-right">
                        <span className="block whitespace-nowrap text-[13px] font-bold tabular-nums text-slate-800">
                          {storeTargetPct == null ? t('未设目标') : `${t('目标')} ${storeTargetPct}%`}
                        </span>
                        <span className={`mt-0.5 block whitespace-nowrap text-[10px] font-semibold ${hasEntered ? 'text-emerald-600' : 'text-slate-400'}`}>
                          {day ? (hasEntered ? t('已录入') : t('待录入')) : t('周期单量')} · {row.orders} {t('单')}
                        </span>
                      </span>
                    ) : (
                      <span className="shrink-0 text-right">
                        <span className="block whitespace-nowrap text-[13px] font-bold tabular-nums text-slate-800">¥{formatMoney(row.income)}</span>
                        <span className={`mt-0.5 block text-[10px] font-semibold ${up == null ? 'text-slate-300' : up ? 'text-emerald-600' : 'text-rose-500'}`}>
                          {row.change == null ? '—' : pctText(row.change)}
                        </span>
                      </span>
                    )}
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

      <section data-testid="home-activity-section">
        <SectionHeader title={t('最近动态')} action={t('查看全部')} onAction={() => setSheet('activity')} />
        <div className="overflow-hidden rounded-[1.35rem] border border-slate-100 bg-white px-3 py-1 shadow-sm">
          {notifications == null ? (
            <div className="space-y-3 p-3">
              {[1, 2, 3].map((item) => <div key={item} className="h-10 animate-pulse rounded-xl bg-slate-100" />)}
            </div>
          ) : activityRows.length ? (
            activityRows.map((item) => <ActivityRow key={item.id} item={item} masked={effectivePrivacy} onOpen={openActivity} />)
          ) : (
            <div className="grid min-h-28 place-items-center text-xs text-slate-300">
              {activityError ? t('动态加载失败，请稍后刷新') : t('暂无最近动态')}
            </div>
          )}
        </div>
      </section>

      {/* 功能工作台子菜单 Bottom Sheet */}
      {submenuGroup && (
        <BottomSheet title={t(submenuGroup.label)} onClose={() => setSubmenuGroup(null)}>
          <div className="space-y-2">
            {submenuGroup.subs.map((sub) =>
              sub.href ? (
                <a
                  key={sub.key}
                  href={sub.href}
                  data-testid={`submenu-link-${sub.key}`}
                  onClick={() => setSubmenuGroup(null)}
                  className="flex min-h-12 w-full items-center justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3 text-left no-underline transition hover:bg-budu-50/70 active:bg-budu-50"
                >
                  <span className="flex items-center gap-2.5">
                    <span className="h-2 w-2 rounded-full bg-budu-400" />
                    <span className="text-sm font-semibold text-slate-700">{t(sub.label)}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-slate-300" />
                </a>
              ) : (
                <button
                  key={sub.key}
                  type="button"
                  onClick={() => {
                    const nextKey = sub.key
                    setSubmenuGroup(null)
                    onNavigate(nextKey)
                  }}
                  className="flex min-h-12 w-full items-center justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3 text-left transition hover:bg-budu-50/70 active:bg-budu-50"
                >
                  <span className="flex items-center gap-2.5">
                    <span className="h-2 w-2 rounded-full bg-budu-400" />
                    <span className="text-sm font-semibold text-slate-700">{t(sub.label)}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-slate-300" />
                </button>
              ),
            )}
          </div>
        </BottomSheet>
      )}

      {/* 防窥态下敏感大屏入口二次确认弹窗 */}
      {sensitiveConfirm && (
        <BottomSheet title={t('防窥访问确认')} onClose={() => setSensitiveConfirm(null)}>
          <div className="space-y-4 py-1">
            <div className="flex items-start gap-3 rounded-2xl bg-budu-50/70 p-3.5">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-budu-600 shadow-subtle">
                <ShieldAlert className="h-5 w-5" />
              </span>
              <div className="min-w-0 text-xs leading-relaxed text-slate-600">
                <p className="text-sm font-bold text-slate-800">
                  {t('即将进入「{name}」', { name: sensitiveConfirm.label })}
                </p>
                <p className="mt-1">
                  {t('当前处于防窥模式，该页面包含完整营收与财务报表明细，请确认周围无旁人注视后再继续打开。')}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setSensitiveConfirm(null)}
                className="min-h-11 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
              >
                {t('取消')}
              </button>
              <button
                type="button"
                data-testid="confirm-sensitive-navigate"
                onClick={() => {
                  const { targetKey, beforeNavigate } = sensitiveConfirm
                  setSensitiveConfirm(null)
                  if (beforeNavigate) beforeNavigate()
                  onNavigate(targetKey)
                }}
                className="min-h-11 rounded-2xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-budu-600"
              >
                {t('确认进入')}
              </button>
            </div>
          </div>
        </BottomSheet>
      )}

      {sheet && (
        <BottomSheet
          title={t(sheet === 'activity' ? '全部动态' : sheet === 'missing' ? '待录入门店' : sheet === 'abnormal' ? '异常事项' : '待办详情')}
          onClose={() => setSheet(null)}
        >
          {sheet === 'activity' && (
            <div className="divide-y divide-slate-50">
              {(notifications || []).map((item) => <ActivityRow key={item.id} item={item} masked={effectivePrivacy} onOpen={openActivity} />)}
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
              {abnormalRows.map((item) => <ActivityRow key={item.id} item={item} masked={effectivePrivacy} onOpen={openActivity} />)}
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
