import { useEffect, useMemo, useState } from 'react'
import {
  LayoutDashboard,
  Package,
  ReceiptText,
  RotateCcw,
  Truck,
  Megaphone,
  PanelsTopLeft,
  ChartNoAxesCombined,
  Settings,
  ChevronLeft,
} from 'lucide-react'
import { api } from '../utils/api'
import { formatCents } from '../utils/pos'
import OnlineCatalogPage from './OnlineCatalogPage'
import OnlineOrderBoard from './OnlineOrderBoard'
import AfterSalesBoard from './AfterSalesBoard'
import AnalyticsBoard from './AnalyticsBoard'
import BannerBoard from './BannerBoard'
import CategoryBoard from './CategoryBoard'
import ComboBoard from './ComboBoard'
import ProductPerformanceBoard from './ProductPerformanceBoard'
import PublishRecordBoard from './PublishRecordBoard'

/**
 * 小程序管理台外壳（BUDU-MP-CONSOLE-001 / P0）
 *
 * 结构：图标栏（模块）→ 二级导航（视图）→ 内容区。
 * 商品模块直接嵌入既有的 OnlineCatalogPage（embedded），订单/售后/发货在 P1 接入。
 */

const MODULES = [
  {
    key: 'overview',
    label: '概览',
    icon: LayoutDashboard,
    desc: '线上商城的实时脉搏',
    views: [{ key: 'overview', label: '今日概览' }],
  },
  {
    key: 'products',
    label: '商品',
    icon: Package,
    desc: '线上档案即发布源：保存后点「发布」，小程序约 60 秒内更新',
    views: [
      { key: 'products', label: '商品列表' },
      { key: 'products-category', label: '分类管理' },
      { key: 'products-combo', label: '组合商品' },
      { key: 'products-mapping', label: '库存与映射', soon: true },
    ],
  },
  {
    key: 'orders',
    label: '订单',
    icon: ReceiptText,
    desc: '小程序订单检索与履约：点任意一行打开详情，可直接发货',
    views: [
      { key: 'orders', label: '全部订单', state: '' },
      { key: 'orders-pending', label: '待发货', state: 'TO_SHIP' },
      { key: 'orders-shipped', label: '已发货', state: 'SHIPPED' },
      { key: 'orders-refunded', label: '已退款', state: 'REFUNDED' },
      { key: 'orders-cancelled', label: '已取消', state: 'CANCELLED' },
    ],
  },
  {
    key: 'after-sales',
    label: '售后',
    icon: RotateCcw,
    desc: '退款台账与对账：可查历史退款、金额与原因；发起退款待开放',
    views: [
      { key: 'after-sales', label: '退款记录', state: '' },
      { key: 'after-sales-pending', label: '处理中', state: 'PENDING' },
      { key: 'after-sales-settled', label: '已到账', state: 'SETTLED' },
    ],
  },
  {
    key: 'shipments',
    label: '发货',
    icon: Truck,
    desc: '待发货订单集中处理：填单号即发货，并自动登记微信发货信息',
    views: [
      { key: 'shipments', label: '待发货', state: 'TO_SHIP' },
      { key: 'shipments-done', label: '已发货', state: 'SHIPPED' },
      { key: 'shipments-issue', label: '物流异常', state: 'ISSUE' },
    ],
  },
  {
    key: 'marketing',
    label: '营销',
    icon: Megaphone,
    desc: '首页轮播：改图、改文案、调顺序，发布后覆盖小程序首屏',
    views: [
      { key: 'marketing-banner', label: '首页轮播' },
      { key: 'marketing-campaign', label: '优惠活动' },
    ],
  },
  {
    key: 'shop',
    label: '店铺',
    icon: PanelsTopLeft,
    desc: '小程序页面结构与内容',
    views: [
      { key: 'shop-home', label: '首页装修' },
      { key: 'shop-category', label: '分类页' },
      { key: 'shop-profile', label: '个人中心' },
    ],
  },
  {
    key: 'data',
    label: '数据',
    icon: ChartNoAxesCombined,
    desc: '交易与商品表现',
    views: [
      { key: 'data-trade', label: '交易分析' },
      { key: 'data-product', label: '商品表现' },
    ],
  },
  {
    key: 'settings',
    label: '设置',
    icon: Settings,
    desc: '店铺信息与发布记录',
    views: [
      { key: 'settings-shop', label: '店铺信息' },
      { key: 'settings-release', label: '发布记录' },
    ],
  },
]

