import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, BarChart3, Boxes, Building2, ChevronLeft, ChevronRight, CircleDollarSign,
  Clock3, FileSpreadsheet, Landmark, ListFilter, ReceiptText, Search, ShoppingBag,
  TrendingUp, WalletCards, X,
} from 'lucide-react'
import { api } from '../utils/api'
import { allStores } from '../utils/selectors'
import {
  hasModuleAccess,
  hasReportAllStores,
  hasReportSalesView,
} from '../../shared/accountPermissions'
import FinancePage from './FinancePage'
import OrderDetailSheet from './OrderDetailSheet'
import { OverlayHeader, OverlayPanel, OverlayScrollRegion, OverlayViewport } from './overlay/OverlayPrimitives'
import {
  coverageText, formatComparisonBps, formatReportBps, formatReportCents, formatReportInteger, localReportTime,
  ORDER_SOURCE_OPTIONS, orderSourceText, orderStatusText, reportDateRange, REPORT_TABS,
  SETTLEMENT_OPTIONS, settlementText, shareWidth,
} from '../utils/reportCenterUi'

const inputClass = 'h-11 min-w-0 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none transition focus:border-budu-400 focus:ring-2 focus:ring-budu-100'
const PAGE_SIZE = 20

const metricDefinitions = [
  ['revenue', '营业收入', CircleDollarSign, true],
  ['orderCount', '订单数', ShoppingBag, false],
  ['aov', '客单价', WalletCards, true],
  ['grossSales', '营业额', TrendingUp, true],
  ['discount', '优惠', ReceiptText, true],
  ['refund', '退款', ReceiptText, true],
]

const productFields = [
  ['销售数量', 'salesQuantity', 'salesQuantityShareBps', false],
  ['销售金额', 'salesCents', 'salesShareBps', true],
  ['优惠金额', 'discountCents', 'discountShareBps', true],
  ['产品收入', 'productRevenueCents', 'productRevenueShareBps', true],
  ['退款数量', 'refundQuantity', 'refundQuantityShareBps', false],
  ['退款金额', 'refundCents', 'refundShareBps', true],
  ['赠送数量', 'giftQuantity', 'giftQuantityShareBps', false],
  ['赠送金额', 'giftCents', 'giftShareBps', true],
]

function coverageStateClass(state) {
  if (state === 'PARTIAL') return 'border-amber-200 bg-amber-50 text-amber-700'
  if (state === 'UNAVAILABLE') return 'border-slate-200 bg-slate-100 text-slate-500'
  return 'border-emerald-100 bg-emerald-50 text-emerald-600'
}

function CoverageBadge({ coverage, onOpen }) {
  if (!coverage || coverage.state === 'COMPLETE') return null
  return (
    <button type="button" onClick={() => onOpen(coverage)} className={`inline-flex min-h-7 items-center rounded-full border px-2.5 text-[11px] font-bold ${coverageStateClass(coverage.state)}`}>
      {coverageText(coverage)}
    </button>
  )
}

function CoverageSheet({ coverage, storeMap, onClose }) {
  if (!coverage) return null
  const group = (keys, label, className) => keys?.length > 0 && (
    <section>
      <p className={`text-xs font-bold ${className}`}>{label} · {keys.length} 家</p>
      <div className="mt-2 flex flex-wrap gap-2">{keys.map((key) => <span key={key} className="rounded-full bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600">{storeMap.get(key) || key}</span>)}</div>
    </section>
  )
  return (
    <OverlayViewport className="fixed inset-0 z-[105] flex items-end bg-slate-900/40 backdrop-blur-sm sm:items-center sm:justify-center sm:p-4" role="dialog" aria-modal="true" aria-label="数据覆盖说明">
      <button type="button" className="absolute inset-0" onClick={onClose} aria-label="关闭覆盖说明" />
      <OverlayPanel className="relative flex max-h-[82dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-[1.75rem] bg-white shadow-2xl sm:rounded-[1.75rem]">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-200 sm:hidden" />
        <OverlayHeader className="flex items-center border-b border-slate-100 px-5 py-4">
          <div><h3 className="font-bold text-slate-900">数据覆盖说明</h3><p className="mt-0.5 text-xs text-slate-400">缺少事实不会按 0 计入</p></div>
          <button type="button" onClick={onClose} className="ml-auto grid h-10 w-10 place-items-center rounded-xl bg-slate-50 text-slate-400" aria-label="关闭"><X className="h-4 w-4" /></button>
        </OverlayHeader>
        <OverlayScrollRegion className="space-y-5 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
          <div className={`rounded-2xl border p-4 text-sm font-semibold ${coverageStateClass(coverage.state)}`}>
            {coverage.state === 'PARTIAL' ? '当前指标仅统计有权威数据的门店或日期。' : '当前范围没有支持该指标的订单级事实。'}
          </div>
          {group(coverage.coveredStores, '完整覆盖', 'text-emerald-600')}
          {group(coverage.partialStores, '部分日期覆盖', 'text-amber-600')}
          {group(coverage.uncoveredStores, '未覆盖', 'text-slate-500')}
          <p className="text-xs leading-5 text-slate-400">已覆盖 {coverage.coveredStoreDays ?? 0} 个门店日 · 未覆盖 {coverage.uncoveredStoreDays ?? 0} 个门店日</p>
        </OverlayScrollRegion>
      </OverlayPanel>
    </OverlayViewport>
  )
}

