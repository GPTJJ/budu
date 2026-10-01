import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { resolveDailyEntrySalesRows, aggregatePosDay } from '../server/daily-sales-authority.js'
import { loadAuthoritativePayrollRange } from '../server/payroll-authority.js'
import { resolvePayrollCalculation } from '../src/utils/payrollResolver.js'
import { personnelMonthlyComponents } from '../src/utils/payrollDisplay.js'
const date = (s) => new Date(`${s}T00:00:00Z`)
const store = { key: 'xidan', name: '北京西单店', salesDataSource: 'pos', salesDataSourceEffectiveDate: date('2026-09-04') }
const entry = (day, extra = {}) => ({ id: day, storeKey: 'xidan', date: date(day), incCents: 0n, ord: 0, status: 'confirmed', staffNames: ['A'], hybridAdjustmentCents: 0n, ...extra })
const order = (day, amount = 253000n, extra = {}) => ({ storeId: 'xidan', businessDate: date(day), subtotal: amount + 29900n, payableAmount: amount, discountAmount: 29900n, status: 'completed', paymentStatus: 'paid', payments: [{ status: 'success', amount, channel: 'wechat' }], refunds: [], ...extra })
function client(entries, stores = [store], orders = [], adjustments = [], staff = []) {
  const calls = []
  return {
    calls,
    dailyEntry: { findMany: async () => entries },
    store: { findMany: async () => stores },
    order: { findMany: async (q) => {
      calls.push(q)
      assert.deepEqual(q.where.AND.slice(1), [{ status: { in: ['paid', 'completed'] } }, { paymentStatus: 'paid' }, { payments: { some: { status: 'success' } } }, { refunds: { none: {} } }])
      const scope = q.where.AND[0]
      return orders.filter(o => o.storeId === scope.storeId && (scope.businessDate instanceof Date ? +o.businessDate === +scope.businessDate : o.businessDate >= scope.businessDate.gte && o.businessDate < scope.businessDate.lt) && ['paid', 'completed'].includes(o.status) && o.paymentStatus === 'paid' && o.payments.some(p => p.status === 'success') && o.refunds.length === 0)
    } },
    refund: { findMany: async () => [] },
    dailyStoreStaff: { findMany: async () => staff },
    dailyPayAdjustment: { findMany: async () => adjustments },
    bigOrderBonus: { findMany: async () => [] },
    employee: { findMany: async () => ['A', 'B'].map(id => ({ id, name: id, employmentType: 'fulltime', status: 'ACTIVE', currentStoreKey: 'xidan' })) },
    user: { findMany: async () => [] },
  }
}
const attendance = (id, day, hours) => ({ id: `${id}-${day}`, storeId: 'xidan', date: date(day), employeeId: id, participantType: 'EMPLOYEE', staffNameSnapshot: id, actualHours: hours, payableHoursSource: 'ACTUAL_HOURS', attendanceStatus: 'normal' })
const period = (start, end = start) => ({ periodType: 'custom', periodStart: start, periodEnd: end })

test('POS revenue is net recognized payableAmount; refunded/pending/test-date orders do not leak; read is idempotent', async () => {
  const rows = [entry('2026-09-30')]
  const original = structuredClone(rows)
  const c = client(rows, [store], [order('2026-09-30'), order('2026-09-30', 999999n, { refunds: [{ status: 'pending' }] }), order('2026-09-30', 999999n, { paymentStatus: 'unpaid' }), order('2026-10-01')])
  const resolved = await resolveDailyEntrySalesRows(c, rows)
  assert.equal(resolved[0].incCents, 253000n)
  assert.equal(resolved[0].ord, 1)
  assert.deepEqual(await resolveDailyEntrySalesRows(c, rows), resolved)
  assert.deepEqual(rows, original)
  const pos = await aggregatePosDay('xidan', '2026-09-30', c)
  assert.equal(resolved[0].incCents.toString(), pos.effectiveAfterRefund)
})

test('manual before POS effective date and explicit corrected history retain recorded amounts', async () => {
  const rows = [entry('2026-09-03', { incCents: 230000n, ord: 7 }), entry('2026-09-04'), entry('2026-09-05', { salesDataStatus: 'corrected', incCents: 280000n, ord: 8 })]
  const c = client(rows, [store], [order('2026-09-03', 999999n), order('2026-09-04'), order('2026-09-05', 999999n)])
  const r = await resolveDailyEntrySalesRows(c, rows)
  assert.deepEqual(r.map(x => [x.incCents, x.ord]), [[230000n, 7], [253000n, 1], [280000n, 8]])
  const manual = { ...store, salesDataSource: 'manual' }
  const m = client(rows, [manual])
  assert.deepEqual(await resolveDailyEntrySalesRows(m, rows), rows)
  assert.equal(m.calls.length, 0)
})

