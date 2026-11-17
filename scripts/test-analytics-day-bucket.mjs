import test from 'node:test'
import assert from 'node:assert/strict'
import { shanghaiDayKey } from '../server/online-catalog.js'

// 每日趋势的分桶必须按门店所在时区（东八区）取自然日。
// 原实现用 toISOString()（UTC），凌晨 00:00–07:59 的订单会被算到前一天。
test('analytics day bucket: 按东八区取自然日', () => {
  assert.equal(shanghaiDayKey('2026-11-17T00:30:00+08:00'), '2026-11-17')
  assert.equal(shanghaiDayKey('2026-11-16T23:59:59+08:00'), '2026-11-16')
  assert.equal(shanghaiDayKey('2026-11-16T16:30:00Z'), '2026-11-17', 'UTC 16:30 = 北京次日 00:30')
  assert.equal(shanghaiDayKey(new Date('2026-11-17T03:26:29Z')), '2026-11-17')
  assert.equal(shanghaiDayKey('not-a-date'), '')
})
