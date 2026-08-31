import { Prisma } from '@prisma/client'
import { hasReportAllStores, hasReportSalesView } from '../shared/accountPermissions.js'
import { buduBusinessDate } from '../shared/businessDate.js'
import { httpError } from './pos-core.js'

export const REPORT_COVERAGE_STATES = Object.freeze({
  COMPLETE: 'COMPLETE',
  PARTIAL: 'PARTIAL',
  UNAVAILABLE: 'UNAVAILABLE',
})

export const REPORT_COMPARISON_STATES = Object.freeze({
  COMPLETE: 'COMPLETE',
  PARTIAL: 'PARTIAL',
  INCOMPARABLE: 'INCOMPARABLE',
  NO_PRIOR_DATA: 'NO_PRIOR_DATA',
})

export const DAILY_SALES_AUTHORITIES = Object.freeze({
  POS: 'POS',
  MANUAL: 'MANUAL_DAILY_ENTRY',
  CONFLICT: 'AUTHORITY_CONFLICT',
})

const SETTLED_ORDER_STATUSES = Object.freeze(['completed', 'partially_refunded', 'refunded'])
const EFFECTIVE_ORDER_STATUSES = Object.freeze(['completed', 'partially_refunded'])
const ORDER_SOURCES = new Set(['STORE_POS', 'MEITUAN', 'TAOBAO_FLASH', 'JD_INSTANT', 'OTHER'])
const SETTLEMENT_TYPES = new Set(['WECHAT', 'ALIPAY', 'CASH', 'PLATFORM', 'CUSTOM'])
const PRODUCT_SORTS = new Set(['productRevenue', 'salesQuantity', 'salesCents'])
const COMPARISON_MODES = new Set(['previous', 'year'])
const MAX_RANGE_DAYS = 92
const MAX_PAGE_SIZE = 100

function isoDate(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : ''
}

function dateOnly(value) {
  return new Date(`${value}T00:00:00.000Z`)
}

function addDays(value, amount) {
  const date = dateOnly(value)
  date.setUTCDate(date.getUTCDate() + amount)
  return isoDate(date)
}

function daysInUtcMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function shiftMonthClamped(value, amount) {
  const date = dateOnly(value)
  const originalDay = date.getUTCDate()
  const monthIndex = date.getUTCFullYear() * 12 + date.getUTCMonth() + amount
  const year = Math.floor(monthIndex / 12)
  const month = ((monthIndex % 12) + 12) % 12
  const day = Math.min(originalDay, daysInUtcMonth(year, month + 1))
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function shiftYearClamped(value, amount) {
  const date = dateOnly(value)
  const year = date.getUTCFullYear() + amount
  const month = date.getUTCMonth() + 1
  const day = Math.min(date.getUTCDate(), daysInUtcMonth(year, month))
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function resolveComparisonRange(range, mode = 'previous', period = '') {
  if (!COMPARISON_MODES.has(mode)) throw httpError('报表对比方式不正确')
  if (mode === 'year') return {
    mode,
    from: shiftYearClamped(range.from, -1),
    to: shiftYearClamped(range.to, -1),
  }
  if (period === 'month' && range.from.endsWith('-01') && range.from.slice(0, 7) === range.to.slice(0, 7)) {
    return { mode, from: shiftMonthClamped(range.from, -1), to: shiftMonthClamped(range.to, -1) }
  }
  const length = range.days.length
  const to = addDays(range.from, -1)
  return { mode, from: addDays(to, 1 - length), to }
}

function validDate(value) {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || isoDate(dateOnly(text)) !== text) throw httpError('报表日期格式应为 YYYY-MM-DD')
  return text
}

export function normalizeReportRange(query = {}) {
  const from = validDate(query.from)
  const to = validDate(query.to)
  if (from > to) throw httpError('报表开始日期不能晚于结束日期')
  const days = []
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
    days.push(cursor)
    if (days.length > MAX_RANGE_DAYS) throw httpError(`报表查询范围不能超过 ${MAX_RANGE_DAYS} 天`)
  }
  return { from, to, days, start: dateOnly(from), endExclusive: dateOnly(addDays(to, 1)) }
}

function configuredAuthority(store, date) {
  const source = String(store?.salesDataSource || '').trim()
  const effectiveDate = isoDate(store?.salesDataSourceEffectiveDate)
  const effectiveSource = effectiveDate && date < effectiveDate ? 'manual' : source
  if (effectiveSource === 'manual') return { authority: DAILY_SALES_AUTHORITIES.MANUAL, evidence: 'STORE_EFFECTIVE_CONFIG' }
  if (effectiveSource === 'pos') return { authority: DAILY_SALES_AUTHORITIES.POS, evidence: 'STORE_EFFECTIVE_CONFIG' }
  return { authority: DAILY_SALES_AUTHORITIES.CONFLICT, evidence: 'STORE_EFFECTIVE_CONFIG', reasonCode: 'UNSUPPORTED_OR_HYBRID_SOURCE' }
}

function auditAuthority(audits) {
  const values = new Set()
  for (const audit of audits || []) {
    const value = String(audit?.afterValue?.salesAuthority || '').trim()
    if (value) values.add(value)
  }
  if (values.size === 0) return null
  if (values.size > 1 || values.has('hybrid')) return { authority: DAILY_SALES_AUTHORITIES.CONFLICT, reasonCode: 'CONFLICTING_SOURCE_SNAPSHOTS' }
  const value = [...values][0]
  if (value === 'manual') return { authority: DAILY_SALES_AUTHORITIES.MANUAL }
  if (value === 'pos') return { authority: DAILY_SALES_AUTHORITIES.POS }
  return { authority: DAILY_SALES_AUTHORITIES.CONFLICT, reasonCode: 'UNKNOWN_SOURCE_SNAPSHOT' }
}

/**
 * A confirmed DailyEntry carries the historical source snapshot: POS confirmations
 * have posSyncAt; manual confirmations do not. The DailyEntry confirmation audit is
 * an additional immutable check. Current Store configuration is only a fallback for
 * days without a confirmed snapshot and cannot rewrite confirmed history.
 */