test('hybrid alone adds hybrid adjustment; POS zero orders yields zero even with stale raw sales', async () => {
  const rows = [entry('2026-09-30', { hybridAdjustmentCents: 10000n })]
  const h = client(rows, [{ ...store, salesDataSource: 'hybrid' }], [order('2026-09-30')])
  assert.equal((await resolveDailyEntrySalesRows(h, rows))[0].incCents, 263000n)
  const p = client(rows, [store], [order('2026-09-30')])
  assert.equal((await resolveDailyEntrySalesRows(p, rows))[0].incCents, 253000n)
  const stale = [entry('2026-09-30', { incCents: 999999n, ord: 20 })]
  assert.deepEqual((await resolveDailyEntrySalesRows(client(stale), stale)).map(x => [x.incCents, x.ord]), [[0n, 0]])
})

test('cross-month ranges use businessDate UTC date boundaries and isolate stores', async () => {
  const rows = [entry('2026-09-30'), entry('2026-10-01'), { ...entry('2026-09-30'), storeKey: 'manual' }]
  const c = client(rows, [store, { key: 'manual', salesDataSource: 'manual' }], [order('2026-09-30', 200000n, { createdAt: new Date('2026-10-01T01:00:00Z') }), order('2026-10-01', 300000n), order('2026-10-02', 999999n)])
  const r = await resolveDailyEntrySalesRows(c, rows)
  assert.deepEqual(r.map(x => x.incCents), [200000n, 300000n, 0n])
  assert.equal(c.calls.length, 1)
  assert.equal(c.calls[0].where.AND[0].businessDate.lt.toISOString(), '2026-10-02T00:00:00.000Z')
})

test('unknown source/store fails closed; empty input reads nothing', async () => {
  await assert.rejects(resolveDailyEntrySalesRows(client([entry('2026-09-30')], []), [entry('2026-09-30')]), /authority missing/)
  await assert.rejects(resolveDailyEntrySalesRows(client([entry('2026-09-30')], [{ ...store, salesDataSource: 'invalid' }]), [entry('2026-09-30')]), /authority missing/)
  assert.deepEqual(await resolveDailyEntrySalesRows({}, []), [])
})

test('same canonical loader/resolver returns known 12h POS commission and card agrees', async () => {
  const c = client([entry('2026-09-30')], [store], [order('2026-09-30')], [], [attendance('A', '2026-09-30', 12)])
  const a = await loadAuthoritativePayrollRange(c, period('2026-09-30'))
  const rec = a.result.payroll.employees[0]
  assert.equal(rec.basePay, 360)
  assert.equal(rec.commission, 60)
  assert.equal(rec.salary, 420)
  assert.equal(rec.dailyExplanations[0].explanation.commissionBasis, 2530)
  assert.equal(personnelMonthlyComponents(rec).salary, 420)
})

test('target equality qualifies and each participant uses full store revenue with own hours', async () => {
  const c = client([entry('2026-09-30', { staffNames: ['A', 'B'] })], [store], [order('2026-09-30', 200000n)], [], [attendance('A', '2026-09-30', 8), attendance('B', '2026-09-30', 4)])
  const a = await loadAuthoritativePayrollRange(c, period('2026-09-30'))
  assert.deepEqual(a.result.payroll.employees.map(r => [r.employeeId, r.commission, r.workedRevenue]), [['A', 40, 1000], ['B', 20, 1000]])
})

test('active total-pay override stays fixed while components reflect correct POS revenue', async () => {
  const adj = { id: 'adj', employeeId: 'A', date: date('2026-09-30'), autoPayCentsSnapshot: 36000n, adjustedPayCents: 46000n, reason: 'approved' }
  const c = client([entry('2026-09-30')], [store], [order('2026-09-30')], [adj], [attendance('A', '2026-09-30', 12)])
  const a = await loadAuthoritativePayrollRange(c, period('2026-09-30'))
  assert.equal(a.result.payroll.employees[0].salary, 460)
  assert.equal(a.result.payroll.employees[0].commission, 60)
  assert.equal(a.result.payroll.employees[0].salaryAdjustment, 40)
})