const SOON_COPY = {
  'shipments:shipments-issue': {
    title: '物流异常',
    note: '需要接入快递轨迹查询接口后，才能按「超时未更新 / 派送异常」聚合订单。当前可在订单详情里查看物流公司与运单号。',
  },
  'marketing:marketing-campaign': {
    title: '优惠活动',
    note: '优惠券、满减与限时活动需要小程序客户端同步支持（下单与结算链路都要改造），后台单方面配置无法生效。规划中。',
  },
  'shop:shop-home': {
    title: '首页装修',
    note: '首页除轮播外的商品区、活动位由客户端固定结构渲染；做可视化装修需要先升级小程序的渲染协议并发布新版本。轮播已可在「营销 → 首页轮播」中管理。',
  },
  'shop:shop-category': {
    title: '分类页',
    note: '分类页由小程序端固定实现，目前没有可配置项；分类本身的名称与排序在「商品 → 分类管理」中维护。',
  },
  'shop:shop-profile': {
    title: '个人中心',
    note: '个人中心的入口与文案由客户端固定，暂无可配置项。',
  },
  'settings:settings-shop': {
    title: '店铺信息',
    note: '店铺名称、地址、营业时间等由 POS 设置统一维护，避免两处编辑不一致；这里规划为只读展示。',
  },
}

function PageHead({ title, desc, actions }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-2 lg:mb-5 lg:gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight text-slate-800 lg:text-xl">{title}</h1>
        {desc ? <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-500 lg:line-clamp-none lg:text-xs">{desc}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

function Kpi({ label, value, hint, tone = '' }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-[0_1px_2px_rgba(15,15,25,0.04)] lg:p-4">
      <div className="text-[10px] text-slate-500 lg:text-[11px]">{label}</div>
      <div className={`mt-1 text-xl font-semibold tracking-tight lg:text-2xl ${tone || 'text-slate-800'}`}>{value}</div>
      {hint ? <div className="mt-1 text-[10px] text-slate-400 lg:text-[11px]">{hint}</div> : null}
    </div>
  )
}

function Overview({ onGo }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api('/v2/online-catalog/overview')
      .then((res) => { if (!cancelled) setData(res) })
      .catch((err) => { if (!cancelled) setError(err.message || '加载失败') })
    return () => { cancelled = true }
  }, [])

  if (error) {
    return <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
  }
  if (!data) {
    return <div className="rounded-2xl border border-slate-200 bg-white px-4 py-16 text-center text-sm text-slate-400">加载中…</div>
  }

  const { products, orders, fulfillment, refunds } = data
  const onlineRate = products.total ? Math.round((products.on / products.total) * 100) : 0

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => onGo('shipments', 'shipments')} className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-600 hover:border-budu-200 hover:bg-budu-50 lg:gap-2 lg:text-xs">
          <span className="h-1.5 w-1.5 rounded-full bg-budu-400" />待发货 <b className="text-budu-600">{fulfillment.pending}</b>
        </button>
        <button type="button" onClick={() => onGo('after-sales', 'after-sales')} className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-600 hover:border-budu-200 hover:bg-budu-50 lg:gap-2 lg:text-xs">
          <span className="h-1.5 w-1.5 rounded-full bg-budu-400" />待处理退款 <b className="text-budu-600">{refunds.pending}</b>
        </button>
        <button type="button" onClick={() => onGo('products', 'products')} className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-600 hover:border-budu-200 hover:bg-budu-50 lg:gap-2 lg:text-xs">
          <span className="h-1.5 w-1.5 rounded-full bg-budu-400" />发布失败 <b className="text-budu-600">{products.failed}</b>
        </button>
        <span className="w-full text-[10px] text-slate-400 sm:ml-auto sm:w-auto sm:text-[11px]">数据更新于 {new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>

      <div className="grid grid-cols-2 gap-2.5 lg:gap-3 xl:grid-cols-4">
        <Kpi label="今日成交额" value={formatCents(orders.todayCents)} hint={`${orders.today} 笔已支付`} />
        <Kpi label="近 7 日成交额" value={formatCents(orders.last7Cents)} hint={`${orders.last7} 笔已支付`} />
        <Kpi label="待发货" value={fulfillment.pending} hint={`已支付 ${fulfillment.paid} · 历史已发货 ${fulfillment.shipped}`} />
        <Kpi label="待处理退款" value={refunds.pending} hint={`历史退款 ${refunds.total} 笔`} />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-700">商品结构</h2>
            <button type="button" className="text-xs text-budu-600 hover:underline" onClick={() => onGo('products', 'products')}>去管理</button>
          </div>
          <div className="space-y-3 px-4 py-4">
            {[
              { label: '商品总数', value: products.total, tone: 'bg-slate-300' },
              { label: '上架中', value: products.on, tone: 'bg-emerald-400' },
              { label: '草稿', value: products.draft, tone: 'bg-amber-400' },
              { label: '发布失败', value: products.failed, tone: 'bg-rose-400' },
            ].map((row) => (
              <div key={row.label}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="text-slate-500">{row.label}</span>
                  <b className="text-slate-700">{row.value}</b>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={`h-full rounded-full ${row.tone}`}
                    style={{ width: `${products.total ? Math.round((row.value / products.total) * 100) : 0}%` }}
                  />
                </div>
              </div>
            ))}
            <div className="pt-1 text-[11px] text-slate-400">上架率 {onlineRate}%</div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-700">接下来</h2>
          </div>
          <ul className="divide-y divide-slate-100 text-sm">
            <li className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="text-slate-700">订单列表 / 详情 / 发货</div>
                <div className="mt-0.5 text-[11px] text-slate-400">P1 · 已上线，见「订单」与「发货」</div>
              </div>
              <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">已完成</span>
            </li>
            <li className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="text-slate-700">售后台账 / 交易分析</div>
                <div className="mt-0.5 text-[11px] text-slate-400">P2 · 已上线（只读）</div>
              </div>
              <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">已完成</span>
            </li>
            <li className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="text-slate-700">首页轮播后台</div>
                <div className="mt-0.5 text-[11px] text-slate-400">需先解决图片写入权限 + 客户端改造</div>
              </div>
              <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">待建</span>
            </li>
          </ul>
        </div>
      </div>

      {orders.last7 === 0 ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
          近 7 日没有新的已支付订单。历史上线订单均已退款或取消，因此成交额显示为 0 —— 这是真实数据，不是占位。
        </div>
      ) : null}
    </>
  )
}

