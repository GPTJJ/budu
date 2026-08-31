import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DAILY_SALES_AUTHORITIES,
  normalizeReportRange,
  resolveDailySalesAuthority,
} from '../server/report-center-query.js'

const store = (salesDataSource, effectiveDate = null) => ({
  salesDataSource,
  salesDataSourceEffectiveDate: effectiveDate ? new Date(`${effectiveDate}T00:00:00.000Z`) : null,
})

test('confirmed DailyEntry snapshot outranks current store configuration', () => {
  const manual = resolveDailySalesAuthority({
    store: store('pos', '2026-08-11'), date: '2026-08-10',
    entry: { status: 'confirmed', posSyncAt: null }, audits: [],
  })
  assert.equal(manual.authority, DAILY_SALES_AUTHORITIES.MANUAL)
  const pos = resolveDailySalesAuthority({
    store: store('manual'), date: '2026-08-12',
    entry: { status: 'confirmed', posSyncAt: new Date() }, audits: [],
  })
  assert.equal(pos.authority, DAILY_SALES_AUTHORITIES.POS)
})

test('source snapshot disagreement and hybrid source fail closed', () => {
  const mismatch = resolveDailySalesAuthority({
    store: store('pos'), date: '2026-08-12', entry: { status: 'confirmed', posSyncAt: null },
    audits: [{ afterValue: { salesAuthority: 'pos' } }],
  })
  assert.equal(mismatch.authority, DAILY_SALES_AUTHORITIES.CONFLICT)
  const hybrid = resolveDailySalesAuthority({ store: store('hybrid'), date: '2026-08-12', entry: null })
  assert.equal(hybrid.authority, DAILY_SALES_AUTHORITIES.CONFLICT)
})

test('unconfirmed days use effective-dated config without rewriting earlier dates', () => {
  const configured = store('pos', '2026-08-11')
  assert.equal(resolveDailySalesAuthority({ store: configured, date: '2026-08-10', entry: null }).authority, DAILY_SALES_AUTHORITIES.MANUAL)
  assert.equal(resolveDailySalesAuthority({ store: configured, date: '2026-08-11', entry: null }).authority, DAILY_SALES_AUTHORITIES.POS)
})

test('report range is inclusive and strictly bounded', () => {
  assert.deepEqual(normalizeReportRange({ from: '2026-08-30', to: '2026-08-31' }).days, ['2026-08-30', '2026-08-31'])
  assert.throws(() => normalizeReportRange({ from: '2026-09-01', to: '2026-08-31' }))
  assert.throws(() => normalizeReportRange({ from: '2026-01-01', to: '2026-08-31' }))
})