export function resolveDailySalesAuthority({ store, date, entry, audits = [] }) {
  if (entry?.status === 'confirmed') {
    const persisted = entry.posSyncAt ? DAILY_SALES_AUTHORITIES.POS : DAILY_SALES_AUTHORITIES.MANUAL
    const audited = auditAuthority(audits)
    if (audited?.authority === DAILY_SALES_AUTHORITIES.CONFLICT || (audited && audited.authority !== persisted)) {
      return {
        authority: DAILY_SALES_AUTHORITIES.CONFLICT,
        evidence: 'DAILY_ENTRY_SOURCE_SNAPSHOT',
        reasonCode: audited?.reasonCode || 'SOURCE_SNAPSHOT_MISMATCH',
      }
    }
    return { authority: persisted, evidence: audited ? 'DAILY_ENTRY_AUDIT_SNAPSHOT' : 'DAILY_ENTRY_SOURCE_SNAPSHOT' }
  }
  return configuredAuthority(store, date)
}

function parseStoreFilter(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',')
  const storeKeys = [...new Set(raw.map((item) => String(item || '').trim()).filter(Boolean))]
  if (storeKeys.some((key) => key.length > 80) || storeKeys.length > 100) throw httpError('门店筛选不正确')
  return storeKeys
}

function parsePage(query = {}) {
  const page = Number(query.page || 1)
  const pageSize = Number(query.pageSize || 30)
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw httpError(`分页参数不正确，单页最多 ${MAX_PAGE_SIZE} 条`)
  }
  return { page, pageSize, offset: (page - 1) * pageSize }
}

function parseOrderFilters(query = {}) {
  const orderSource = String(query.orderSource || '').trim().toUpperCase()
  const settlementType = String(query.settlementType || '').trim().toUpperCase()
  if (orderSource && !ORDER_SOURCES.has(orderSource)) throw httpError('订单来源筛选不正确')
  if (settlementType && !SETTLEMENT_TYPES.has(settlementType)) throw httpError('结算方式筛选不正确')
  return { orderSource: orderSource || null, settlementType: settlementType || null }
}

function parseProductFilters(query = {}) {
  const search = String(query.search || '').trim()
  const sort = String(query.sort || 'productRevenue').trim()
  if (search.length > 80) throw httpError('商品搜索内容过长')
  if (!PRODUCT_SORTS.has(sort)) throw httpError('商品排序不正确')
  return { search, sort }
}

function storeDayKey(storeKey, date) {
  return `${storeKey}|${date}`
}

function summarizeCoverage(metric, allDays, supported) {
  const byStore = new Map()
  const reasonCodes = new Set()
  for (const day of allDays) {
    const state = byStore.get(day.storeKey) || { covered: 0, uncovered: 0 }
    const result = supported(day)
    if (result.ok) state.covered += 1
    else {
      state.uncovered += 1
      reasonCodes.add(result.reasonCode)
    }
    byStore.set(day.storeKey, state)
  }
  const coveredStoreDays = [...byStore.values()].reduce((sum, row) => sum + row.covered, 0)
  const uncoveredStoreDays = [...byStore.values()].reduce((sum, row) => sum + row.uncovered, 0)
  const state = coveredStoreDays === 0
    ? REPORT_COVERAGE_STATES.UNAVAILABLE
    : uncoveredStoreDays === 0
      ? REPORT_COVERAGE_STATES.COMPLETE
      : REPORT_COVERAGE_STATES.PARTIAL
  return {
    metric,
    state,
    coveredStores: [...byStore.entries()].filter(([, row]) => row.covered > 0 && row.uncovered === 0).map(([key]) => key),
    partialStores: [...byStore.entries()].filter(([, row]) => row.covered > 0 && row.uncovered > 0).map(([key]) => key),
    uncoveredStores: [...byStore.entries()].filter(([, row]) => row.covered === 0).map(([key]) => key),
    coveredStoreDays,
    uncoveredStoreDays,
    reasonCodes: [...reasonCodes].sort(),
  }
}

function summarySupport(day, businessDate) {
  if (day.authority === DAILY_SALES_AUTHORITIES.CONFLICT) return { ok: false, reasonCode: day.reasonCode || 'AUTHORITY_CONFLICT' }
  if (day.date > businessDate) return { ok: false, reasonCode: 'FUTURE_NOT_OCCURRED' }
  if (day.authority === DAILY_SALES_AUTHORITIES.POS) return { ok: true }
  if (!day.entry) return {
    ok: false,
    reasonCode: day.date === businessDate ? 'TODAY_PENDING_CLOSE' : 'HISTORICAL_DATA_INCOMPLETE',
  }
  if (day.entry.status !== 'confirmed') return {
    ok: false,
    reasonCode: day.date === businessDate ? 'TODAY_PENDING_CLOSE' : 'HISTORICAL_DRAFT_ENTRY',
  }
  return { ok: true }
}

function orderSupport(day) {
  if (day.authority === DAILY_SALES_AUTHORITIES.CONFLICT) return { ok: false, reasonCode: day.reasonCode || 'AUTHORITY_CONFLICT' }
  return day.authority === DAILY_SALES_AUTHORITIES.POS
    ? { ok: true }
    : { ok: false, reasonCode: 'MANUAL_DAILY_SUMMARY_ONLY' }
}

function selectedDaysCte(days) {
  if (!days.length) return null
  const rows = days.map((day) => Prisma.sql`(${day.storeKey}, ${day.date}::date)`)
  return Prisma.sql`selected_days(store_id, business_date) AS (VALUES ${Prisma.join(rows)})`
}

function settledOrdersCte() {
  return Prisma.sql`
    settled_orders AS (
      SELECT o.*
      FROM "orders" o
      JOIN selected_days d ON d.store_id = o."store_id" AND d.business_date = o."business_date"
      WHERE o."status"::text IN (${Prisma.join(SETTLED_ORDER_STATUSES)})
        AND (
          (o."settlement_authority"::text = 'PAYMENT' AND EXISTS (
            SELECT 1 FROM "payments" p
            WHERE p."order_id" = o."id" AND p."status" IN ('success', 'partially_refunded', 'refunded')
          ))
          OR
          (o."settlement_authority"::text = 'EXTERNAL' AND EXISTS (
            SELECT 1 FROM "external_settlements" es
            WHERE es."order_id" = o."id" AND es."status"::text IN ('CONFIRMED', 'PARTIALLY_REFUNDED', 'REFUNDED')
          ))
        )
    )`
}

