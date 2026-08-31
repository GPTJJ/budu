import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildReportTrend,
  DAILY_SALES_AUTHORITIES,
  normalizeReportRange,
  resolveComparisonRange,
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

test('period comparison uses adjacent equal spans and natural month/year boundaries', () => {
  assert.deepEqual(resolveComparisonRange(normalizeReportRange({ from: '2026-08-10', to: '2026-08-16' }), 'previous'), {
    mode: 'previous', from: '2026-08-03', to: '2026-08-09',
  })
  assert.deepEqual(resolveComparisonRange(normalizeReportRange({ from: '2026-03-01', to: '2026-03-31' }), 'previous', 'month'), {
    mode: 'previous', from: '2026-02-01', to: '2026-02-28',
  })
  assert.deepEqual(resolveComparisonRange(normalizeReportRange({ from: '2024-02-29', to: '2024-02-29' }), 'year'), {
    mode: 'year', from: '2023-02-28', to: '2023-02-28',
  })
})

const trendSummary = (from, to, rows) => ({ range: { from, to }, daily: rows })
const trendRow = (date, revenueCents, orderCount, reasonCode = null) => ({
  storeKey: 'store-a', date, revenueCents, orderCount, reasonCode,
})

test('trend automatically uses daily, weekly and monthly points without inventing hourly data', () => {
  const day = buildReportTrend(trendSummary('2026-08-31', '2026-08-31', [trendRow('2026-08-31', '1000', '2')]))
  assert.equal(day.granularity, 'DAY')
  assert.equal(day.points.length, 1)
  assert.equal(day.points[0].revenueCents, '1000')
  const weeklyRows = normalizeReportRange({ from: '2026-07-01', to: '2026-08-10' }).days.map((date) => trendRow(date, '100', '1'))
  assert.equal(buildReportTrend(trendSummary('2026-07-01', '2026-08-10', weeklyRows)).granularity, 'WEEK')
  const monthlyRows = normalizeReportRange({ from: '2026-06-01', to: '2026-08-31' }).days.map((date) => trendRow(date, '100', '1'))
  assert.equal(buildReportTrend(trendSummary('2026-06-01', '2026-08-31', monthlyRows)).granularity, 'MONTH')
})

test('partial trend points preserve coverage instead of turning missing facts into zero', () => {
  const trend = buildReportTrend(trendSummary('2026-08-30', '2026-08-31', [
    trendRow('2026-08-30', '2000', '2'),
    { ...trendRow('2026-08-30', null, null, 'HISTORICAL_DATA_INCOMPLETE'), storeKey: 'store-b' },
    trendRow('2026-08-31', null, null, 'TODAY_PENDING_CLOSE'),
  ]))
  assert.equal(trend.points[0].coverage.state, 'PARTIAL')
  assert.equal(trend.points[0].revenueCents, '2000')
  assert.equal(trend.points[1].coverage.state, 'UNAVAILABLE')
  assert.equal(trend.points[1].revenueCents, null)
})