function CoverageNotice({ coverage, storeMap, onOpen, noun }) {
  if (!coverage || coverage.state === 'COMPLETE') return null
  const covered = (coverage.coveredStores?.length || 0) + (coverage.partialStores?.length || 0)
  const total = new Set([...(coverage.coveredStores || []), ...(coverage.partialStores || []), ...(coverage.uncoveredStores || [])]).size
  return (
    <button type="button" onClick={() => onOpen(coverage)} className="flex w-full items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-left text-sm text-amber-800">
      <ListFilter className="h-5 w-5 shrink-0" />
      <span className="min-w-0 flex-1">{coverage.state === 'UNAVAILABLE' ? `暂无${noun}数据` : `${noun}仅覆盖已接入订单级数据的门店`}</span>
      <span className="shrink-0 text-xs font-bold">{covered} / {total || storeMap.size} 家</span>
    </button>
  )
}

function LoadingBlock() {
  return <div className="grid min-h-48 place-items-center rounded-3xl border border-slate-100 bg-white text-sm font-semibold text-slate-400 shadow-sm">正在读取报表…</div>
}

function ErrorBlock({ message, retry }) {
  return <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700"><p>{message}</p><button type="button" onClick={retry} className="mt-3 min-h-10 rounded-xl bg-white px-4 text-xs font-bold shadow-sm">重新加载</button></div>
}

const dashboardMetricDefinitions = [
  ['revenue', '营业收入', CircleDollarSign, true, 'summary'],
  ['orderCount', '订单数', ShoppingBag, false, 'orders'],
  ['aov', '客单价', WalletCards, true, 'summary'],
  ['grossSales', '营业额', TrendingUp, true, 'summary'],
  ['refund', '退款金额', ReceiptText, true, 'summary'],
]

function comparisonCaption(comparison) {
  const state = comparison?.coverage?.state
  if (state === 'NO_PRIOR_DATA') return comparison?.coverage?.mode === 'year' ? '暂无同期数据' : '暂无上期数据'
  if (state === 'INCOMPARABLE') return '数据覆盖不可比'
  if (comparison?.changeBps === null || comparison?.changeBps === undefined) return '对比基数为 0'
  const stores = comparison.coverage?.comparableStores?.length || 0
  return `${formatComparisonBps(comparison.changeBps)} · ${state === 'PARTIAL' ? `基于 ${stores} 家可比门店` : '完整可比'}`
}

function DashboardMetricCard({ metricKey, label, Icon, money, metric, comparison, onCoverage, onOpen }) {
  const unavailable = metric?.valueCents === null || metric?.value === null
  const display = money ? formatReportCents(metric?.valueCents) : formatReportInteger(metric?.value, { suffix: ' 单' })
  return (
    <section className="min-w-0 rounded-2xl border border-white bg-white p-3.5 text-left shadow-sm sm:p-5" data-testid={`dashboard-metric-${metricKey}`}>
      <div className="flex items-start justify-between gap-2"><button type="button" onClick={onOpen} className="grid h-9 w-9 place-items-center rounded-xl bg-budu-50 text-budu-600" aria-label={`查看${label}明细`}><Icon className="h-4 w-4" /></button><CoverageBadge coverage={metric?.coverage} onOpen={onCoverage} /></div>
      <button type="button" onClick={onOpen} className="mt-3 block w-full text-left"><span className={`block truncate font-black tabular-nums tracking-tight text-slate-900 ${metricKey === 'revenue' ? 'text-[22px] sm:text-3xl' : 'text-lg sm:text-2xl'}`}>{display}</span><span className="mt-1 block text-xs font-semibold text-slate-400">{label}</span></button>
      <p className={`mt-2 min-h-4 text-[10px] font-bold ${comparison?.changeBps && BigInt(comparison.changeBps) < 0n ? 'text-rose-500' : 'text-slate-400'}`}>{unavailable ? '暂无权威数据' : comparisonCaption(comparison)}</p>
    </section>
  )
}