function orderMetricsCtes() {
  return Prisma.sql`
    item_totals AS (
      SELECT oi."order_id",
        COALESCE(SUM(CASE WHEN NOT oi."is_gift" THEN oi."unit_price" * oi."quantity"::bigint ELSE 0 END), 0)::bigint AS gross_cents,
        COALESCE(SUM(CASE WHEN NOT oi."is_gift" THEN oi."discount_amount" ELSE 0 END), 0)::bigint AS discount_cents
      FROM "order_items" oi JOIN settled_orders o ON o."id" = oi."order_id"
      GROUP BY oi."order_id"
    ),
    refund_totals AS (
      SELECT r."order_id", COALESCE(SUM(r."refund_amount"), 0)::bigint AS refund_cents
      FROM "refunds" r JOIN settled_orders o ON o."id" = r."order_id"
      WHERE r."status" = 'completed'
      GROUP BY r."order_id"
    ),
    order_metrics AS (
      SELECT o.*,
        COALESCE(i.gross_cents, 0)::bigint AS gross_cents,
        COALESCE(i.discount_cents, 0)::bigint AS discount_cents,
        COALESCE(r.refund_cents, 0)::bigint AS refund_cents,
        (COALESCE(i.gross_cents, 0) - COALESCE(i.discount_cents, 0) - COALESCE(r.refund_cents, 0))::bigint AS revenue_cents,
        CASE WHEN o."status"::text IN (${Prisma.join(EFFECTIVE_ORDER_STATUSES)}) THEN 1 ELSE 0 END AS effective_order
      FROM settled_orders o
      LEFT JOIN item_totals i ON i."order_id" = o."id"
      LEFT JOIN refund_totals r ON r."order_id" = o."id"
    )`
}

function amountMetric(value, coverage) {
  return { valueCents: coverage.state === REPORT_COVERAGE_STATES.UNAVAILABLE || value === null ? null : BigInt(value).toString(), coverage }
}

function countMetric(value, coverage) {
  return { value: coverage.state === REPORT_COVERAGE_STATES.UNAVAILABLE ? null : Number(value), coverage }
}

function basisPoints(numerator, denominator) {
  const total = BigInt(denominator || 0)
  return total > 0n ? ((BigInt(numerator || 0) * 10_000n) / total).toString() : null
}

function sumDaily(daily, storeKeys, field) {
  const allowed = new Set(storeKeys)
  return daily.reduce((sum, row) => {
    if (!allowed.has(row.storeKey) || row[field] === null || row[field] === undefined) return sum
    return sum + BigInt(row[field])
  }, 0n)
}

function levelCoverage(summary, level) {
  return level === 'ORDER_LEVEL' ? summary.coverage.orders : summary.coverage.dailySummary
}

function comparisonCoverage(current, comparison, level, mode) {
  const currentCoverage = levelCoverage(current, level)
  const priorCoverage = levelCoverage(comparison, level)
  const currentComplete = new Set(currentCoverage.coveredStores || [])
  const priorComplete = new Set(priorCoverage.coveredStores || [])
  const comparableStores = current.stores.map((row) => row.storeKey).filter((key) => currentComplete.has(key) && priorComplete.has(key))
  const allStores = current.stores.map((row) => row.storeKey)
  const noPriorData = priorCoverage.coveredStoreDays === 0
  const state = noPriorData
    ? REPORT_COMPARISON_STATES.NO_PRIOR_DATA
    : comparableStores.length === 0
      ? REPORT_COMPARISON_STATES.INCOMPARABLE
      : comparableStores.length === allStores.length
        ? REPORT_COMPARISON_STATES.COMPLETE
        : REPORT_COMPARISON_STATES.PARTIAL
  return {
    state,
    mode,
    currentRange: current.range,
    comparisonRange: comparison.range,
    totalStores: allStores.length,
    currentCoveredStores: allStores.filter((key) => currentComplete.has(key)),
    comparisonCoveredStores: allStores.filter((key) => priorComplete.has(key)),
    comparableStores,
    excludedStores: allStores.filter((key) => !comparableStores.includes(key)),
    reasonCodes: state === REPORT_COMPARISON_STATES.NO_PRIOR_DATA
      ? ['NO_COMPARISON_DATA']
      : state === REPORT_COMPARISON_STATES.INCOMPARABLE
        ? ['DATA_COVERAGE_INCOMPARABLE']
        : state === REPORT_COMPARISON_STATES.PARTIAL
          ? ['PARTIAL_SAME_STORE_COVERAGE']
          : [],
  }
}

function comparisonMetric(current, comparison, field, unit, coverage) {
  if (![REPORT_COMPARISON_STATES.COMPLETE, REPORT_COMPARISON_STATES.PARTIAL].includes(coverage.state)) {
    return { unit, currentValue: null, comparisonValue: null, changeBps: null, coverage }
  }
  const stores = coverage.comparableStores
  let currentValue
  let priorValue
  if (field === 'aovCents') {
    const currentOrders = sumDaily(current.daily, stores, 'orderCount')
    const priorOrders = sumDaily(comparison.daily, stores, 'orderCount')
    currentValue = currentOrders > 0n ? sumDaily(current.daily, stores, 'revenueCents') / currentOrders : null
    priorValue = priorOrders > 0n ? sumDaily(comparison.daily, stores, 'revenueCents') / priorOrders : null
  } else {
    currentValue = sumDaily(current.daily, stores, field)
    priorValue = sumDaily(comparison.daily, stores, field)
  }
  const changeBps = currentValue !== null && priorValue !== null && priorValue !== 0n
    ? ((currentValue - priorValue) * 10_000n / priorValue).toString()
    : null
  return {
    unit,
    currentValue: currentValue === null ? null : currentValue.toString(),
    comparisonValue: priorValue === null ? null : priorValue.toString(),
    changeBps,
    coverage: {
      ...coverage,
      reasonCodes: changeBps === null && priorValue === 0n
        ? [...coverage.reasonCodes, 'ZERO_COMPARISON_BASE']
        : coverage.reasonCodes,
    },
  }
}

function buildComparisons(current, comparison, mode) {
  const dailyCoverage = comparisonCoverage(current, comparison, 'STORE_DAILY_SUMMARY', mode)
  const orderCoverage = comparisonCoverage(current, comparison, 'ORDER_LEVEL', mode)
  return {
    revenue: comparisonMetric(current, comparison, 'revenueCents', 'CENTS', dailyCoverage),
    orderCount: comparisonMetric(current, comparison, 'orderCount', 'COUNT', dailyCoverage),
    aov: comparisonMetric(current, comparison, 'aovCents', 'CENTS', dailyCoverage),
    grossSales: comparisonMetric(current, comparison, 'grossCents', 'CENTS', orderCoverage),
    refund: comparisonMetric(current, comparison, 'refundCents', 'CENTS', orderCoverage),
  }
}

