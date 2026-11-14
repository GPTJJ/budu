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
      { key: 'products-category', label: '分类管理', soon: true },
      { key: 'products-combo', label: '组合商品', soon: true },
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
    desc: '首屏内容与活动位',
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
  orders: { title: '订单工作台', note: '订单数据与结算、支付、退款、物流记录都已经在库里，P1 接入列表与详情抽屉后即可使用。' },
  'after-sales': { title: '售后工作台', note: '退款服务（原路退回）已经存在，P2 接入审核界面；当前可在订单详情中发起。' },
  shipments: { title: '发货工作台', note: '批量发货与微信发货同步的服务已就绪，P1 接入操作界面。' },
  'marketing-banner': { title: '首页轮播', note: '轮播条目目前写死在客户端源码里。后台化需要先解决图片写入权限，并做一次客户端改造读取远程配置。' },
}

function PageHead({ title, desc, actions }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-800">{title}</h1>
        {desc ? <p className="mt-1 text-xs text-slate-500">{desc}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

function Kpi({ label, value, hint, tone = '' }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,15,25,0.04)]">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tracking-tight ${tone || 'text-slate-800'}`}>{value}</div>
      {hint ? <div className="mt-1 text-[11px] text-slate-400">{hint}</div> : null}
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
        <button type="button" onClick={() => onGo('shipments', 'shipments')} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 hover:border-budu-200 hover:bg-budu-50">
          <span className="h-1.5 w-1.5 rounded-full bg-budu-400" />待发货 <b className="text-budu-600">{fulfillment.pending}</b>
        </button>
        <button type="button" onClick={() => onGo('after-sales', 'after-sales')} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 hover:border-budu-200 hover:bg-budu-50">
          <span className="h-1.5 w-1.5 rounded-full bg-budu-400" />待处理退款 <b className="text-budu-600">{refunds.pending}</b>
        </button>
        <button type="button" onClick={() => onGo('products', 'products')} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 hover:border-budu-200 hover:bg-budu-50">
          <span className="h-1.5 w-1.5 rounded-full bg-budu-400" />发布失败 <b className="text-budu-600">{products.failed}</b>
        </button>
        <span className="ml-auto text-[11px] text-slate-400">数据更新于 {new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
  const copy = SOON_COPY[moduleKey] || { title: view.label, note: '该模块在后续阶段建设。' }
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

  return (
    <div className="grid h-screen grid-cols-[64px_208px_1fr] overflow-hidden bg-[#F6F4F2]">
      {/* 图标栏 */}
      <nav className="flex flex-col items-center gap-1 overflow-y-auto border-r border-slate-200 bg-[#FFFDFB] py-3">
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

      {/* 二级导航 */}
      <aside className="flex flex-col overflow-y-auto border-r border-slate-200 bg-[#FFFDFB] px-3 py-4">
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
      <main className="overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-[1200px]">
          <PageHead title={view.label === '商品列表' ? '商品' : view.label} desc={module.desc} />
          {viewKey === 'overview' ? <Overview onGo={go} /> : null}
          {viewKey === 'products' ? <OnlineCatalogPage embedded /> : null}
          {(moduleKey === 'orders' || moduleKey === 'shipments') && view.state !== 'ISSUE' ? (
            <OnlineOrderBoard key={viewKey} initialState={view.state || ''} title={view.label} showFilters={moduleKey === 'orders'} />
          ) : null}
          {moduleKey === 'after-sales' ? <AfterSalesBoard key={viewKey} initialState={view.state || ''} /> : null}
          {moduleKey === 'data' && viewKey === 'data-trade' ? <AnalyticsBoard key={viewKey} /> : null}
          {moduleKey === 'shipments' && view.state === 'ISSUE' ? <ComingSoon moduleKey={moduleKey} view={view} /> : null}
          {moduleKey !== 'overview' && moduleKey !== 'orders' && moduleKey !== 'shipments' && moduleKey !== 'after-sales'
            && !(moduleKey === 'data' && viewKey === 'data-trade') && viewKey !== 'products'
            ? <ComingSoon moduleKey={moduleKey} view={view} /> : null}
        </div>
      </main>
    </div>
  )
}
