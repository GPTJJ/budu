import test from 'node:test'
import assert from 'node:assert/strict'
import { OperatingCostAuthority } from '../server/operating-cost-authority.js'

const exact = (value = '10000', stores = ['a']) => ({
  state: 'EXACT', range: { from: '2026-07-01', to: '2026-07-31' }, exactOperatingProfitCents: value,
  stores: stores.map((storeKey) => ({ storeKey })),
})

test('operating profit comparison is exact-only and same-store-only', () => {
  const authority = new OperatingCostAuthority({}, {})
  const comparable = authority._comparison(exact('12000'), exact('10000'), 'previous')
  assert.equal(comparable.state, 'COMPARABLE')
  assert.equal(comparable.changeBps, '2000')
  assert.equal(authority._comparison({ ...exact(), state: 'ESTIMATED' }, exact(), 'previous').state, 'INCOMPARABLE')
  assert.equal(authority._comparison(exact(), { ...exact(), state: 'INCOMPLETE' }, 'year').state, 'INCOMPARABLE')
  assert.equal(authority._comparison(exact('10000', ['a', 'b']), exact('9000', ['a']), 'previous').state, 'INCOMPARABLE')
})

test('zero comparison base never emits Infinity or a fake percentage', () => {
  const authority = new OperatingCostAuthority({}, {})
  const result = authority._comparison(exact('10000'), exact('0'), 'previous')
  assert.equal(result.state, 'COMPARABLE')
  assert.equal(result.changeBps, null)
  assert.deepEqual(result.reasonCodes, ['ZERO_COMPARISON_BASE'])
})

test('profit aggregation query count is bounded by range/months, not stores or orders', async () => {
  const counters = { raw: 0, rent: 0, utility: 0, labor: 0, expense: 0, payroll: 0 }
  const stores = Array.from({ length: 20 }, (_, index) => ({ key: `store-${index}`, name: `门店${index}` }))
  const dates = Array.from({ length: 31 }, (_, index) => `2026-08-${String(index + 1).padStart(2, '0')}`)
  const dayRows = stores.flatMap((store) => dates.map((date) => ({ storeKey: store.key, storeName: store.name, date, authority: 'POS' })))
  const prisma = {
    $queryRaw: async () => { counters.raw += 1; return stores.map((store) => ({ storeKey: store.key, date: new Date('2026-08-31T00:00:00Z'), cogsCents: 100n })) },
    storeRentHistory: { findMany: async () => { counters.rent += 1; return stores.map((store) => ({ storeKey: store.key, mode: 'FIXED', fixedAmountCents: 3100n, percentageBps: null, percentageBasis: null, effectiveFrom: new Date('2026-08-01T00:00:00Z'), effectiveTo: null })) } },
    storeUtilityCost: { findMany: async () => { counters.utility += 1; return stores.map((store) => ({ storeKey: store.key, period: new Date('2026-08-01T00:00:00Z'), estimatedCents: 3100n, actualCents: 3100n })) } },
    storeLaborCostPeriod: { findMany: async () => { counters.labor += 1; return stores.map((store) => ({ storeKey: store.key, period: new Date('2026-08-01T00:00:00Z'), entries: [] })) } },
    expense: { findMany: async () => { counters.expense += 1; return [] } },
  }
  const range = { from: '2026-08-01', to: '2026-08-31', start: new Date('2026-08-01T00:00:00Z'), endExclusive: new Date('2026-09-01T00:00:00Z') }
  const reportQuery = {
    resolveScope: async () => ({ range, stores, days: dayRows }),
    summary: async () => ({ daily: dayRows.map((row) => ({ storeKey: row.storeKey, date: row.date, revenueCents: '1000', grossCents: '1000' })) }),
  }
  const payrollLoader = async () => { counters.payroll += 1; return { result: { calculationReady: true, mode: 'EMPLOYEE_ID', payroll: { employees: [] } } } }
  const authority = new OperatingCostAuthority(prisma, reportQuery, { now: () => new Date('2026-09-30T12:00:00+08:00'), payrollLoader })
  const user = { role: 'finance', permissions: { reportCostView: true, reportLaborView: true, reportAllStores: true } }
  const result = await authority.report(user, { from: range.from, to: range.to })
  assert.equal(result.stores.length, 20)
  assert.equal(result.state, 'EXACT')
  assert.equal(result.storeGroups.exact.length, 20)
  assert.equal(result.storeGroups.estimated.length, 0)
  assert.deepEqual(counters, { raw: 1, rent: 1, utility: 1, labor: 1, expense: 1, payroll: 1 })
  assert.deepEqual(result.queryEvidence, { boundedBy: ['STORE', 'MONTH', 'DATE_RANGE'], perOrderCostLookup: false, perEmployeePayrollQuery: false, perDayRentQuery: false })
})

test('sales-only and cost-without-labor users cannot read operating profit', async () => {
  const authority = new OperatingCostAuthority({}, {})
  await assert.rejects(authority.report({ role: 'staff', permissions: { reportSalesView: true } }, {}), (error) => error.status === 403)
  await assert.rejects(authority.report({ role: 'finance', permissions: { reportCostView: true, reportLaborView: false } }, {}), (error) => error.status === 403)
})