function mondayOf(value) {
  const weekday = dateOnly(value).getUTCDay() || 7
  return addDays(value, 1 - weekday)
}

function trendGranularity(dayCount) {
  if (dayCount <= 31) return 'DAY'
  if (dayCount <= 62) return 'WEEK'
  return 'MONTH'
}

export function buildReportTrend(summary) {
  const granularity = trendGranularity(summary.range.from === summary.range.to ? 1 : normalizeReportRange(summary.range).days.length)
  const groups = new Map()
  for (const row of summary.daily) {
    const key = granularity === 'DAY' ? row.date : granularity === 'WEEK' ? mondayOf(row.date) : row.date.slice(0, 7)
    const group = groups.get(key) || { key, from: row.date, to: row.date, rows: [] }
    if (row.date < group.from) group.from = row.date
    if (row.date > group.to) group.to = row.date
    group.rows.push(row)
    groups.set(key, group)
  }
  return {
    granularity,
    points: [...groups.values()].sort((a, b) => a.from.localeCompare(b.from)).map((group) => {
      const covered = group.rows.filter((row) => row.revenueCents !== null)
      const reasonCodes = [...new Set(group.rows.map((row) => row.reasonCode).filter(Boolean))].sort()
      const state = covered.length === 0
        ? REPORT_COVERAGE_STATES.UNAVAILABLE
        : covered.length === group.rows.length
          ? REPORT_COVERAGE_STATES.COMPLETE
          : REPORT_COVERAGE_STATES.PARTIAL
      const revenue = covered.reduce((sum, row) => sum + BigInt(row.revenueCents), 0n)
      const orders = covered.reduce((sum, row) => sum + BigInt(row.orderCount), 0n)
      return {
        key: group.key,
        from: group.from,
        to: group.to,
        revenueCents: state === REPORT_COVERAGE_STATES.UNAVAILABLE ? null : revenue.toString(),
        orderCount: state === REPORT_COVERAGE_STATES.UNAVAILABLE ? null : orders.toString(),
        aovCents: state === REPORT_COVERAGE_STATES.UNAVAILABLE || orders === 0n ? null : (revenue / orders).toString(),
        coverage: {
          state,
          coveredStoreDays: covered.length,
          uncoveredStoreDays: group.rows.length - covered.length,
          reasonCodes,
        },
      }
    }),
  }
}

function dashboardFreshness(summary) {
  const storesFor = (codes) => [...new Set(summary.daily.filter((row) => codes.includes(row.reasonCode)).map((row) => row.storeKey))]
  const pendingCloseStores = storesFor(['TODAY_PENDING_CLOSE'])
  const historicalIncompleteStores = storesFor(['HISTORICAL_DATA_INCOMPLETE', 'HISTORICAL_DRAFT_ENTRY'])
  return {
    businessDate: summary.businessDate,
    state: historicalIncompleteStores.length > 0
      ? 'HISTORICAL_INCOMPLETE'
      : pendingCloseStores.length > 0
        ? 'TODAY_PARTIAL'
        : 'COMPLETE',
    pendingCloseStores,
    historicalIncompleteStores,
  }
}

export class ReportQueryService {
  constructor(prismaClient, { now = () => new Date() } = {}) {
    this.prisma = prismaClient
    this.now = now
  }

  async resolveScope(user, query = {}) {
    if (!hasReportSalesView(user)) throw httpError('无销售报表查看权限', 403)
    const range = normalizeReportRange(query)
    const requested = parseStoreFilter(query.store)
    const allStores = await this.prisma.store.findMany({ orderBy: { key: 'asc' } })
    const allowed = hasReportAllStores(user) ? null : new Set(Array.isArray(user?.storeKeys) ? user.storeKeys : [])
    if (requested.some((key) => allowed && !allowed.has(key))) throw httpError('无权查看所选门店报表', 403)
    const selected = allStores.filter((store) => (!requested.length || requested.includes(store.key)) && (!allowed || allowed.has(store.key)))
    if (requested.some((key) => !selected.some((store) => store.key === key))) throw httpError('门店不存在或无权查看', 403)
    if (!selected.length) throw httpError('没有可查看的报表门店', 403)

    const storeKeys = selected.map((store) => store.key)
    const [entries, audits] = await Promise.all([
      this.prisma.dailyEntry.findMany({ where: { storeKey: { in: storeKeys }, date: { gte: range.start, lt: range.endExclusive } } }),
      this.prisma.dailyEntryAuditLog.findMany({
        where: {
          storeId: { in: storeKeys }, date: { gte: range.start, lt: range.endExclusive },
          module: 'daily_confirmation', fieldName: 'atomic_confirm',
        },
        orderBy: { createdAt: 'asc' },
      }),
    ])
    const entryMap = new Map(entries.map((entry) => [storeDayKey(entry.storeKey, isoDate(entry.date)), entry]))
    const auditMap = new Map()
    for (const audit of audits) {
      const key = storeDayKey(audit.storeId, isoDate(audit.date))
      const rows = auditMap.get(key) || []
      rows.push(audit)
      auditMap.set(key, rows)
    }
    const days = []
    for (const store of selected) {
      for (const date of range.days) {
        const key = storeDayKey(store.key, date)
        const entry = entryMap.get(key) || null
        const resolved = resolveDailySalesAuthority({ store, date, entry, audits: auditMap.get(key) || [] })
        days.push({ storeKey: store.key, storeName: store.name, date, entry, ...resolved })
      }
    }
    return { range, stores: selected, days, businessDate: buduBusinessDate(this.now()) }
  }

  coverage(scope) {
    return {
      dailySummary: summarizeCoverage('STORE_DAILY_SUMMARY', scope.days, (day) => summarySupport(day, scope.businessDate)),
      orders: summarizeCoverage('ORDER_LEVEL', scope.days, orderSupport),
      productSales: summarizeCoverage('ITEM_LEVEL', scope.days, orderSupport),
    }
  }

