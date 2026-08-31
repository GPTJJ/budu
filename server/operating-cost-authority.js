import crypto from 'node:crypto'
import { Prisma } from '@prisma/client'
import * as XLSX from 'xlsx'
import { hasReportAllStores, hasReportCostManage, hasReportCostView, hasReportLaborView } from '../shared/accountPermissions.js'
import { buduBusinessDate } from '../shared/businessDate.js'
import { loadAuthoritativePayrollRange } from './payroll-authority.js'
import { httpError } from './pos-core.js'
import { resolveComparisonRange } from './report-center-query.js'

export const OPERATING_PROFIT_STATES = Object.freeze({ EXACT: 'EXACT', ESTIMATED: 'ESTIMATED', INCOMPLETE: 'INCOMPLETE' })
export const OPERATING_PROFIT_COMPARISON_STATES = Object.freeze({ COMPARABLE: 'COMPARABLE', INCOMPARABLE: 'INCOMPARABLE' })

const dateText = (value) => new Date(value).toISOString().slice(0, 10)
const dbDate = (value) => new Date(`${value}T00:00:00.000Z`)
const monthStart = (value) => `${value.slice(0, 7)}-01`
const daysInMonth = (value) => new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)), 0)).getUTCDate()
const monthEnd = (value) => `${value.slice(0, 7)}-${String(daysInMonth(value)).padStart(2, '0')}`
const minDate = (a, b) => a < b ? a : b
const maxDate = (a, b) => a > b ? a : b
const dayCount = (from, to) => Math.round((dbDate(to) - dbDate(from)) / 86_400_000) + 1
const prorate = (cents, selectedDays, totalDays) => (BigInt(cents) * BigInt(selectedDays)) / BigInt(totalDays)
const sumBigInt = (rows, selector) => rows.reduce((sum, row) => sum + BigInt(selector(row) || 0), 0n)
const bps = (numerator, denominator) => denominator === 0n ? null : ((numerator * 10_000n) / denominator).toString()
const cents = (value, label = '金额') => {
  const text = String(value ?? '').trim()
  if (!/^\d+$/.test(text)) throw httpError(`${label}必须为非负整数分`)
  return BigInt(text)
}

function assertMonth(value) {
  const text = String(value || '').trim()
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) throw httpError('月份格式应为 YYYY-MM')
  return text
}

function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]))
  return value
}

function assertCostRead(user) {
  if (!hasReportCostView(user)) throw httpError('无经营成本查看权限', 403)
}

function assertLaborRead(user) {
  if (!hasReportLaborView(user)) throw httpError('无人工成本查看权限', 403)
}

function assertManage(user) {
  if (!hasReportCostManage(user)) throw httpError('无经营成本配置权限', 403)
}

function assertStore(user, storeKey) {
  if (!storeKey || (!hasReportAllStores(user) && !(user?.storeKeys || []).includes(storeKey))) throw httpError('无权访问所选门店成本', 403)
}

export function deterministicAllocateCents(totalCents, weights) {
  const total = BigInt(totalCents)
  const normalized = weights.map((row) => ({ ...row, weight: BigInt(row.weight) })).filter((row) => row.weight > 0n)
  const denominator = normalized.reduce((sum, row) => sum + row.weight, 0n)
  if (denominator === 0n) return []
  let assigned = 0n
  return normalized.map((row, index) => {
    const amountCents = index === normalized.length - 1 ? total - assigned : (total * row.weight) / denominator
    assigned += amountCents
    return { ...row, amountCents }
  })
}

export function calculateRentCents(config, { grossCents, netRevenueCents, selectedDays, totalDays }) {
  const fixed = config.fixedAmountCents == null ? 0n : prorate(config.fixedAmountCents, selectedDays, totalDays)
  const basis = config.percentageBasis === 'GROSS_SALES' ? grossCents : netRevenueCents
  const needsPercent = config.mode !== 'FIXED'
  if (needsPercent && basis == null) return { amountCents: null, reasonCode: 'INCOMPLETE_RENT_BASIS' }
  const percentage = needsPercent ? (BigInt(basis) * BigInt(config.percentageBps)) / 10_000n : 0n
  const amountCents = config.mode === 'FIXED' ? fixed
    : config.mode === 'PERCENT' ? percentage
      : config.mode === 'FIXED_PLUS_PERCENT' ? fixed + percentage
        : fixed > percentage ? fixed : percentage
  return { amountCents, reasonCode: null }
}