test('draft status and orphan attendance retain existing exclusion policy', async () => {
  const c = client([entry('2026-09-30', { status: 'draft' })], [store], [order('2026-09-30')], [], [attendance('A', '2026-09-30', 12), attendance('B', '2026-09-29', 12)])
  const a = await loadAuthoritativePayrollRange(c, period('2026-09-29', '2026-09-30'))
  assert.equal(a.result.payroll.employees.length, 0)
})

test('Personnel daily transport and server authority both call same sales projection; ledger also shares it', () => {
  const api = fs.readFileSync(new URL('../server/v2.js', import.meta.url), 'utf8')
  const route = api.slice(api.indexOf("v2Router.get('/daily-entries'"), api.indexOf("v2Router.put('/daily-entries'"))
  assert.match(route, /resolveDailyEntrySalesRows\(prisma, rows\)/)
  assert.match(route, /rows: salesRows\.map/)
  const ledger = fs.readFileSync(new URL('../server/daily-entry-upgrade.js', import.meta.url), 'utf8')
  assert.match(ledger, /resolveDailyEntrySalesRows\(prisma, entries, \[store\]\)/)
})

test('actual /daily-entries handler projects POS input used by Personnel resolver', async (t) => {
  const { prisma } = await import('../server/pg.js')
  const { v2Router } = await import('../server/v2.js')
  const c = client([entry('2026-09-30')], [store], [order('2026-09-30')], [], [attendance('A', '2026-09-30', 12)])
  const originals = {}
  for (const model of ['dailyEntry', 'store', 'order', 'refund']) { originals[model] = prisma[model]; prisma[model] = c[model] }
  t.after(() => { for (const [model, original] of Object.entries(originals)) prisma[model] = original })
  const originalUrl = process.env.DATABASE_URL
  process.env.DATABASE_URL = 'postgresql://unused-test-only'
  try {
    const route = v2Router.stack.find(layer => layer.route?.path === '/daily-entries' && layer.route.methods.get).route.stack[0].handle
    let payload
    const res = { json: data => { payload = data }, status: code => { assert.fail(`unexpected API status ${code}`) } }
    await route({ query: { store: 'xidan', month: '2026-09' }, user: { role: 'developer' } }, res)
    assert.equal(payload.rows[0].incCents, '253000')
    assert.equal(payload.rows[0].ord, 1)
    const row = payload.rows[0]
    const transportPayroll = resolvePayrollCalculation({ ...period('2026-09-30'), dailyEntries: { '2026-09|xidan|09-30': { inc: Number(row.incCents) / 100, ord: row.ord, staff: row.staffNames, status: row.status } }, dailyStoreStaffRows: [ { ...attendance('A', '2026-09-30', 12), date: '2026-09-30' } ], employees: [{ id: 'A', name: 'A', type: 'fulltime', status: 'ACTIVE' }], users: [], dailyPayAdjustments: [], bigOrderBonuses: [], storeNames: { xidan: store.name } })
    const authoritative = await loadAuthoritativePayrollRange(c, period('2026-09-30'))
    assert.deepEqual(transportPayroll.payroll.employees, authoritative.result.payroll.employees)
  } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = originalUrl
  }
})

test('snapshot sales identity changes with POS revenue/source policy, not with repeated reads', async () => {
  const c = client([entry('2026-09-30')], [store], [order('2026-09-30')], [], [attendance('A', '2026-09-30', 12)])
  const first = await loadAuthoritativePayrollRange(c, period('2026-09-30'))
  const repeat = await loadAuthoritativePayrollRange(c, period('2026-09-30'))
  assert.deepEqual(first.salesInputs, repeat.salesInputs)
  assert.equal(first.salesInputs[0].incCents, '253000')
  assert.equal(first.salesInputs[0].sourceEffectiveDate, '2026-09-04')
  const changed = client([entry('2026-09-30')], [store], [order('2026-09-30', 263000n)], [], [attendance('A', '2026-09-30', 12)])
  const next = await loadAuthoritativePayrollRange(changed, period('2026-09-30'))
  assert.notDeepEqual(next.salesInputs, first.salesInputs)
  const extractor = fs.readFileSync(new URL('./payroll-audit-extract.mjs', import.meta.url), 'utf8')
  assert.match(extractor, /PayrollSalesInput: \{ count: authority.salesInputs.length, sha256: hash\(authority.salesInputs\) \}/)
})