  async queryPosSummary(posDays, { includeCompositions = true } = {}) {
    if (!posDays.length) return { totals: [], channels: [], settlements: [] }
    const selected = selectedDaysCte(posDays)
    const settled = settledOrdersCte()
    const metrics = orderMetricsCtes()
    const totals = await this.prisma.$queryRaw(Prisma.sql`
      WITH ${selected}, ${settled}, ${metrics}
      SELECT "store_id" AS "storeKey", "business_date" AS date,
        COALESCE(SUM(gross_cents), 0)::bigint AS "grossCents",
        COALESCE(SUM(discount_cents), 0)::bigint AS "discountCents",
        COALESCE(SUM(refund_cents), 0)::bigint AS "refundCents",
        COALESCE(SUM(revenue_cents), 0)::bigint AS "revenueCents",
        COALESCE(SUM(effective_order), 0)::bigint AS "effectiveOrders"
      FROM order_metrics GROUP BY "store_id", "business_date" ORDER BY "store_id", "business_date"
    `)
    if (!includeCompositions) return { totals, channels: [], settlements: [] }
    const channels = await this.prisma.$queryRaw(Prisma.sql`
      WITH ${selected}, ${settled}, ${metrics}
      SELECT "order_source"::text AS key,
        COALESCE(SUM(revenue_cents), 0)::bigint AS "revenueCents",
        COUNT(*)::bigint AS "settledOrders"
      FROM order_metrics GROUP BY "order_source" ORDER BY "order_source"
    `)
    const settlements = await this.prisma.$queryRaw(Prisma.sql`
      WITH ${selected}, ${settled}, ${metrics},
      settlement_metrics AS (
        SELECT om.*,
          CASE
            WHEN om."settlement_authority"::text = 'EXTERNAL' THEN es."settlement_type"::text
            WHEN lower(p."channel") = 'wechat' THEN 'WECHAT'
            WHEN lower(p."channel") = 'alipay' THEN 'ALIPAY'
            WHEN lower(p."channel") = 'cash' THEN 'CASH'
            ELSE NULL
          END AS settlement_key
        FROM order_metrics om
        LEFT JOIN LATERAL (
          SELECT "channel" FROM "payments"
          WHERE "order_id" = om."id" AND "status" IN ('success', 'partially_refunded', 'refunded')
          ORDER BY "paid_at" DESC NULLS LAST, "created_at" DESC LIMIT 1
        ) p ON om."settlement_authority"::text = 'PAYMENT'
        LEFT JOIN "external_settlements" es ON es."order_id" = om."id" AND om."settlement_authority"::text = 'EXTERNAL'
      )
      SELECT settlement_key AS key,
        COALESCE(SUM(revenue_cents), 0)::bigint AS "revenueCents",
        COUNT(*)::bigint AS "settledOrders"
      FROM settlement_metrics WHERE settlement_key IS NOT NULL
      GROUP BY settlement_key ORDER BY settlement_key
    `)
    return { totals, channels, settlements }
  }

  async summary(user, query = {}, resolvedScope = null, options = {}) {
    const scope = resolvedScope || await this.resolveScope(user, query)
    const coverage = this.coverage(scope)
    const posDays = scope.days.filter((day) => orderSupport(day).ok)
    const pos = await this.queryPosSummary(posDays, options)
    const posMap = new Map(pos.totals.map((row) => [storeDayKey(row.storeKey, isoDate(row.date)), row]))
    let revenue = 0n
    let orderCount = 0n
    let gross = 0n
    let discount = 0n
    let refund = 0n
    const storeTotals = new Map(scope.stores.map((store) => [store.key, {
      storeKey: store.key,
      storeName: store.name,
      revenueCents: 0n,
      orderCount: 0n,
      coveredDays: 0,
      uncoveredDays: 0,
    }]))
    const daily = []
    for (const day of scope.days) {
      const support = summarySupport(day, scope.businessDate)
      let row = null
      if (support.ok && day.authority === DAILY_SALES_AUTHORITIES.MANUAL) {
        row = { revenueCents: BigInt(day.entry.incCents), orderCount: BigInt(day.entry.ord), grossCents: null, discountCents: null, refundCents: null }
      } else if (support.ok && day.authority === DAILY_SALES_AUTHORITIES.POS) {
        const value = posMap.get(storeDayKey(day.storeKey, day.date))
        row = {
          revenueCents: BigInt(value?.revenueCents || 0), orderCount: BigInt(value?.effectiveOrders || 0),
          grossCents: BigInt(value?.grossCents || 0), discountCents: BigInt(value?.discountCents || 0), refundCents: BigInt(value?.refundCents || 0),
        }
      }
      if (row) {
        revenue += row.revenueCents
        orderCount += row.orderCount
        if (row.grossCents !== null) gross += row.grossCents
        if (row.discountCents !== null) discount += row.discountCents
        if (row.refundCents !== null) refund += row.refundCents
        const storeTotal = storeTotals.get(day.storeKey)
        storeTotal.revenueCents += row.revenueCents
        storeTotal.orderCount += row.orderCount
        storeTotal.coveredDays += 1
      } else {
        storeTotals.get(day.storeKey).uncoveredDays += 1
      }
      daily.push({
        storeKey: day.storeKey, storeName: day.storeName, date: day.date,
        authority: day.authority, evidence: day.evidence, reasonCode: support.ok ? null : support.reasonCode,
        revenueCents: row ? row.revenueCents.toString() : null,
        orderCount: row ? row.orderCount.toString() : null,
        grossCents: row?.grossCents === null || !row ? null : row.grossCents.toString(),
        discountCents: row?.discountCents === null || !row ? null : row.discountCents.toString(),
        refundCents: row?.refundCents === null || !row ? null : row.refundCents.toString(),
      })
    }
    const aov = orderCount > 0n ? revenue / orderCount : null
    const storeComparison = [...storeTotals.values()]
      .map((row) => ({
        storeKey: row.storeKey,
        storeName: row.storeName,
        revenueCents: row.coveredDays > 0 ? row.revenueCents.toString() : null,
        orderCount: row.coveredDays > 0 ? Number(row.orderCount) : null,
        aovCents: row.coveredDays > 0 && row.orderCount > 0n ? (row.revenueCents / row.orderCount).toString() : null,
        coverageState: row.coveredDays === 0
          ? REPORT_COVERAGE_STATES.UNAVAILABLE
          : row.uncoveredDays === 0
            ? REPORT_COVERAGE_STATES.COMPLETE
            : REPORT_COVERAGE_STATES.PARTIAL,
        coveredDays: row.coveredDays,
        uncoveredDays: row.uncoveredDays,
      }))
      .sort((a, b) => {
        if (a.revenueCents === null) return 1
        if (b.revenueCents === null) return -1
        const left = BigInt(a.revenueCents)
        const right = BigInt(b.revenueCents)
        return left === right ? a.storeName.localeCompare(b.storeName, 'zh-CN') : left > right ? -1 : 1
      })
    return {
      range: { from: scope.range.from, to: scope.range.to },
      businessDate: scope.businessDate,
      stores: scope.stores.map(({ key, name }) => ({ storeKey: key, storeName: name })),
      metrics: {
        revenue: amountMetric(revenue, coverage.dailySummary),
        orderCount: countMetric(orderCount, coverage.dailySummary),
        aov: amountMetric(aov, coverage.dailySummary),
        grossSales: amountMetric(gross, coverage.orders),
        discount: amountMetric(discount, coverage.orders),
        refund: amountMetric(refund, coverage.orders),
      },
      channelComposition: {
        coverage: coverage.orders,
        rows: pos.channels.map((row) => ({ key: row.key, revenueCents: BigInt(row.revenueCents).toString(), settledOrders: Number(row.settledOrders) })),
      },
      settlementComposition: {
        coverage: coverage.orders,
        rows: pos.settlements.map((row) => ({ key: row.key, revenueCents: BigInt(row.revenueCents).toString(), settledOrders: Number(row.settledOrders) })),
      },
      storeComparison,
      coverage,
      daily,
    }
  }