function monthSegments(from, to) {
  const rows = []
  let cursor = monthStart(from)
  while (cursor <= to) {
    const start = maxDate(from, cursor)
    const end = minDate(to, monthEnd(cursor))
    rows.push({ month: cursor.slice(0, 7), period: cursor, from: start, to: end, selectedDays: dayCount(start, end), totalDays: daysInMonth(cursor) })
    const next = new Date(`${cursor}T00:00:00.000Z`)
    next.setUTCMonth(next.getUTCMonth() + 1)
    cursor = dateText(next)
  }
  return rows
}

function sumDaily(summary, storeKey, from, to, field) {
  const rows = summary.daily.filter((row) => row.storeKey === storeKey && row.date >= from && row.date <= to)
  if (!rows.length || rows.some((row) => row[field] == null)) return null
  return rows.reduce((sum, row) => sum + BigInt(row[field]), 0n)
}

async function queryCogs(prisma, posDays) {
  if (!posDays.length) return new Map()
  const values = posDays.map((row) => Prisma.sql`(${row.storeKey}, ${row.date}::date)`)
  const rows = await prisma.$queryRaw(Prisma.sql`
    WITH selected_days(store_id, business_date) AS (VALUES ${Prisma.join(values)}),
    settled_orders AS (
      SELECT o."id", o."store_id", o."business_date"
      FROM "orders" o JOIN selected_days d ON d.store_id=o."store_id" AND d.business_date=o."business_date"
      WHERE o."status" IN ('completed','partially_refunded','refunded') AND (
        (o."settlement_authority"::text='PAYMENT' AND EXISTS (SELECT 1 FROM "payments" p WHERE p."order_id"=o."id" AND p."status" IN ('success','partially_refunded','refunded')))
        OR (o."settlement_authority"::text='EXTERNAL' AND EXISTS (SELECT 1 FROM "external_settlements" e WHERE e."order_id"=o."id" AND e."status"::text IN ('CONFIRMED','PARTIALLY_REFUNDED','REFUNDED')))
      )
    )
    SELECT o."store_id" AS "storeKey", o."business_date" AS date,
      COALESCE(SUM(oi."cost_price_snapshot" * oi."quantity"::bigint),0)::bigint AS "cogsCents"
    FROM settled_orders o JOIN "order_items" oi ON oi."order_id"=o."id"
    GROUP BY o."store_id", o."business_date"
  `)
  return new Map(rows.map((row) => [`${row.storeKey}|${dateText(row.date)}`, BigInt(row.cogsCents)]))
}

function payrollMonth(authority, selectedStores) {
  if (!authority.result?.calculationReady || authority.result?.mode !== 'EMPLOYEE_ID') return { incomplete: true, totals: new Map() }
  const totals = new Map(selectedStores.map((key) => [key, 0n]))
  for (const employee of authority.result.payroll?.employees || []) {
    const weights = new Map()
    for (const day of employee.dailyExplanations || []) {
      if (!day.storeKey || day.payableHoursSource !== 'ACTUAL_HOURS') continue
      const weight = BigInt(Math.round(Number(day.payableHours || 0) * 100))
      if (weight > 0n) weights.set(day.storeKey, (weights.get(day.storeKey) || 0n) + weight)
    }
    const totalCents = BigInt(Math.round(Number(employee.salary || 0) * 100))
    if (totalCents !== 0n && weights.size === 0) return { incomplete: true, totals }
    for (const row of deterministicAllocateCents(totalCents, [...weights].sort(([a], [b]) => a.localeCompare(b)).map(([storeKey, weight]) => ({ storeKey, weight })))) {
      if (totals.has(row.storeKey)) totals.set(row.storeKey, totals.get(row.storeKey) + row.amountCents)
    }
  }
  return { incomplete: false, totals }
}

