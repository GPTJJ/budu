import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatReportBps,
  formatReportCents,
  formatReportInteger,
  reportDateRange,
  shareWidth,
} from '../src/utils/reportCenterUi.js'

test('RC-4 amount display remains BigInt-safe and missing facts remain missing', () => {
  assert.equal(formatReportCents('900719925474099312345'), '¥9,007,199,254,740,993,123.45')
  assert.equal(formatReportCents(null), '—')
  assert.equal(formatReportInteger('9007199254740993'), '9,007,199,254,740,993')
})

test('RC-4 percentage display distinguishes zero numerator from zero denominator', () => {
  assert.equal(formatReportBps('0'), '0.00%')
  assert.equal(formatReportBps(null), '—')
  assert.equal(shareWidth('1250'), 12.5)
  assert.equal(shareWidth(null), 0)
})

test('RC-4 date presets use the BUDU Shanghai business date', () => {
  const instant = new Date('2026-08-30T16:30:00.000Z')
  assert.deepEqual(reportDateRange('today', {}, instant), { from: '2026-08-31', to: '2026-08-31' })
  assert.deepEqual(reportDateRange('yesterday', {}, instant), { from: '2026-08-30', to: '2026-08-30' })
  assert.deepEqual(reportDateRange('week', {}, instant), { from: '2026-08-31', to: '2026-08-31' })
  assert.deepEqual(reportDateRange('month', {}, instant), { from: '2026-08-01', to: '2026-08-31' })
})