  async dashboard(user, query = {}) {
    const comparisonMode = String(query.compare || 'previous').trim()
    const period = String(query.period || '').trim()
    if (!['', 'today', 'yesterday', 'week', 'month', 'custom'].includes(period)) throw httpError('报表周期类型不正确')
    const currentScope = await this.resolveScope(user, query)
    const comparisonRange = resolveComparisonRange(currentScope.range, comparisonMode, period)
    const comparisonScope = await this.resolveScope(user, {
      from: comparisonRange.from,
      to: comparisonRange.to,
      store: currentScope.stores.map((row) => row.key).join(','),
    })
    const topSort = String(query.topSort || 'productRevenue').trim()
    if (!['productRevenue', 'salesQuantity'].includes(topSort)) throw httpError('商品排行方式不正确')
    const [current, comparison, products] = await Promise.all([
      this.summary(user, query, currentScope),
      this.summary(user, comparisonRange, comparisonScope, { includeCompositions: false }),
      this.products(user, { ...query, page: 1, pageSize: 5, sort: topSort, search: '' }, currentScope),
    ])
    return {
      range: current.range,
      businessDate: current.businessDate,
      comparison: { mode: comparisonMode, range: comparison.range },
      freshness: dashboardFreshness(current),
      metrics: current.metrics,
      comparisons: buildComparisons(current, comparison, comparisonMode),
      trend: buildReportTrend(current),
      storeComparison: current.storeComparison,
      channelComposition: current.channelComposition,
      settlementComposition: current.settlementComposition,
      topProducts: {
        sort: topSort,
        coverage: products.coverage,
        rows: products.rows,
      },
      profit: { available: false, reasonCode: 'PROFIT_MODEL_NOT_CONFIGURED' },
      coverage: current.coverage,
    }
  }

  async orders(user, query = {}) {
    const scope = await this.resolveScope(user, query)
    const coverage = this.coverage(scope).orders
    const posDays = scope.days.filter((day) => orderSupport(day).ok)
    const paging = parsePage(query)
    const filters = parseOrderFilters(query)
    if (!posDays.length) return { range: { from: scope.range.from, to: scope.range.to }, coverage, page: paging.page, pageSize: paging.pageSize, total: 0, rows: [] }
    const selected = selectedDaysCte(posDays)
    const rows = await this.prisma.$queryRaw(Prisma.sql`
      WITH ${selected}, ${settledOrdersCte()}, ${orderMetricsCtes()},
      report_orders AS (
        SELECT om.*,
          CASE
            WHEN om."settlement_authority"::text = 'EXTERNAL' THEN es."settlement_type"::text
            WHEN lower(p."channel") = 'wechat' THEN 'WECHAT'
            WHEN lower(p."channel") = 'alipay' THEN 'ALIPAY'
            WHEN lower(p."channel") = 'cash' THEN 'CASH'
            ELSE NULL
          END AS settlement_key,
          CASE WHEN om."settlement_authority"::text = 'EXTERNAL' THEN es."amount_cents" ELSE p."amount" END AS settlement_amount_cents,
          lr.last_refund_at
        FROM order_metrics om
        LEFT JOIN LATERAL (
          SELECT "channel", "amount" FROM "payments"
          WHERE "order_id" = om."id" AND "status" IN ('success', 'partially_refunded', 'refunded')
          ORDER BY "paid_at" DESC NULLS LAST, "created_at" DESC LIMIT 1
        ) p ON om."settlement_authority"::text = 'PAYMENT'
        LEFT JOIN "external_settlements" es ON es."order_id" = om."id" AND om."settlement_authority"::text = 'EXTERNAL'
        LEFT JOIN LATERAL (
          SELECT MAX(COALESCE("external_completed_at", "completed_at")) AS last_refund_at
          FROM "refunds" WHERE "order_id" = om."id" AND "status" = 'completed'
        ) lr ON TRUE
      )
      SELECT om."id", om."order_no" AS "orderNo", om."store_id" AS "storeKey", om."business_date" AS date,
        om."order_source"::text AS "orderSource", om."settlement_authority"::text AS "settlementAuthority",
        om."status", om."payment_status" AS "paymentStatus", om."created_at" AS "createdAt",
        om."completed_at" AS "completedAt", om.last_refund_at AS "lastRefundAt",
        om."payable_amount" AS "payableCents", om.settlement_amount_cents AS "settlementCents",
        om.settlement_key AS "settlementType", om.gross_cents AS "grossCents", om.discount_cents AS "discountCents",
        om.refund_cents AS "refundCents", om.revenue_cents AS "revenueCents",
        COUNT(*) OVER()::bigint AS "totalCount"
      FROM report_orders om
      WHERE (${filters.orderSource}::text IS NULL OR om."order_source"::text = ${filters.orderSource})
        AND (${filters.settlementType}::text IS NULL OR om.settlement_key = ${filters.settlementType})
      ORDER BY om."business_date" DESC, om."completed_at" DESC NULLS LAST, om."id"
      LIMIT ${paging.pageSize} OFFSET ${paging.offset}
    `)
    return {
      range: { from: scope.range.from, to: scope.range.to }, coverage,
      page: paging.page, pageSize: paging.pageSize, total: rows.length ? Number(rows[0].totalCount) : 0,
      rows: rows.map((row) => ({
        id: row.id, orderNo: row.orderNo, storeKey: row.storeKey, date: isoDate(row.date),
        orderSource: row.orderSource, settlementAuthority: row.settlementAuthority, status: row.status,
        paymentStatus: row.paymentStatus, settlementType: row.settlementType,
        createdAt: row.createdAt, completedAt: row.completedAt, lastRefundAt: row.lastRefundAt,
        payableCents: BigInt(row.payableCents).toString(), settlementCents: BigInt(row.settlementCents).toString(),
        grossCents: BigInt(row.grossCents).toString(), discountCents: BigInt(row.discountCents).toString(),
        refundCents: BigInt(row.refundCents).toString(), revenueCents: BigInt(row.revenueCents).toString(),
      })),
    }
  }