export class OperatingCostAuthority {
  constructor(prisma, reportQueryService, { now = () => new Date(), payrollLoader = loadAuthoritativePayrollRange } = {}) {
    this.prisma = prisma
    this.reportQueryService = reportQueryService
    this.now = now
    this.payrollLoader = payrollLoader
  }

  async _build(user, query, prepared = {}) {
    const scope = prepared.scope || await this.reportQueryService.resolveScope(user, query)
    const summary = prepared.summary || await this.reportQueryService.summary(user, query, scope, { includeCompositions: false })
    const segments = monthSegments(scope.range.from, scope.range.to)
    const stores = scope.stores.map((row) => row.key)
    const periods = segments.map((row) => dbDate(row.period))
    const [cogs, rentRows, utilities, laborPeriods, expenses] = await Promise.all([
      queryCogs(this.prisma, scope.days.filter((row) => row.authority === 'POS')),
      this.prisma.storeRentHistory.findMany({ where: { storeKey: { in: stores }, effectiveFrom: { lte: dbDate(scope.range.to) }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: dbDate(scope.range.from) } }] }, orderBy: [{ storeKey: 'asc' }, { effectiveFrom: 'asc' }] }),
      this.prisma.storeUtilityCost.findMany({ where: { storeKey: { in: stores }, period: { in: periods } } }),
      this.prisma.storeLaborCostPeriod.findMany({ where: { storeKey: { in: stores }, period: { in: periods } }, include: { entries: true } }),
      this.prisma.expense.findMany({ where: { storeKey: { in: stores }, date: { gte: scope.range.start, lt: scope.range.endExclusive } } }),
    ])
    const payroll = new Map()
    for (const segment of segments) payroll.set(segment.month, payrollMonth(await this.payrollLoader(this.prisma, { month: segment.month }), stores))
    const byStore = []
    const summaryDayMap = new Map(summary.daily.map((row) => [`${row.storeKey}|${row.date}`, row]))
    const today = buduBusinessDate(this.now())
    for (const store of scope.stores) {
      const storeCodes = new Set()
      const storeEstimates = new Set()
      const storeWarnings = new Set()
      const values = { revenue: 0n, cogs: 0n, labor: 0n, rent: 0n, utility: 0n, other: 0n }
      const laborBreakdown = { wages: 0n, socialSecurity: 0n, providentFund: 0n, other: 0n }
      const rentBreakdown = []
      const utilityBreakdown = []
      for (const day of scope.days.filter((row) => row.storeKey === store.key)) {
        const summaryDay = summaryDayMap.get(`${day.storeKey}|${day.date}`)
        if (summaryDay?.revenueCents != null) values.revenue += BigInt(summaryDay.revenueCents)
        else storeCodes.add('PARTIAL_SOURCE_COVERAGE')
        if (day.authority !== 'POS') storeCodes.add('INCOMPLETE_COGS')
        else values.cogs += cogs.get(`${store.key}|${day.date}`) || 0n
      }
      for (const segment of segments) {
        const rent = rentRows.find((row) => row.storeKey === store.key && dateText(row.effectiveFrom) <= segment.from && (!row.effectiveTo || dateText(row.effectiveTo) > segment.from))
        if (!rent) {
          storeCodes.add('INCOMPLETE_RENT')
          rentBreakdown.push({ month: segment.month, status: 'INCOMPLETE', reasonCode: 'INCOMPLETE_RENT', amountCents: null })
        }
        else {
          const grossCents = sumDaily(summary, store.key, segment.from, segment.to, 'grossCents')
          const netRevenueCents = sumDaily(summary, store.key, segment.from, segment.to, 'revenueCents')
          const result = calculateRentCents(rent, {
            grossCents,
            netRevenueCents,
            selectedDays: segment.selectedDays, totalDays: segment.totalDays,
          })
          if (result.amountCents == null) storeCodes.add(result.reasonCode)
          else values.rent += result.amountCents
          rentBreakdown.push({
            month: segment.month, status: result.amountCents == null ? 'INCOMPLETE' : 'AVAILABLE',
            reasonCode: result.reasonCode, amountCents: result.amountCents?.toString() ?? null,
            mode: rent.mode, fixedAmountCents: rent.fixedAmountCents?.toString() ?? null,
            percentageBps: rent.percentageBps, percentageBasis: rent.percentageBasis,
            basisCents: rent.percentageBasis === 'GROSS_SALES' ? grossCents?.toString() ?? null : netRevenueCents?.toString() ?? null,
            selectedDays: segment.selectedDays, totalDays: segment.totalDays,
          })
          if (segment.selectedDays !== segment.totalDays || segment.to >= today) storeEstimates.add('ESTIMATED_CURRENT_PERIOD')
        }
        const utility = utilities.find((row) => row.storeKey === store.key && dateText(row.period) === segment.period)
        if (!utility) {
          storeCodes.add('INCOMPLETE_UTILITY')
          utilityBreakdown.push({ month: segment.month, status: 'INCOMPLETE', amountCents: null, source: null })
        }
        else {
          const amount = prorate(utility.actualCents ?? utility.estimatedCents, segment.selectedDays, segment.totalDays)
          values.utility += amount
          utilityBreakdown.push({
            month: segment.month, status: utility.actualCents == null ? 'ESTIMATED' : 'ACTUAL',
            source: utility.actualCents == null ? 'ESTIMATE' : 'ACTUAL', amountCents: amount.toString(),
            estimatedCents: utility.estimatedCents.toString(), actualCents: utility.actualCents?.toString() ?? null,
            differenceCents: utility.actualCents == null ? null : (BigInt(utility.actualCents) - BigInt(utility.estimatedCents)).toString(),
            selectedDays: segment.selectedDays, totalDays: segment.totalDays,
          })
          if (utility.actualCents == null) storeEstimates.add('ESTIMATED_UTILITY')
          if (segment.selectedDays !== segment.totalDays) storeEstimates.add('ESTIMATED_PARTIAL_MONTH_ALLOCATION')
        }
        const pay = payroll.get(segment.month)
        const laborPeriod = laborPeriods.find((row) => row.storeKey === store.key && dateText(row.period) === segment.period)
        if (pay?.incomplete || !laborPeriod) storeCodes.add('INCOMPLETE_LABOR')
        else {
          const wage = prorate(pay.totals.get(store.key) || 0n, segment.selectedDays, segment.totalDays)
          const addOn = (category) => prorate(sumBigInt(laborPeriod.entries.filter((row) => row.category === category), (row) => row.amountCents), segment.selectedDays, segment.totalDays)
          const social = addOn('SOCIAL_SECURITY')
          const provident = addOn('PROVIDENT_FUND')
          const other = addOn('OTHER')
          laborBreakdown.wages += wage; laborBreakdown.socialSecurity += social; laborBreakdown.providentFund += provident; laborBreakdown.other += other
          values.labor += wage + social + provident + other
          if (segment.selectedDays !== segment.totalDays || segment.to >= today) storeEstimates.add('ESTIMATED_CURRENT_PERIOD')
        }
      }
      const storeExpenses = expenses.filter((row) => row.storeKey === store.key)
      values.other = storeExpenses.reduce((sum, row) => sum + BigInt(row.amountCents), 0n)
      if (storeExpenses.some((row) => /房租|租金|水费|电费|水电|社保|公积金/.test(`${row.category} ${row.note}`))) storeWarnings.add('POSSIBLE_DUPLICATE_STRUCTURED_COST')
      const state = storeCodes.size ? OPERATING_PROFIT_STATES.INCOMPLETE : storeEstimates.size ? OPERATING_PROFIT_STATES.ESTIMATED : OPERATING_PROFIT_STATES.EXACT
      const profit = values.revenue - values.cogs - values.labor - values.rent - values.utility - values.other
      byStore.push({
        storeKey: store.key, storeName: store.name, state,
        completenessCodes: [...storeCodes].sort(), estimateCodes: [...storeEstimates].sort(), warningCodes: [...storeWarnings].sort(),
        exactOperatingProfitCents: state === OPERATING_PROFIT_STATES.EXACT ? profit.toString() : null,
        estimatedOperatingProfitCents: state === OPERATING_PROFIT_STATES.ESTIMATED ? profit.toString() : null,
        profitMarginBps: state === OPERATING_PROFIT_STATES.EXACT ? bps(profit, values.revenue) : null,
        estimatedProfitMarginBps: state === OPERATING_PROFIT_STATES.ESTIMATED ? bps(profit, values.revenue) : null,
        revenueCents: values.revenue.toString(), cogsCents: storeCodes.has('INCOMPLETE_COGS') ? null : values.cogs.toString(),
        laborCents: storeCodes.has('INCOMPLETE_LABOR') ? null : values.labor.toString(),
        rentCents: [...storeCodes].some((code) => code.startsWith('INCOMPLETE_RENT')) ? null : values.rent.toString(),
        utilityCents: storeCodes.has('INCOMPLETE_UTILITY') ? null : values.utility.toString(), otherCents: values.other.toString(),
        components: {
          revenue: { amountCents: values.revenue.toString(), status: storeCodes.has('PARTIAL_SOURCE_COVERAGE') ? 'INCOMPLETE' : 'AVAILABLE', source: 'REPORT_QUERY_AUTHORITY' },
          cogs: { amountCents: storeCodes.has('INCOMPLETE_COGS') ? null : values.cogs.toString(), status: storeCodes.has('INCOMPLETE_COGS') ? 'INCOMPLETE' : 'AVAILABLE', source: 'ORDER_ITEM_COST_PRICE_SNAPSHOT' },
          labor: { amountCents: storeCodes.has('INCOMPLETE_LABOR') ? null : values.labor.toString(), status: storeCodes.has('INCOMPLETE_LABOR') ? 'INCOMPLETE' : 'AVAILABLE', source: 'PAYROLL_ACTUAL_HOURS_ALLOCATION', confirmedZero: segments.every((segment) => laborPeriods.some((row) => row.storeKey === store.key && dateText(row.period) === segment.period)) && values.labor === 0n, breakdown: Object.fromEntries(Object.entries(laborBreakdown).map(([key, value]) => [`${key}Cents`, value.toString()])) },
          rent: { amountCents: [...storeCodes].some((code) => code.startsWith('INCOMPLETE_RENT')) ? null : values.rent.toString(), status: [...storeCodes].some((code) => code.startsWith('INCOMPLETE_RENT')) ? 'INCOMPLETE' : (storeEstimates.has('ESTIMATED_CURRENT_PERIOD') ? 'ESTIMATED' : 'AVAILABLE'), source: 'STORE_RENT_HISTORY', months: rentBreakdown },
          utility: { amountCents: storeCodes.has('INCOMPLETE_UTILITY') ? null : values.utility.toString(), status: storeCodes.has('INCOMPLETE_UTILITY') ? 'INCOMPLETE' : (storeEstimates.has('ESTIMATED_UTILITY') ? 'ESTIMATED' : 'ACTUAL'), source: 'STORE_UTILITY_COST', months: utilityBreakdown },
          other: { amountCents: values.other.toString(), status: 'AVAILABLE', source: 'EXPENSE', expenseCount: storeExpenses.length },
        },
      })
    }
    const total = (field) => byStore.reduce((sum, row) => sum + BigInt(row[field] ?? 0), 0n)
    const codes = new Set(byStore.flatMap((row) => row.completenessCodes))
    const estimates = new Set(byStore.flatMap((row) => row.estimateCodes))
    const warnings = new Set(byStore.flatMap((row) => row.warningCodes))
    const missing = codes.size > 0
    const state = missing ? OPERATING_PROFIT_STATES.INCOMPLETE : estimates.size ? OPERATING_PROFIT_STATES.ESTIMATED : OPERATING_PROFIT_STATES.EXACT
    const profit = total('revenueCents') - total('cogsCents') - total('laborCents') - total('rentCents') - total('utilityCents') - total('otherCents')
    const exactStores = byStore.filter((row) => row.state === OPERATING_PROFIT_STATES.EXACT).sort((a, b) => BigInt(a.exactOperatingProfitCents) === BigInt(b.exactOperatingProfitCents) ? a.storeName.localeCompare(b.storeName, 'zh-CN') : BigInt(a.exactOperatingProfitCents) > BigInt(b.exactOperatingProfitCents) ? -1 : 1)
    return {
      range: { from: scope.range.from, to: scope.range.to }, state,
      completenessCodes: [...codes].sort(), estimateCodes: [...estimates].sort(), warningCodes: [...warnings].sort(),
      exactOperatingProfitCents: state === OPERATING_PROFIT_STATES.EXACT ? profit.toString() : null,
      estimatedOperatingProfitCents: state === OPERATING_PROFIT_STATES.ESTIMATED ? profit.toString() : null,
      profitMarginBps: state === OPERATING_PROFIT_STATES.EXACT ? bps(profit, total('revenueCents')) : null,
      estimatedProfitMarginBps: state === OPERATING_PROFIT_STATES.ESTIMATED ? bps(profit, total('revenueCents')) : null,
      totals: { revenueCents: total('revenueCents').toString(), cogsCents: missing && codes.has('INCOMPLETE_COGS') ? null : total('cogsCents').toString(), laborCents: codes.has('INCOMPLETE_LABOR') ? null : total('laborCents').toString(), rentCents: [...codes].some((code) => code.startsWith('INCOMPLETE_RENT')) ? null : total('rentCents').toString(), utilityCents: codes.has('INCOMPLETE_UTILITY') ? null : total('utilityCents').toString(), otherCents: total('otherCents').toString() },
      stores: byStore,
      storeGroups: { exact: exactStores, estimated: byStore.filter((row) => row.state === OPERATING_PROFIT_STATES.ESTIMATED), incomplete: byStore.filter((row) => row.state === OPERATING_PROFIT_STATES.INCOMPLETE) },
      queryEvidence: { boundedBy: ['STORE', 'MONTH', 'DATE_RANGE'], perOrderCostLookup: false, perEmployeePayrollQuery: false, perDayRentQuery: false },
    }
  }

  _comparison(current, previous, mode) {
    const currentStores = current.stores.map((row) => row.storeKey).sort()
    const previousStores = previous?.stores?.map((row) => row.storeKey).sort() || []
    const sameCoverage = currentStores.length === previousStores.length && currentStores.every((key, index) => key === previousStores[index])
    if (current.state !== OPERATING_PROFIT_STATES.EXACT || previous?.state !== OPERATING_PROFIT_STATES.EXACT || !sameCoverage) {
      return { state: OPERATING_PROFIT_COMPARISON_STATES.INCOMPARABLE, mode, changeBps: null, currentRange: current.range, comparisonRange: previous?.range || null, reasonCodes: ['PROFIT_PERIODS_NOT_EXACT_OR_COMPARABLE'] }
    }
    const currentValue = BigInt(current.exactOperatingProfitCents)
    const previousValue = BigInt(previous.exactOperatingProfitCents)
    return { state: OPERATING_PROFIT_COMPARISON_STATES.COMPARABLE, mode, currentValueCents: currentValue.toString(), comparisonValueCents: previousValue.toString(), changeBps: previousValue === 0n ? null : (((currentValue - previousValue) * 10_000n) / (previousValue < 0n ? -previousValue : previousValue)).toString(), currentRange: current.range, comparisonRange: previous.range, reasonCodes: previousValue === 0n ? ['ZERO_COMPARISON_BASE'] : [] }
  }

  async report(user, query = {}, prepared = {}) {
    assertCostRead(user)
    assertLaborRead(user)
    const current = await this._build(user, query, prepared)
    const mode = String(query.compare || '').trim()
    if (!mode) return current
    const range = resolveComparisonRange({ ...current.range, days: Array.from({ length: dayCount(current.range.from, current.range.to) }) }, mode, String(query.period || '').trim())
    if (current.state !== OPERATING_PROFIT_STATES.EXACT) return { ...current, comparison: this._comparison(current, null, mode) }
    const previousPrepared = prepared.comparisonScope && prepared.comparisonSummary ? { scope: prepared.comparisonScope, summary: prepared.comparisonSummary } : {}
    const previous = await this._build(user, range, previousPrepared)
    return { ...current, comparison: this._comparison(current, previous, mode) }
  }

  async dashboardProjection(user, query, prepared = {}) {
    const report = await this.report(user, query, prepared)
    return {
      available: true, state: report.state,
      valueCents: report.exactOperatingProfitCents ?? report.estimatedOperatingProfitCents,
      label: report.state === OPERATING_PROFIT_STATES.EXACT ? '经营利润' : report.state === OPERATING_PROFIT_STATES.ESTIMATED ? '预估经营利润' : '经营利润',
      reasonCode: report.state === OPERATING_PROFIT_STATES.INCOMPLETE ? report.completenessCodes[0] || 'INCOMPLETE_OTHER' : null,
      profitMarginBps: report.profitMarginBps, estimatedProfitMarginBps: report.estimatedProfitMarginBps,
      comparison: report.comparison || null,
    }
  }

  async exportWorkbook(user, query) {
    const report = await this.report(user, query)
    const summaryRows = report.stores.map((store) => ({
      门店: store.storeName, 营业收入: store.revenueCents, 商品销售成本: store.cogsCents ?? '', 人工成本: store.laborCents ?? '',
      房租: store.rentCents ?? '', 水电: store.utilityCents ?? '', 其他经营费用: store.otherCents,
      利润状态: store.state, '经营利润/预估利润': store.exactOperatingProfitCents ?? store.estimatedOperatingProfitCents ?? '',
      利润率基点: store.profitMarginBps ?? store.estimatedProfitMarginBps ?? '', 完整性代码: store.completenessCodes.join(','), 估算代码: store.estimateCodes.join(','),
    }))
    const detailRows = report.stores.flatMap((store) => [
      ['营业收入', store.components.revenue], ['商品销售成本', store.components.cogs], ['人工成本', store.components.labor],
      ['房租', store.components.rent], ['水电', store.components.utility], ['其他经营费用', store.components.other],
    ].map(([name, component]) => ({ 门店: store.storeName, 成本项目: name, 金额: component.amountCents ?? '', 状态: component.status, 数据来源: component.source, 完整性代码: store.completenessCodes.join(','), 说明: store.warningCodes.join(',') })))
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows.length ? summaryRows : [{ 提示: '当前筛选范围没有可导出的门店事实' }]), '经营利润汇总')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(detailRows.length ? detailRows : [{ 提示: '当前筛选范围没有成本明细' }]), '成本与完整性明细')
    return { fileName: `budu经营利润_${report.range.from}_${report.range.to}.xlsx`, buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), report }
  }

  async settings(user, { store, month }) {
    assertCostRead(user); assertLaborRead(user)
    assertStore(user, store)
    const period = dbDate(`${assertMonth(month)}-01`)
    return jsonSafe({
      rent: await this.prisma.storeRentHistory.findMany({ where: { storeKey: store }, orderBy: { effectiveFrom: 'desc' } }),
      utility: await this.prisma.storeUtilityCost.findUnique({ where: { storeKey_period: { storeKey: store, period } } }),
      labor: await this.prisma.storeLaborCostPeriod.findUnique({ where: { storeKey_period: { storeKey: store, period } }, include: { entries: true } }),
    })
  }

  async addRent(user, input) {
    assertManage(user)
    assertStore(user, input.storeKey)
    const effectiveFrom = String(input.effectiveFrom || '')
    if (!/^\d{4}-\d{2}-01$/.test(effectiveFrom)) throw httpError('房租生效日期必须为自然月首日')
    const mode = String(input.mode || '')
    if (!['FIXED', 'PERCENT', 'FIXED_PLUS_PERCENT', 'MAX_FIXED_PERCENT'].includes(mode)) throw httpError('房租模式不正确')
    const fixedAmountCents = input.fixedAmountCents == null ? null : cents(input.fixedAmountCents)
    const percentageBps = input.percentageBps == null ? null : Number(input.percentageBps)
    const percentageBasis = input.percentageBasis || null
    if ((mode === 'FIXED' && fixedAmountCents == null) || (mode !== 'FIXED' && (!Number.isInteger(percentageBps) || percentageBps < 0 || percentageBps > 10_000 || !['GROSS_SALES', 'NET_REVENUE'].includes(percentageBasis))) || (['FIXED_PLUS_PERCENT', 'MAX_FIXED_PERCENT'].includes(mode) && fixedAmountCents == null)) throw httpError('房租模式与金额/抽成配置不完整')
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`rent:${input.storeKey}`}))`
      const active = await tx.storeRentHistory.findFirst({ where: { storeKey: input.storeKey, effectiveTo: null }, orderBy: { effectiveFrom: 'desc' } })
      if (active && dateText(active.effectiveFrom) >= effectiveFrom) throw httpError('房租配置只能按未来自然月追加', 409)
      if (active) await tx.storeRentHistory.update({ where: { id: active.id }, data: { effectiveTo: dbDate(effectiveFrom) } })
      return tx.storeRentHistory.create({ data: { id: `rent-${crypto.randomUUID()}`, storeKey: input.storeKey, mode, fixedAmountCents, percentageBps, percentageBasis, effectiveFrom: dbDate(effectiveFrom), reason: String(input.reason || ''), createdBy: user.username || user.id || '' } })
    })
    return jsonSafe(created)
  }

  async setUtility(user, input) {
    assertManage(user)
    assertStore(user, input.storeKey)
    const period = dbDate(`${assertMonth(input.month)}-01`)
    const existing = await this.prisma.storeUtilityCost.findUnique({ where: { storeKey_period: { storeKey: input.storeKey, period } } })
    if (existing?.actualCents != null) throw httpError('水电实际值已确认，不能覆盖历史事实', 409)
    if (existing && input.estimatedCents != null && BigInt(existing.estimatedCents) !== cents(input.estimatedCents)) throw httpError('历史预估值不可覆盖；只允许补充实际值', 409)
    return jsonSafe(await this.prisma.storeUtilityCost.upsert({ where: { storeKey_period: { storeKey: input.storeKey, period } }, create: { id: `utility-${crypto.randomUUID()}`, storeKey: input.storeKey, period, estimatedCents: cents(input.estimatedCents, '水电预估'), actualCents: input.actualCents == null ? null : cents(input.actualCents, '水电实际'), note: String(input.note || ''), createdBy: user.username || user.id || '', updatedBy: user.username || user.id || '' }, update: { actualCents: input.actualCents == null ? null : cents(input.actualCents, '水电实际'), note: String(input.note || existing.note), updatedBy: user.username || user.id || '' } }))
  }

  async confirmLaborPeriod(user, input) {
    assertManage(user)
    assertStore(user, input.storeKey)
    const period = dbDate(`${assertMonth(input.month)}-01`)
    const entries = Array.isArray(input.entries) ? input.entries : []
    if (entries.some((row) => !['SOCIAL_SECURITY', 'PROVIDENT_FUND', 'OTHER'].includes(row.category))) throw httpError('人工附加成本类型不正确')
    return jsonSafe(await this.prisma.storeLaborCostPeriod.create({ data: { id: `labor-period-${crypto.randomUUID()}`, storeKey: input.storeKey, period, note: String(input.note || ''), confirmedAt: new Date(), confirmedBy: user.username || user.id || '', entries: { create: entries.map((row) => ({ id: `labor-cost-${crypto.randomUUID()}`, category: row.category, amountCents: cents(row.amountCents, '人工附加成本'), employeeId: row.employeeId || null, note: String(row.note || ''), createdBy: user.username || user.id || '' })) } }, include: { entries: true } }))
  }
}