function ComingSoon({ moduleKey, view }) {
  const copy = SOON_COPY[`${moduleKey}:${view.key}`] || { title: view.label, note: '该模块在后续阶段建设。' }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-6 py-14 text-center">
      <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400">
        <PanelsTopLeft size={20} />
      </div>
      <div className="text-sm font-semibold text-slate-700">{copy.title}</div>
      <p className="mx-auto mt-2 max-w-lg text-xs leading-relaxed text-slate-500">{copy.note}</p>
      <div className="mt-3 inline-flex rounded-md bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">建设中</div>
    </div>
  )
}

export default function MiniProgramPage({ initialModule = 'overview' }) {
  const [moduleKey, setModuleKey] = useState(
    MODULES.some((m) => m.key === initialModule) ? initialModule : 'overview',
  )
  const module = useMemo(() => MODULES.find((m) => m.key === moduleKey) || MODULES[0], [moduleKey])
  const [viewKey, setViewKey] = useState(module.views[0].key)

  useEffect(() => {
    setViewKey((module.views[0] || {}).key)
  }, [moduleKey])

  const view = module.views.find((v) => v.key === viewKey) || module.views[0]
  const go = (nextModule, nextView) => {
    setModuleKey(nextModule)
    setViewKey(nextView || (MODULES.find((m) => m.key === nextModule)?.views[0] || {}).key)
  }

  const renderView = () => {
    if (viewKey === 'overview') return <Overview onGo={go} />
    if (viewKey === 'products') return <OnlineCatalogPage embedded />
    if (viewKey === 'products-category') return <CategoryBoard />
    if (viewKey === 'products-combo') return <ComboBoard onGo={go} />
    if ((moduleKey === 'orders' || moduleKey === 'shipments') && view.state !== 'ISSUE') {
      return <OnlineOrderBoard key={viewKey} initialState={view.state || ''} title={view.label} showFilters={moduleKey === 'orders'} />
    }
    if (moduleKey === 'after-sales') return <AfterSalesBoard key={viewKey} initialState={view.state || ''} />
    if (viewKey === 'data-trade') return <AnalyticsBoard key={viewKey} />
    if (viewKey === 'data-product') return <ProductPerformanceBoard />
    if (viewKey === 'marketing-banner') return <BannerBoard key={viewKey} />
    if (viewKey === 'settings-release') return <PublishRecordBoard onGo={go} />
    return <ComingSoon moduleKey={moduleKey} view={view} />
  }

  return (
    <div className="flex h-[100dvh] flex-col bg-[#F6F4F2] lg:grid lg:h-screen lg:grid-cols-[64px_208px_1fr] lg:overflow-hidden">
      {/* 移动端顶栏 */}
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-[#FFFDFB] px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] lg:hidden">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-slate-800">小程序管理台</div>
          <div className="truncate text-[10px] text-slate-400">{module.label} · {view.label}</div>
        </div>
        <a href="/" className="flex shrink-0 items-center gap-0.5 rounded-lg px-2 py-1.5 text-[11px] text-slate-500 active:bg-slate-100">
          <ChevronLeft size={14} />返回 OS
        </a>
      </header>

      {/* 图标栏（桌面） */}
      <nav className="hidden flex-col items-center gap-1 overflow-y-auto border-r border-slate-200 bg-[#FFFDFB] py-3 lg:flex">
        {MODULES.map((item) => {
          const Icon = item.icon
          const active = item.key === moduleKey
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => go(item.key)}
              className={`group relative grid h-11 w-11 place-items-center rounded-xl transition ${active ? 'bg-budu-50 text-budu-600' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'}`}
              title={item.label}
            >
              <Icon size={19} strokeWidth={1.8} />
              {active ? <span className="absolute -left-3 top-2.5 bottom-2.5 w-[3px] rounded-r bg-budu-500" /> : null}
              <span className="pointer-events-none absolute left-12 z-30 whitespace-nowrap rounded-md bg-slate-800 px-2 py-1 text-[11px] text-white opacity-0 transition group-hover:opacity-100">{item.label}</span>
            </button>
          )
        })}
        <div className="flex-1" />
        <a href="/" className="group relative grid h-11 w-11 place-items-center rounded-xl text-slate-500 hover:bg-slate-100" title="返回 OS">
          <ChevronLeft size={19} strokeWidth={1.8} />
          <span className="pointer-events-none absolute left-12 z-30 whitespace-nowrap rounded-md bg-slate-800 px-2 py-1 text-[11px] text-white opacity-0 transition group-hover:opacity-100">返回 OS</span>
        </a>
      </nav>

      {/* 二级导航（桌面） */}
      <aside className="hidden flex-col overflow-y-auto border-r border-slate-200 bg-[#FFFDFB] px-3 py-4 lg:flex">
        <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">{module.label}</div>
        {module.views.map((item) => {
          const active = item.key === viewKey
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setViewKey(item.key)}
              className={`mb-0.5 flex items-center justify-between rounded-lg px-2.5 py-2 text-left text-[13px] transition ${active ? 'bg-budu-50 font-medium text-budu-700' : 'text-slate-600 hover:bg-slate-100'}`}
            >
              <span>{item.label}</span>
              {item.soon ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-400">规划</span> : null}
            </button>
          )
        })}
        <div className="my-3 h-px bg-slate-100" />
        <p className="px-2 text-[11px] leading-relaxed text-slate-400">所有操作即时生效于线上；发布类操作会写入小程序目录。</p>
      </aside>

      {/* 内容区 */}
      <main className="flex-1 overflow-y-auto overflow-x-hidden px-4 pb-24 pt-3 lg:px-7 lg:py-6 lg:pb-6">
        <div className="mx-auto max-w-[1200px]">
          {/* 移动端视图切换 */}
          <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1 lg:hidden">
            {module.views.map((item) => {
              const active = item.key === viewKey
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setViewKey(item.key)}
                  className={`flex h-8 shrink-0 items-center gap-1 rounded-full border px-3 text-xs ${active ? 'border-budu-200 bg-budu-50 font-medium text-budu-700' : 'border-slate-200 bg-white text-slate-600 active:bg-slate-50'}`}
                >
                  {item.label}
                  {item.soon ? <span className="rounded bg-slate-100 px-1 py-0.5 text-[9px] text-slate-400">规划</span> : null}
                </button>
              )
            })}
          </div>
          <PageHead title={view.label === '商品列表' ? '商品' : view.label} desc={module.desc} />
          {renderView()}
        </div>
      </main>

      {/* 移动端底部模块栏 */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-slate-200 bg-[#FFFDFB]/95 backdrop-blur lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {MODULES.map((item) => {
          const Icon = item.icon
          const active = item.key === moduleKey
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => go(item.key)}
              className={`flex min-w-[34px] flex-1 flex-col items-center gap-0.5 py-1.5 text-[10px] ${active ? 'text-budu-600' : 'text-slate-500 active:text-slate-700'}`}
            >
              <Icon size={18} strokeWidth={active ? 2.2 : 1.7} />
              <span className="leading-none">{item.label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}