function DashboardFreshness({ data, storeMap, onCoverage }) {
  const pending = data?.freshness?.pendingCloseStores || []
  const historical = data?.freshness?.historicalIncompleteStores || []
  const coverage = data?.coverage?.dailySummary
  const covered = (coverage?.coveredStores?.length || 0) + (coverage?.partialStores?.length || 0)
  const total = data?.storeComparison?.length || 0
  return <div className="space-y-2">
    {pending.length > 0 && <button type="button" onClick={() => onCoverage(coverage)} className="flex w-full items-start gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-left text-sm text-sky-800" data-testid="today-pending-close"><Clock3 className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 flex-1"><strong>今日实时数据部分覆盖 · 已覆盖 {covered} / {total} 家</strong><span className="mt-1 block text-xs text-sky-600">{pending.map((key) => storeMap.get(key) || key).join('、')}待闭店确认，未按 0 计入</span></span></button>}
    {historical.length > 0 && <button type="button" onClick={() => onCoverage(coverage)} className="flex w-full items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-left text-sm text-amber-800" data-testid="historical-incomplete"><ListFilter className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 flex-1"><strong>历史经营数据不完整</strong><span className="mt-1 block text-xs text-amber-600">{historical.map((key) => storeMap.get(key) || key).join('、')}存在未确认日期</span></span></button>}
  </div>
}

function trendValue(point, metric) {
  if (metric === 'orderCount') return point.orderCount
  if (metric === 'aov') return point.aovCents
  return point.revenueCents
}

function formatTrendValue(value, metric) {
  return metric === 'orderCount' ? formatReportInteger(value, { suffix: ' 单' }) : formatReportCents(value)
}

function trendLabel(point, granularity) {
  if (granularity === 'MONTH') return point.key.replace('-', '年') + '月'
  const short = (value) => `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`
  return granularity === 'WEEK' ? `${short(point.from)}–${short(point.to)}` : short(point.from)
}

function TrendCard({ trend }) {
  const [metric, setMetric] = useState('revenue')
  const points = trend?.points || []
  const values = points.map((point) => trendValue(point, metric)).filter((value) => value !== null && value !== undefined).map((value) => BigInt(value))
  const max = values.reduce((current, value) => value > current ? value : current, 0n)
  const granularityText = trend?.granularity === 'MONTH' ? '按月' : trend?.granularity === 'WEEK' ? '按周' : '按日'
  return (
    <section className="min-w-0 rounded-3xl border border-white bg-white p-4 shadow-card sm:p-5" data-testid="dashboard-trend">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-bold text-slate-900">营业趋势</h3><p className="mt-1 text-xs text-slate-400">{granularityText} · 部分覆盖点单独标记</p></div><div className="flex rounded-xl bg-slate-50 p-1">{[['revenue', '收入'], ['orderCount', '订单'], ['aov', '客单价']].map(([key, label]) => <button type="button" key={key} onClick={() => setMetric(key)} className={`min-h-8 rounded-lg px-2.5 text-[11px] font-bold ${metric === key ? 'bg-white text-budu-700 shadow-sm' : 'text-slate-400'}`}>{label}</button>)}</div></div>
      <div className="mt-5 flex min-h-52 items-end gap-3 overflow-x-auto pb-1" aria-label="营业趋势图">{points.map((point) => { const raw = trendValue(point, metric); const value = raw === null || raw === undefined ? null : BigInt(raw); const height = value === null || max === 0n ? 8 : Number((value * 78n / max) + 12n); return <div key={point.key} className="flex min-w-14 flex-1 flex-col items-center"><span className="mb-2 whitespace-nowrap text-[10px] font-bold tabular-nums text-slate-500">{formatTrendValue(raw, metric)}</span><div className="flex h-32 w-full items-end justify-center"><div className={`w-6 rounded-t-lg ${point.coverage.state === 'COMPLETE' ? 'bg-budu-400' : point.coverage.state === 'PARTIAL' ? 'bg-amber-300 ring-2 ring-amber-100' : 'bg-slate-200'}`} style={{ height: `${height}%` }} data-coverage-state={point.coverage.state} /></div><span className="mt-2 whitespace-nowrap text-[10px] text-slate-400">{trendLabel(point, trend.granularity)}</span></div> })}</div>
      {points.length === 1 && <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-500">单日范围按当日累计展示；混合来源不制造人工门店小时走势。</p>}
    </section>
  )
}

function DashboardStoreComparison({ rows = [] }) {
  const available = rows.filter((row) => row.revenueCents !== null)
  const max = available.reduce((value, row) => BigInt(row.revenueCents) > value ? BigInt(row.revenueCents) : value, 0n)
  return <section className="rounded-3xl border border-white bg-white p-4 shadow-card sm:p-5"><div className="flex items-start justify-between gap-3"><div><h3 className="font-bold text-slate-900">门店营业对比</h3><p className="mt-1 text-xs text-slate-400">按营业收入排序</p></div><Building2 className="h-5 w-5 text-budu-500" /></div><div className="mt-4 space-y-4">{rows.map((row) => { const width = row.revenueCents !== null && max > 0n ? Number(BigInt(row.revenueCents) * 100n / max) : 0; return <div key={row.storeKey}><div className="flex items-center justify-between gap-3 text-xs"><span className="truncate font-semibold text-slate-600">{row.storeName}</span><span className="font-black tabular-nums text-slate-800">{formatReportCents(row.revenueCents)}</span></div><div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-budu-400" style={{ width: `${width}%` }} /></div><p className="mt-1 text-[10px] text-slate-400">{formatReportInteger(row.orderCount, { suffix: ' 单' })} · 客单价 {formatReportCents(row.aovCents)}{row.coverageState !== 'COMPLETE' ? ' · 部分覆盖' : ''}</p></div> })}</div></section>
}

function ProductTopCard({ data, topSort, onTopSort, onOpen, onCoverage }) {
  return <section className="rounded-3xl border border-white bg-white p-4 shadow-card sm:p-5" data-testid="dashboard-product-top"><div className="flex items-start justify-between gap-3"><button type="button" onClick={onOpen} className="text-left"><h3 className="font-bold text-slate-900">商品 TOP 5</h3><p className="mt-1 text-xs text-slate-400">仅来自真实 OrderItem</p></button><CoverageBadge coverage={data?.coverage} onOpen={onCoverage} /></div><div className="mt-3 flex rounded-xl bg-slate-50 p-1">{[['productRevenue', '产品收入'], ['salesQuantity', '销量']].map(([key, label]) => <button type="button" key={key} onClick={() => onTopSort(key)} className={`min-h-8 flex-1 rounded-lg text-[11px] font-bold ${topSort === key ? 'bg-white text-budu-700 shadow-sm' : 'text-slate-400'}`}>{label}</button>)}</div><div className="mt-3 divide-y divide-slate-100">{(data?.rows || []).map((row, index) => <button type="button" key={row.productId} onClick={onOpen} className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 py-3 text-left"><span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-100 text-xs font-black text-slate-500">{index + 1}</span><span className="min-w-0"><span className="block truncate text-sm font-bold text-slate-700">{row.productName}</span><span className="mt-0.5 block text-[10px] text-slate-400">销量 {formatReportInteger(row.salesQuantity)}</span></span><span className="text-sm font-black tabular-nums text-slate-800">{topSort === 'salesQuantity' ? formatReportInteger(row.salesQuantity) : formatReportCents(row.productRevenueCents)}</span></button>)}</div>{(data?.rows || []).length === 0 && <p className="py-8 text-center text-xs text-slate-400">暂无商品级数据</p>}</section>
}

function DashboardReport({ data, loading, error, reload, storeMap, topSort, onTopSort, onCoverage, onTab }) {
  if (loading) return <LoadingBlock />
  if (error) return <ErrorBlock message={error} retry={reload} />
  return <div className="space-y-4 sm:space-y-5">
    <DashboardFreshness data={data} storeMap={storeMap} onCoverage={onCoverage} />
    <section className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">{dashboardMetricDefinitions.map(([key, label, Icon, money, target]) => <DashboardMetricCard key={key} metricKey={key} label={label} Icon={Icon} money={money} metric={data?.metrics?.[key]} comparison={data?.comparisons?.[key]} onCoverage={onCoverage} onOpen={() => onTab(target)} />)}<div className="min-w-0 rounded-2xl border border-dashed border-slate-200 bg-white/70 p-3.5 sm:p-5"><div className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-400"><Landmark className="h-4 w-4" /></div><p className="mt-3 text-lg font-black text-slate-400">—</p><p className="mt-1 text-xs font-semibold text-slate-400">经营利润</p><p className="mt-2 text-[10px] font-bold text-slate-400">最终模型暂未配置</p></div></section>
    <section className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,1fr)]"><TrendCard trend={data?.trend} /><DashboardStoreComparison rows={data?.storeComparison} /></section>
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-3"><CompositionCard title="渠道营业构成" note="仅统计已接入订单级数据的门店" data={data?.channelComposition} onCoverage={onCoverage} onDrillDown={() => onTab('summary')} /><CompositionCard title="收款 / 结算构成" note="来自真实 Payment 与 ExternalSettlement" data={data?.settlementComposition} onCoverage={onCoverage} onDrillDown={() => onTab('summary')} /><ProductTopCard data={data?.topProducts} topSort={topSort} onTopSort={onTopSort} onOpen={() => onTab('products')} onCoverage={onCoverage} /></section>
  </div>
}

function MetricCard({ metricKey, label, Icon, money, metric, onCoverage }) {
  const unavailable = metric?.valueCents === null || metric?.value === null
  const display = money ? formatReportCents(metric?.valueCents) : formatReportInteger(metric?.value, { suffix: ' 单' })
  return (
    <section className={`min-w-0 rounded-2xl border bg-white p-3.5 shadow-sm sm:p-5 ${unavailable ? 'border-slate-200/80' : 'border-white'}`} data-testid={`report-metric-${metricKey}`}>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-budu-50 text-budu-600"><Icon className="h-4 w-4" /></div>
        <CoverageBadge coverage={metric?.coverage} onOpen={onCoverage} />
      </div>
      <p className={`mt-3 truncate font-black tabular-nums tracking-tight text-slate-900 ${metricKey === 'revenue' ? 'text-[22px] sm:text-3xl' : 'text-lg sm:text-2xl'}`}>{display}</p>
      <p className="mt-1 text-xs font-semibold text-slate-400">{label}</p>
      {unavailable && <p className="mt-2 text-[11px] text-slate-400">暂无订单级数据</p>}
    </section>
  )
}

function CompositionCard({ title, note, data, onCoverage, onDrillDown }) {
  const total = (data?.rows || []).reduce((sum, row) => sum + BigInt(row.revenueCents || 0), 0n)
  return (
    <section className="rounded-3xl border border-white bg-white p-4 shadow-card sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div><button type="button" onClick={onDrillDown} className="font-bold text-slate-900 disabled:cursor-default" disabled={!onDrillDown}>{title}</button><p className="mt-1 text-xs leading-5 text-slate-400">{note}</p></div>
        <CoverageBadge coverage={data?.coverage} onOpen={onCoverage} />
      </div>
      <div className="mt-4 space-y-3">
        {(data?.rows || []).map((row) => {
          const bps = total > 0n ? (BigInt(row.revenueCents) * 10_000n) / total : null
          return <div key={row.key}><div className="flex items-center justify-between gap-3 text-xs"><span className="font-semibold text-slate-600">{title.includes('渠道') ? orderSourceText(row.key) : settlementText(row.key)}</span><span className="font-bold tabular-nums text-slate-700">{formatReportCents(row.revenueCents)}</span></div><div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-budu-400" style={{ width: `${shareWidth(bps)}%` }} /></div></div>
        })}
        {(data?.rows || []).length === 0 && <p className="py-8 text-center text-xs text-slate-400">{data?.coverage?.state === 'UNAVAILABLE' ? '暂无订单级数据' : '当前范围暂无结算订单'}</p>}
      </div>
    </section>
  )
}

function SummaryReport({ data, loading, error, reload, onCoverage }) {
  if (loading) return <LoadingBlock />
  if (error) return <ErrorBlock message={error} retry={reload} />
  return (
    <div className="space-y-4 sm:space-y-5">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {metricDefinitions.map(([key, label, Icon, money]) => <MetricCard key={key} metricKey={key} label={label} Icon={Icon} money={money} metric={data?.metrics?.[key]} onCoverage={onCoverage} />)}
      </section>
      <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <CompositionCard title="渠道营业构成" note="仅统计已接入订单级数据的门店" data={data?.channelComposition} onCoverage={onCoverage} />
        <CompositionCard title="收款 / 结算构成" note="来自 Payment 与 ExternalSettlement 真实结算事实" data={data?.settlementComposition} onCoverage={onCoverage} />
      </section>
      <section className="rounded-3xl border border-white bg-white p-4 shadow-card sm:p-5">
        <div className="flex items-start justify-between gap-3"><div><h3 className="font-bold text-slate-900">门店营业对比</h3><p className="mt-1 text-xs text-slate-400">以 LEVEL A 营业收入为统一排行指标</p></div><Building2 className="h-5 w-5 text-budu-500" /></div>
        <div className="mt-4 divide-y divide-slate-100">
          {(data?.storeComparison || []).map((row, index) => <div key={row.storeKey} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 py-3"><span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-100 text-xs font-black text-slate-500">{index + 1}</span><div className="min-w-0"><p className="truncate text-sm font-bold text-slate-700">{row.storeName}</p><p className="mt-0.5 text-[11px] text-slate-400">{formatReportInteger(row.orderCount, { suffix: ' 单' })} · 客单价 {formatReportCents(row.aovCents)}</p></div><div className="text-right"><p className="text-sm font-black tabular-nums text-slate-800">{formatReportCents(row.revenueCents)}</p>{row.coverageState !== 'COMPLETE' && <span className="text-[10px] font-bold text-amber-600">{row.coverageState === 'PARTIAL' ? '部分日期' : '暂无'}</span>}</div></div>)}
        </div>
      </section>
    </div>
  )
}

function Pagination({ page, pageSize, total, onChange }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return <div className="flex items-center justify-between rounded-2xl border border-slate-100 bg-white px-3 py-2 text-xs text-slate-500"><span>共 {total} 条</span><div className="flex items-center gap-2"><button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)} className="grid h-10 w-10 place-items-center rounded-xl border border-slate-200 disabled:opacity-30" aria-label="上一页"><ChevronLeft className="h-4 w-4" /></button><span className="min-w-14 text-center font-bold">{page} / {pages}</span><button type="button" disabled={page >= pages} onClick={() => onChange(page + 1)} className="grid h-10 w-10 place-items-center rounded-xl border border-slate-200 disabled:opacity-30" aria-label="下一页"><ChevronRight className="h-4 w-4" /></button></div></div>
}

function OrdersReport({ data, loading, error, reload, storeMap, page, onPage, onCoverage, onDetail }) {
  if (loading) return <LoadingBlock />
  if (error) return <ErrorBlock message={error} retry={reload} />
  return <div className="space-y-4"><CoverageNotice coverage={data?.coverage} storeMap={storeMap} onOpen={onCoverage} noun="订单明细" />
    <div className="space-y-3 md:hidden">{(data?.rows || []).map((order) => <button type="button" key={order.id} onClick={() => onDetail(order.id)} className="w-full rounded-2xl border border-white bg-white p-4 text-left shadow-sm"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold text-slate-400">{localReportTime(order.createdAt)}</p><p className="mt-1 text-sm font-bold text-slate-800">{storeMap.get(order.storeKey) || order.storeKey}</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">{orderStatusText(order.status)}</span></div><div className="mt-4 flex items-end justify-between gap-3"><div><p className="text-sm font-bold text-budu-700">{orderSourceText(order.orderSource)}</p><p className="mt-1 text-xs text-slate-400">{settlementText(order.settlementType)}</p></div><p className="text-lg font-black tabular-nums text-slate-900">{formatReportCents(order.settlementCents)}</p></div><p className="mt-3 truncate font-mono text-[10px] text-slate-300">{order.orderNo}</p></button>)}</div>
    <div className="hidden overflow-x-auto rounded-3xl border border-slate-100 bg-white shadow-sm md:block"><table className="min-w-[1120px] w-full text-left text-xs"><thead className="bg-slate-50 text-slate-400"><tr>{['营业日期 / 下单时间', 'BUDU 订单号', '门店', '来源', '营业额', '结算金额', '结算方式', '支付状态', '退款状态', '最后退款'].map((label) => <th key={label} className="px-4 py-3 font-bold">{label}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{(data?.rows || []).map((order) => <tr key={order.id} onClick={() => onDetail(order.id)} className="cursor-pointer text-slate-600 transition hover:bg-budu-50/40"><td className="px-4 py-3"><p className="font-bold text-slate-700">{order.date}</p><p className="mt-0.5 text-[11px] text-slate-400">{localReportTime(order.createdAt)}</p></td><td className="px-4 py-3 font-mono text-[11px]">{order.orderNo}</td><td className="px-4 py-3 font-semibold">{storeMap.get(order.storeKey) || order.storeKey}</td><td className="px-4 py-3">{orderSourceText(order.orderSource)}</td><td className="px-4 py-3 font-bold tabular-nums">{formatReportCents(order.grossCents)}</td><td className="px-4 py-3 font-bold tabular-nums">{formatReportCents(order.settlementCents)}</td><td className="px-4 py-3">{settlementText(order.settlementType)}</td><td className="px-4 py-3">{order.paymentStatus === 'paid' ? '已支付' : order.paymentStatus}</td><td className="px-4 py-3">{orderStatusText(order.status)}</td><td className="px-4 py-3">{localReportTime(order.lastRefundAt)}</td></tr>)}</tbody></table></div>
    {(data?.rows || []).length === 0 && <div className="rounded-3xl bg-white py-14 text-center text-sm text-slate-400">{data?.coverage?.state === 'UNAVAILABLE' ? '暂无订单级数据' : '当前筛选范围没有订单'}</div>}
    <Pagination page={page} pageSize={data?.pageSize || PAGE_SIZE} total={data?.total || 0} onChange={onPage} />
  </div>
}

function ProductDetailSheet({ product, onClose }) {
  if (!product) return null
  return (
    <OverlayViewport className="fixed inset-0 z-[100] flex items-end bg-slate-900/40 backdrop-blur-sm sm:items-center sm:justify-center sm:p-4" role="dialog" aria-modal="true" aria-label="商品销售详情">
      <button type="button" className="absolute inset-0" onClick={onClose} aria-label="关闭商品详情" />
      <OverlayPanel className="relative flex max-h-[86dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-[1.75rem] bg-white shadow-2xl sm:rounded-[1.75rem]">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-200 sm:hidden" />
        <OverlayHeader className="flex items-center border-b border-slate-100 px-5 py-4">
          <div className="min-w-0"><h3 className="truncate font-bold text-slate-900">{product.productName}</h3><p className="mt-0.5 font-mono text-[11px] text-slate-400">{product.sku || '无 SKU'}</p></div>
          <button type="button" onClick={onClose} className="ml-auto grid h-10 w-10 place-items-center rounded-xl bg-slate-50 text-slate-400" aria-label="关闭"><X className="h-4 w-4" /></button>
        </OverlayHeader>
        <OverlayScrollRegion className="grid grid-cols-2 gap-3 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 sm:px-5">
          {productFields.map(([label, valueKey, shareKey, money]) => <div key={valueKey} className="rounded-2xl bg-slate-50 p-3"><p className="text-[11px] font-semibold text-slate-400">{label}</p><p className="mt-1 text-sm font-black tabular-nums text-slate-800">{money ? formatReportCents(product[valueKey]) : formatReportInteger(product[valueKey])}</p><p className="mt-1 text-[10px] text-slate-400">占比 {formatReportBps(product[shareKey])}</p></div>)}
          <div className="col-span-2 rounded-2xl border border-budu-100 bg-budu-50 p-4"><p className="text-xs font-semibold text-budu-600">产品点单率</p><p className="mt-1 text-xl font-black text-budu-800">{formatReportBps(product.orderRateBps)}</p><p className="mt-1 text-[10px] text-budu-500">{product.orderRateNumerator} / {product.orderRateDenominator} 个有效订单</p></div>
        </OverlayScrollRegion>
      </OverlayPanel>
    </OverlayViewport>
  )
}

function ProductsReport({ data, loading, error, reload, storeMap, page, onPage, onCoverage, onDetail }) {
  if (loading) return <LoadingBlock />
  if (error) return <ErrorBlock message={error} retry={reload} />
  return <div className="space-y-4"><CoverageNotice coverage={data?.coverage} storeMap={storeMap} onOpen={onCoverage} noun="商品销售" />
    <div className="space-y-3 md:hidden">{(data?.rows || []).map((product) => <button type="button" key={product.productId} onClick={() => onDetail(product)} className="w-full rounded-2xl border border-white bg-white p-4 text-left shadow-sm"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-black text-slate-800">{product.productName}</p><p className="mt-1 truncate font-mono text-[10px] text-slate-300">{product.sku || '无 SKU'}</p></div><span className="shrink-0 rounded-full bg-budu-50 px-2.5 py-1 text-xs font-bold text-budu-700">点单率 {formatReportBps(product.orderRateBps)}</span></div><div className="mt-4 grid grid-cols-2 gap-3"><div><p className="text-[11px] text-slate-400">销量</p><p className="mt-1 text-lg font-black text-slate-800">{formatReportInteger(product.salesQuantity)}</p></div><div className="text-right"><p className="text-[11px] text-slate-400">产品收入</p><p className="mt-1 text-lg font-black text-slate-800">{formatReportCents(product.productRevenueCents)}</p></div></div><p className="mt-3 text-center text-[11px] font-semibold text-budu-600">点击查看销售、优惠、退款与赠送明细</p></button>)}</div>
    <div className="hidden overflow-x-auto rounded-3xl border border-slate-100 bg-white shadow-sm md:block"><table className="min-w-[1460px] w-full text-left text-xs"><thead className="bg-slate-50 text-slate-400"><tr><th className="sticky left-0 z-10 bg-slate-50 px-4 py-3">商品</th>{productFields.map(([label]) => <th key={label} className="px-4 py-3 text-right">{label} / 占比</th>)}<th className="px-4 py-3 text-right">产品点单率</th></tr></thead><tbody className="divide-y divide-slate-100">{(data?.rows || []).map((product) => <tr key={product.productId} onClick={() => onDetail(product)} className="cursor-pointer hover:bg-budu-50/30"><td className="sticky left-0 bg-white px-4 py-3"><p className="font-bold text-slate-700">{product.productName}</p><p className="mt-0.5 font-mono text-[10px] text-slate-300">{product.sku}</p></td>{productFields.map(([, valueKey, shareKey, money]) => <td key={valueKey} className="px-4 py-3 text-right"><p className="font-bold tabular-nums text-slate-700">{money ? formatReportCents(product[valueKey]) : formatReportInteger(product[valueKey])}</p><p className="mt-0.5 text-[10px] text-slate-400">{formatReportBps(product[shareKey])}</p></td>)}<td className="px-4 py-3 text-right font-black text-budu-700">{formatReportBps(product.orderRateBps)}</td></tr>)}</tbody></table></div>
    {(data?.rows || []).length === 0 && <div className="rounded-3xl bg-white py-14 text-center text-sm text-slate-400">{data?.coverage?.state === 'UNAVAILABLE' ? '暂无订单级数据' : '没有匹配的商品'}</div>}
    <Pagination page={page} pageSize={data?.pageSize || PAGE_SIZE} total={data?.total || 0} onChange={onPage} />
  </div>
}

export default function ReportCenterPage({ currentUser, onBack, onNavigate }) {
  const canSales = hasReportSalesView(currentUser)
  const [tab, setTab] = useState(canSales ? 'dashboard' : 'profit')
  const [preset, setPreset] = useState('today')
  const [custom, setCustom] = useState(() => reportDateRange('today'))
  const [store, setStore] = useState('all')
  const [comparisonMode, setComparisonMode] = useState('previous')
  const [dashboardTopSort, setDashboardTopSort] = useState('productRevenue')
  const [orderSource, setOrderSource] = useState('')
  const [settlementType, setSettlementType] = useState('')
  const [productSearch, setProductSearch] = useState('')
  const [productSort, setProductSort] = useState('productRevenue')
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [coverage, setCoverage] = useState(null)
  const [orderDetail, setOrderDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [productDetail, setProductDetail] = useState(null)
  const range = useMemo(() => reportDateRange(preset, custom), [preset, custom])
  const allowedStores = useMemo(() => {
    const stores = allStores()
    if (hasReportAllStores(currentUser)) return stores
    const allowed = new Set(currentUser?.storeKeys || [])
    return stores.filter((item) => allowed.has(item.key))
  }, [currentUser])
  const storeMap = useMemo(() => new Map(allowedStores.map((item) => [item.key, item.name])), [allowedStores])
  const coreTab = REPORT_TABS.some((item) => item.key === tab)

  useEffect(() => { setPage(1) }, [tab, range.from, range.to, store, orderSource, settlementType, productSearch, productSort])

  useEffect(() => {
    if (!canSales || !coreTab) return undefined
    const controller = new AbortController()
    const params = new URLSearchParams({ from: range.from, to: range.to })
    if (store !== 'all') params.set('store', store)
    let endpoint = '/v2/report-center/summary'
    if (tab === 'dashboard') {
      endpoint = '/v2/report-center/dashboard'
      params.set('compare', comparisonMode)
      params.set('period', preset)
      params.set('topSort', dashboardTopSort)
    } else if (tab === 'orders') {
      endpoint = '/v2/report-center/orders'
      params.set('page', String(page)); params.set('pageSize', String(PAGE_SIZE))
      if (orderSource) params.set('orderSource', orderSource)
      if (settlementType) params.set('settlementType', settlementType)
    } else if (tab === 'products') {
      endpoint = '/v2/report-center/products'
      params.set('page', String(page)); params.set('pageSize', String(PAGE_SIZE)); params.set('sort', productSort)
      if (productSearch.trim()) params.set('search', productSearch.trim())
    }
    setLoading(true); setError('')
    api(`${endpoint}?${params}`, { signal: controller.signal }).then(setData).catch((err) => {
      if (err.name !== 'AbortError') setError(err.message || '报表加载失败')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [canSales, coreTab, tab, range.from, range.to, store, comparisonMode, dashboardTopSort, preset, orderSource, settlementType, productSearch, productSort, page, reloadKey])

  const openOrder = async (id) => {
    setDetailLoading(true); setError('')
    try { setOrderDetail(await api(`/v2/report-center/orders/${encodeURIComponent(id)}`)) } catch (err) { setError(err.message) } finally { setDetailLoading(false) }
  }

  const legacy = [
    { key: 'profit', label: '经营利润', icon: Landmark, enabled: hasModuleAccess(currentUser, 'finance') },
    { key: 'inventory-transfer', label: '调拨报表', icon: BarChart3, enabled: hasModuleAccess(currentUser, 'inventory-transfer') },
    { key: 'partner-supply', label: '合作商供货', icon: Boxes, enabled: hasModuleAccess(currentUser, 'partner-supply') },
    { key: 'staff-payroll', label: '工资报表', icon: FileSpreadsheet, enabled: hasModuleAccess(currentUser, 'staff-payroll') },
  ].filter((item) => item.enabled)

  return (
    <div className="space-y-4 sm:space-y-5" data-testid="report-center-page">
      <header className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onBack} className="grid h-11 w-11 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm" aria-label="返回首页"><ArrowLeft className="h-5 w-5" /></button>
        <div><h2 className="text-xl font-black text-slate-900">报表中心</h2><p className="mt-0.5 text-xs text-slate-400">经营事实、订单与商品数据统一查看</p></div>
        <button type="button" disabled className="ml-auto hidden min-h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-400 sm:flex" title="完整筛选导出将在后续 Gate 开放"><FileSpreadsheet className="h-4 w-4" />导出待开放</button>
      </header>

      <nav className="flex gap-2 overflow-x-auto pb-1" aria-label="核心报表">{REPORT_TABS.map((item) => <button type="button" key={item.key} disabled={!canSales} onClick={() => setTab(item.key)} className={`min-h-11 shrink-0 rounded-xl px-4 text-sm font-bold transition ${tab === item.key ? 'bg-budu-600 text-white shadow-sm' : 'border border-slate-200 bg-white text-slate-600'} disabled:opacity-40`}>{item.label}</button>)}</nav>

      <section className="rounded-2xl border border-slate-100 bg-white p-3 shadow-sm"><p className="px-1 text-[11px] font-bold text-slate-400">现有经营报表</p><div className="mt-2 flex gap-2 overflow-x-auto">{legacy.map((item) => { const Icon = item.icon; return <button type="button" key={item.key} onClick={() => item.key === 'profit' ? setTab('profit') : onNavigate(item.key)} className={`flex min-h-10 shrink-0 items-center gap-2 rounded-xl px-3 text-xs font-bold ${tab === item.key ? 'bg-slate-800 text-white' : 'bg-slate-50 text-slate-600'}`}><Icon className="h-3.5 w-3.5" />{item.label}</button> })}</div></section>

      {!canSales && tab !== 'profit' && <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">当前账号未开通销售报表查看权限。</div>}

      {coreTab && canSales && <section className="rounded-3xl border border-slate-100 bg-white p-3 shadow-sm sm:p-4" data-testid="report-global-filter"><div className="flex gap-2 overflow-x-auto">{[['today', '今天'], ['yesterday', '昨天'], ['week', '本周'], ['month', '本月'], ['custom', '自定义']].map(([key, label]) => <button type="button" key={key} onClick={() => setPreset(key)} className={`min-h-10 shrink-0 rounded-xl px-3 text-xs font-bold ${preset === key ? 'bg-budu-50 text-budu-700 ring-1 ring-budu-200' : 'bg-slate-50 text-slate-500'}`}>{label}</button>)}</div><div className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">{preset === 'custom' && <><input aria-label="开始日期" type="date" value={custom.from} onChange={(event) => setCustom((value) => ({ ...value, from: event.target.value }))} className={inputClass} /><input aria-label="结束日期" type="date" value={custom.to} onChange={(event) => setCustom((value) => ({ ...value, to: event.target.value }))} className={inputClass} /></>}<select aria-label="报表门店" value={store} onChange={(event) => setStore(event.target.value)} className={`${inputClass} col-span-2 sm:min-w-48`}><option value="all">全部授权门店</option>{allowedStores.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}</select>{tab === 'dashboard' && <select aria-label="对比周期" value={comparisonMode} onChange={(event) => setComparisonMode(event.target.value)} className={inputClass}><option value="previous">对比上一周期</option><option value="year">对比去年同期</option></select>}{tab === 'orders' && <><select aria-label="订单来源" value={orderSource} onChange={(event) => setOrderSource(event.target.value)} className={inputClass}>{ORDER_SOURCE_OPTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select aria-label="结算方式" value={settlementType} onChange={(event) => setSettlementType(event.target.value)} className={inputClass}>{SETTLEMENT_OPTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></>}{tab === 'products' && <><label className="relative col-span-2 min-w-0 flex-1 sm:max-w-xs"><Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-400" /><input aria-label="搜索商品" value={productSearch} onChange={(event) => setProductSearch(event.target.value)} placeholder="商品名称 / SKU" className={`${inputClass} w-full pl-9`} /></label><select aria-label="商品排序" value={productSort} onChange={(event) => setProductSort(event.target.value)} className={inputClass}><option value="productRevenue">按产品收入</option><option value="salesQuantity">按销售数量</option><option value="salesCents">按销售金额</option></select></>}</div></section>}

      {tab === 'dashboard' && canSales && <DashboardReport data={data} loading={loading} error={error} reload={() => setReloadKey((value) => value + 1)} storeMap={storeMap} topSort={dashboardTopSort} onTopSort={setDashboardTopSort} onCoverage={setCoverage} onTab={setTab} />}
      {tab === 'summary' && canSales && <SummaryReport data={data} loading={loading} error={error} reload={() => setReloadKey((value) => value + 1)} onCoverage={setCoverage} />}
      {tab === 'orders' && canSales && <OrdersReport data={data} loading={loading} error={error} reload={() => setReloadKey((value) => value + 1)} storeMap={storeMap} page={page} onPage={setPage} onCoverage={setCoverage} onDetail={openOrder} />}
      {tab === 'products' && canSales && <ProductsReport data={data} loading={loading} error={error} reload={() => setReloadKey((value) => value + 1)} storeMap={storeMap} page={page} onPage={setPage} onCoverage={setCoverage} onDetail={setProductDetail} />}
      {tab === 'profit' && <div className="space-y-3"><div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">历史“财务利润”能力原样保留；其 DailyEntry 收入减 Expense 结果不是新经营利润权威。</div><FinancePage currentUser={currentUser} embedded /></div>}
      {detailLoading && <div className="fixed inset-0 z-[95] grid place-items-center bg-white/70 text-sm font-bold text-slate-500 backdrop-blur-sm">正在读取订单事实…</div>}
      <CoverageSheet coverage={coverage} storeMap={storeMap} onClose={() => setCoverage(null)} />
      <OrderDetailSheet order={orderDetail} onClose={() => setOrderDetail(null)} />
      <ProductDetailSheet product={productDetail} onClose={() => setProductDetail(null)} />
    </div>
  )
}
