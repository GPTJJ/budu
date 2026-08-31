import crypto from 'node:crypto'
import { Prisma } from '@prisma/client'
import { hasReportAllStores, hasReportCostManage, hasReportCostView, hasReportLaborView } from '../shared/accountPermissions.js'
import { buduBusinessDate } from '../shared/businessDate.js'
import { loadAuthoritativePayrollRange } from './payroll-authority.js'
import { httpError } from './pos-core.js'

export const OPERATING_PROFIT_STATES = Object.freeze({ EXACT: 'EXACT', ESTIMATED: 'ESTIMATED', INCOMPLETE: 'INCOMPLETE' })

const dateText = (value) => new Date(value).toISOString().slice(0, 10)
const dbDate = (value) => new Date(`${value}T00:00:00.000Z`)
const monthStart = (value) => `${value.slice(0, 7)}-01`
const daysInMonth = (value) => new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)), 0)).getUTCDate()
const monthEnd = (value) => `${value.slice(0, 7)}-${String(daysInMonth(value)).padStart(2, '0')}`
const minDate = (a, b) => a < b ? a : b
const maxDate = (a, b) => a > b ? a : b
const dayCount = (from, to) => Math.round((dbDate(to) - dbDate(from)) / 86_400_000) + 1
const prorate = (cents, selectedDays, totalDays) => (BigInt(cents) * BigInt(selectedDays)) / BigInt(totalDays)
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

  async report(user, query) {
    assertCostRead(user)
    assertLaborRead(user)
    const scope = await this.reportQueryService.resolveScope(user, query)
    const summary = await this.reportQueryService.summary(user, query, scope, { includeCompositions: false })
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
    const codes = new Set()
    const estimates = new Set()
    const warnings = new Set()
    const byStore = []
    const summaryDayMap = new Map(summary.daily.map((row) => [`${row.storeKey}|${row.date}`, row]))
    const today = buduBusinessDate(this.now())
    for (const store of scope.stores) {
      const values = { revenue: 0n, cogs: 0n, labor: 0n, rent: 0n, utility: 0n, other: 0n }
      let storeIncomplete = false
      for (const day of scope.days.filter((row) => row.storeKey === store.key)) {
        const summaryDay = summaryDayMap.get(`${day.storeKey}|${day.date}`)
        if (summaryDay?.revenueCents != null) values.revenue += BigInt(summaryDay.revenueCents)
        else { codes.add('PARTIAL_SOURCE_COVERAGE'); storeIncomplete = true }
        if (day.authority !== 'POS') { codes.add('INCOMPLETE_COGS'); storeIncomplete = true }
        else values.cogs += cogs.get(`${store.key}|${day.date}`) || 0n
      }
      for (const segment of segments) {
        const rent = rentRows.find((row) => row.storeKey === store.key && dateText(row.effectiveFrom) <= segment.from && (!row.effectiveTo || dateText(row.effectiveTo) > segment.from))
        if (!rent) { codes.add('INCOMPLETE_RENT'); storeIncomplete = true }
        else {
          const result = calculateRentCents(rent, {
            grossCents: sumDaily(summary, store.key, segment.from, segment.to, 'grossCents'),
            netRevenueCents: sumDaily(summary, store.key, segment.from, segment.to, 'revenueCents'),
            selectedDays: segment.selectedDays, totalDays: segment.totalDays,
          })
          if (result.amountCents == null) { codes.add(result.reasonCode); storeIncomplete = true } else values.rent += result.amountCents
          if (segment.selectedDays !== segment.totalDays || segment.to >= today) estimates.add('ESTIMATED_CURRENT_PERIOD')
        }
        const utility = utilities.find((row) => row.storeKey === store.key && dateText(row.period) === segment.period)
        if (!utility) { codes.add('INCOMPLETE_UTILITY'); storeIncomplete = true }
        else {
          values.utility += prorate(utility.actualCents ?? utility.estimatedCents, segment.selectedDays, segment.totalDays)
          if (utility.actualCents == null) estimates.add('ESTIMATED_UTILITY')
          if (segment.selectedDays !== segment.totalDays) estimates.add('ESTIMATED_PARTIAL_MONTH_ALLOCATION')
        }
        const pay = payroll.get(segment.month)
        const laborPeriod = laborPeriods.find((row) => row.storeKey === store.key && dateText(row.period) === segment.period)
        if (pay?.incomplete || !laborPeriod) { codes.add('INCOMPLETE_LABOR'); storeIncomplete = true }
        else {
          values.labor += prorate(pay.totals.get(store.key) || 0n, segment.selectedDays, segment.totalDays)
          values.labor += prorate(laborPeriod.entries.reduce((sum, row) => sum + BigInt(row.amountCents), 0n), segment.selectedDays, segment.totalDays)
          if (segment.selectedDays !== segment.totalDays || segment.to >= today) estimates.add('ESTIMATED_CURRENT_PERIOD')
        }
      }
      const storeExpenses = expenses.filter((row) => row.storeKey === store.key)
      values.other = storeExpenses.reduce((sum, row) => sum + BigInt(row.amountCents), 0n)
      if (storeExpenses.some((row) => /房租|租金|水费|电费|水电|社保|公积金/.test(`${row.category} ${row.note}`))) warnings.add('POSSIBLE_DUPLICATE_STRUCTURED_COST')
      byStore.push({ storeKey: store.key, storeName: store.name, incomplete: storeIncomplete, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [`${key}Cents`, value.toString()])) })
    }
    const total = (field) => byStore.reduce((sum, row) => sum + BigInt(row[field]), 0n)
    const missing = codes.size > 0
    const state = missing ? OPERATING_PROFIT_STATES.INCOMPLETE : estimates.size ? OPERATING_PROFIT_STATES.ESTIMATED : OPERATING_PROFIT_STATES.EXACT
    const profit = total('revenueCents') - total('cogsCents') - total('laborCents') - total('rentCents') - total('utilityCents') - total('otherCents')
    return {
      range: { from: scope.range.from, to: scope.range.to }, state,
      completenessCodes: [...codes].sort(), estimateCodes: [...estimates].sort(), warningCodes: [...warnings].sort(),
      exactOperatingProfitCents: state === OPERATING_PROFIT_STATES.EXACT ? profit.toString() : null,
      estimatedOperatingProfitCents: state === OPERATING_PROFIT_STATES.ESTIMATED ? profit.toString() : null,
      totals: { revenueCents: total('revenueCents').toString(), cogsCents: missing && codes.has('INCOMPLETE_COGS') ? null : total('cogsCents').toString(), laborCents: codes.has('INCOMPLETE_LABOR') ? null : total('laborCents').toString(), rentCents: [...codes].some((code) => code.startsWith('INCOMPLETE_RENT')) ? null : total('rentCents').toString(), utilityCents: codes.has('INCOMPLETE_UTILITY') ? null : total('utilityCents').toString(), otherCents: total('otherCents').toString() },
      stores: byStore,
    }
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