  async orderDetail(user, orderId) {
    const id = String(orderId || '').trim()
    if (!id || id.length > 120) throw httpError('订单 ID 不正确')
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        store: { select: { key: true, name: true } },
        items: { orderBy: { id: 'asc' } },
        payments: {
          where: { status: { in: ['success', 'partially_refunded', 'refunded'] } },
          orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
          select: { id: true, paymentNo: true, channel: true, status: true, amount: true, paidAt: true, createdAt: true },
        },
        externalSettlement: {
          select: { id: true, settlementType: true, status: true, amountCents: true, confirmedAt: true },
        },
        refunds: {
          where: { status: 'completed' },
          orderBy: { completedAt: 'asc' },
          include: { items: { orderBy: { id: 'asc' } } },
        },
      },
    })
    if (!order || !order.businessDate || !SETTLED_ORDER_STATUSES.includes(order.status)) throw httpError('报表订单不存在', 404)
    const date = isoDate(order.businessDate)
    const scope = await this.resolveScope(user, { from: date, to: date, store: order.storeId })
    const day = scope.days[0]
    if (!day || !orderSupport(day).ok) throw httpError('该门店日期没有订单级报表权威', 409)
    const hasProof = order.settlementAuthority === 'PAYMENT'
      ? order.payments.length > 0
      : Boolean(order.externalSettlement && ['CONFIRMED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(order.externalSettlement.status))
    if (!hasProof) throw httpError('订单缺少有效结算事实', 409)
    const completedRefund = order.refunds.reduce((sum, row) => sum + BigInt(row.refundAmount), 0n)
    const gross = order.items.reduce((sum, item) => sum + (item.isGift ? 0n : BigInt(item.unitPrice) * BigInt(item.quantity)), 0n)
    const discount = order.items.reduce((sum, item) => sum + (item.isGift ? 0n : BigInt(item.discountAmount)), 0n)
    const itemNames = new Map(order.items.map((item) => [item.id, item.productNameSnapshot]))
    const lastRefundAt = order.refunds.reduce((latest, refund) => {
      const value = refund.externalCompletedAt || refund.completedAt
      return value && (!latest || value > latest) ? value : latest
    }, null)
    return {
      id: order.id,
      orderNo: order.orderNo,
      storeKey: order.storeId,
      storeName: order.store.name,
      date,
      createdAt: order.createdAt,
      completedAt: order.completedAt,
      lastRefundAt,
      cashierNameSnapshot: order.cashierNameSnapshot,
      orderSource: order.orderSource,
      entryMode: order.entryMode,
      settlementAuthority: order.settlementAuthority,
      settlementType: order.settlementAuthority === 'EXTERNAL'
        ? order.externalSettlement?.settlementType || null
        : String(order.payments[0]?.channel || '').toUpperCase() || null,
      status: order.status,
      paymentStatus: order.paymentStatus,
      payableCents: BigInt(order.payableAmount).toString(),
      settlementCents: BigInt(order.settlementAuthority === 'EXTERNAL'
        ? order.externalSettlement.amountCents
        : order.payments[0].amount).toString(),
      grossCents: gross.toString(),
      discountCents: discount.toString(),
      refundCents: completedRefund.toString(),
      revenueCents: (gross - discount - completedRefund).toString(),
      items: order.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        productNameSnapshot: item.productNameSnapshot,
        skuSnapshot: item.skuSnapshot,
        unitSnapshot: item.unitSnapshot,
        unitPriceCents: BigInt(item.unitPrice).toString(),
        quantity: item.quantity,
        discountCents: BigInt(item.discountAmount).toString(),
        actualCents: BigInt(item.actualAmount).toString(),
        isGift: item.isGift,
      })),
      refunds: order.refunds.map((refund) => ({
        id: refund.id,
        refundNo: refund.refundNo,
        refundMode: refund.refundMode,
        refundCents: BigInt(refund.refundAmount).toString(),
        completedAt: refund.completedAt,
        externalCompletedAt: refund.externalCompletedAt,
        items: refund.items.map((item) => ({
          orderItemId: item.orderItemId,
          productName: itemNames.get(item.orderItemId) || '商品',
          quantity: item.quantity,
          amountCents: BigInt(item.amountCents).toString(),
        })),
      })),
    }
  }

  async products(user, query = {}, resolvedScope = null) {
    const scope = resolvedScope || await this.resolveScope(user, query)
    const coverage = this.coverage(scope).productSales
    const posDays = scope.days.filter((day) => orderSupport(day).ok)
    const paging = parsePage(query)
    const filters = parseProductFilters(query)
    if (!posDays.length) return { range: { from: scope.range.from, to: scope.range.to }, coverage, page: paging.page, pageSize: paging.pageSize, total: 0, rows: [] }
    const selected = selectedDaysCte(posDays)
    const orderBy = filters.sort === 'salesQuantity'
      ? Prisma.sql`sales_quantity DESC, product_revenue_cents DESC, "product_id"`
      : filters.sort === 'salesCents'
        ? Prisma.sql`sales_cents DESC, product_revenue_cents DESC, "product_id"`
        : Prisma.sql`product_revenue_cents DESC, sales_cents DESC, "product_id"`
    const searchPattern = `%${filters.search}%`
    const rows = await this.prisma.$queryRaw(Prisma.sql`
      WITH ${selected}, ${settledOrdersCte()},
      effective_total AS (
        SELECT COUNT(*)::bigint AS total FROM settled_orders WHERE "status"::text IN (${Prisma.join(EFFECTIVE_ORDER_STATUSES)})
      ),
      sales AS (
        SELECT oi."product_id", MAX(oi."product_name_snapshot") AS product_name,
          MAX(oi."sku_snapshot") AS sku,
          COALESCE(SUM(oi."quantity"), 0)::bigint AS sales_quantity,
          COALESCE(SUM(CASE WHEN oi."is_gift" THEN oi."quantity" ELSE 0 END), 0)::bigint AS gift_quantity,
          COALESCE(SUM(CASE WHEN NOT oi."is_gift" THEN oi."unit_price" * oi."quantity"::bigint ELSE 0 END), 0)::bigint AS sales_cents,
          COALESCE(SUM(CASE WHEN oi."is_gift" THEN oi."unit_price" * oi."quantity"::bigint ELSE 0 END), 0)::bigint AS gift_cents,
          COALESCE(SUM(CASE WHEN NOT oi."is_gift" THEN oi."discount_amount" ELSE 0 END), 0)::bigint AS discount_cents,
          COUNT(DISTINCT CASE WHEN o."status"::text IN (${Prisma.join(EFFECTIVE_ORDER_STATUSES)}) THEN o."id" END)::bigint AS effective_product_orders
        FROM "order_items" oi JOIN settled_orders o ON o."id" = oi."order_id"
        GROUP BY oi."product_id"
      ),
      refunded AS (
        SELECT oi."product_id", COALESCE(SUM(ri."quantity"), 0)::bigint AS refund_quantity,
          COALESCE(SUM(ri."amount_cents"), 0)::bigint AS refund_cents
        FROM "refund_items" ri
        JOIN "refunds" r ON r."id" = ri."refund_id" AND r."status" = 'completed'
        JOIN settled_orders o ON o."id" = r."order_id"
        JOIN "order_items" oi ON oi."id" = ri."order_item_id"
        GROUP BY oi."product_id"
      ),
      product_metrics AS (
        SELECT s.*, COALESCE(r.refund_quantity, 0)::bigint AS refund_quantity,
          COALESCE(r.refund_cents, 0)::bigint AS refund_cents,
          (s.sales_cents - s.discount_cents - COALESCE(r.refund_cents, 0))::bigint AS product_revenue_cents,
          (SELECT total FROM effective_total) AS effective_orders
        FROM sales s LEFT JOIN refunded r ON r."product_id" = s."product_id"
      ),
      filtered_metrics AS (
        SELECT * FROM product_metrics
        WHERE (${filters.search} = '' OR product_name ILIKE ${searchPattern} OR sku ILIKE ${searchPattern})
      ),
      product_totals AS (
        SELECT COALESCE(SUM(sales_quantity), 0)::bigint AS total_sales_quantity,
          COALESCE(SUM(sales_cents), 0)::bigint AS total_sales_cents,
          COALESCE(SUM(discount_cents), 0)::bigint AS total_discount_cents,
          COALESCE(SUM(product_revenue_cents), 0)::bigint AS total_product_revenue_cents,
          COALESCE(SUM(refund_quantity), 0)::bigint AS total_refund_quantity,
          COALESCE(SUM(refund_cents), 0)::bigint AS total_refund_cents,
          COALESCE(SUM(gift_quantity), 0)::bigint AS total_gift_quantity,
          COALESCE(SUM(gift_cents), 0)::bigint AS total_gift_cents
        FROM filtered_metrics
      )
      SELECT fm.*, pt.*, COUNT(*) OVER()::bigint AS total_count
      FROM filtered_metrics fm CROSS JOIN product_totals pt ORDER BY ${orderBy}
      LIMIT ${paging.pageSize} OFFSET ${paging.offset}
    `)
    return {
      range: { from: scope.range.from, to: scope.range.to }, coverage,
      page: paging.page, pageSize: paging.pageSize, total: rows.length ? Number(rows[0].total_count) : 0,
      rows: rows.map((row) => {
        const numerator = BigInt(row.effective_product_orders)
        const denominator = BigInt(row.effective_orders)
        return {
          productId: row.product_id, productName: row.product_name, sku: row.sku,
          salesQuantity: BigInt(row.sales_quantity).toString(), giftQuantity: BigInt(row.gift_quantity).toString(),
          salesCents: BigInt(row.sales_cents).toString(), giftCents: BigInt(row.gift_cents).toString(),
          discountCents: BigInt(row.discount_cents).toString(), refundQuantity: BigInt(row.refund_quantity).toString(),
          refundCents: BigInt(row.refund_cents).toString(), productRevenueCents: BigInt(row.product_revenue_cents).toString(),
          salesQuantityShareBps: basisPoints(row.sales_quantity, row.total_sales_quantity),
          salesShareBps: basisPoints(row.sales_cents, row.total_sales_cents),
          discountShareBps: basisPoints(row.discount_cents, row.total_discount_cents),
          productRevenueShareBps: basisPoints(row.product_revenue_cents, row.total_product_revenue_cents),
          refundQuantityShareBps: basisPoints(row.refund_quantity, row.total_refund_quantity),
          refundShareBps: basisPoints(row.refund_cents, row.total_refund_cents),
          giftQuantityShareBps: basisPoints(row.gift_quantity, row.total_gift_quantity),
          giftShareBps: basisPoints(row.gift_cents, row.total_gift_cents),
          orderRateNumerator: numerator.toString(), orderRateDenominator: denominator.toString(),
          orderRateBps: basisPoints(numerator, denominator),
        }
      }),
      totals: rows.length ? {
        salesQuantity: BigInt(rows[0].total_sales_quantity).toString(),
        salesCents: BigInt(rows[0].total_sales_cents).toString(),
        discountCents: BigInt(rows[0].total_discount_cents).toString(),
        productRevenueCents: BigInt(rows[0].total_product_revenue_cents).toString(),
        refundQuantity: BigInt(rows[0].total_refund_quantity).toString(),
        refundCents: BigInt(rows[0].total_refund_cents).toString(),
        giftQuantity: BigInt(rows[0].total_gift_quantity).toString(),
        giftCents: BigInt(rows[0].total_gift_cents).toString(),
      } : null,
    }
  }
}
