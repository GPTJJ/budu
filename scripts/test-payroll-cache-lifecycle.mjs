// P0：月度考勤内存缓存必须按账号代际隔离，并区分“权威空月”与“未加载”。
import assert from 'node:assert/strict'
import {
  STAFF_MONTH_LOAD_STATE,
  getDailyStoreStaff,
  getDailyStoreStaffMonthState,
  getUserData,
  loadDailyStoreStaffMonth,
  prepareUserDataForUser,
  resetUserData,
  seedCachedDataForTest,
} from '../src/utils/userData.js'

const originalFetch = globalThis.fetch
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
})
const rows = (count, prefix = 'row') => Array.from({ length: count }, (_, index) => ({
  id: `${prefix}-${index + 1}`,
  employeeId: `emp-${index + 1}`,
  date: '2026-08-01',
  actualHours: 8,
}))

let requestCount = 0
let loader = async () => ({ rows: rows(70) })
globalThis.fetch = async (input) => {
  assert.match(String(input), /\/api\/v2\/daily-store-staff\?month=/)
  requestCount += 1
  try {
    return jsonResponse(await loader())
  } catch (error) {
    return jsonResponse({ error: error.message }, 503)
  }
}

try {
  prepareUserDataForUser('normal-account')
  seedCachedDataForTest({ dailyStoreStaffByMonth: {} })
  await loadDailyStoreStaffMonth('2026-08')
  assert.equal(getDailyStoreStaff('2026-08').length, 70)
  assert.equal(getDailyStoreStaffMonthState('2026-08').status, STAFF_MONTH_LOAD_STATE.LOADED)
  assert.equal(requestCount, 1)
  console.log('  [normal] 70 行月份加载 PASS')

  resetUserData()
  prepareUserDataForUser('normal-account')
  seedCachedDataForTest({ dailyStoreStaffByMonth: {} })
  await loadDailyStoreStaffMonth('2026-08')
  assert.equal(requestCount, 2, 'reset 后同月份必须再次发起请求')
  assert.equal(getDailyStoreStaff('2026-08').length, 70)
  console.log('  [reset] 同账号同月份重新加载 PASS')

  prepareUserDataForUser('account-a')
  seedCachedDataForTest({ dailyStoreStaffByMonth: {} })
  await loadDailyStoreStaffMonth('2026-08')
  const beforeAccountB = requestCount
  prepareUserDataForUser('account-b')
  assert.equal(getDailyStoreStaff('2026-08').length, 0, '切换账号后不得闪现上一账号数据')
  seedCachedDataForTest({ dailyStoreStaffByMonth: {} })
  await loadDailyStoreStaffMonth('2026-08')
  assert.equal(requestCount, beforeAccountB + 1)
  console.log('  [account-switch] marker/payload 双隔离 PASS')

  prepareUserDataForUser('late-account-a')
  seedCachedDataForTest({ dailyStoreStaffByMonth: {} })
  let resolveLate
  loader = () => new Promise((resolve) => { resolveLate = resolve })
  const latePromise = loadDailyStoreStaffMonth('2026-08')
  await Promise.resolve()
  prepareUserDataForUser('late-account-b')
  seedCachedDataForTest({ dailyStoreStaffByMonth: {} })
  resolveLate({ rows: rows(1, 'stale-a') })
  const lateResult = await latePromise
  assert.equal(lateResult.status, 'ignored')
  assert.equal(getDailyStoreStaff('2026-08').length, 0)
  assert.equal(getDailyStoreStaffMonthState('2026-08').status, STAFF_MONTH_LOAD_STATE.NOT_LOADED)
  console.log('  [late-response] 旧账号迟到响应丢弃 PASS')

  loader = async () => ({ rows: [] })
  prepareUserDataForUser('empty-account')
  seedCachedDataForTest({ dailyStoreStaffByMonth: {} })
  const beforeEmpty = requestCount
  await loadDailyStoreStaffMonth('2026-06')
  await loadDailyStoreStaffMonth('2026-06')
  const emptyState = getDailyStoreStaffMonthState('2026-06')
  assert.equal(emptyState.status, STAFF_MONTH_LOAD_STATE.LOADED)
  assert.equal(emptyState.hasPayload, true)
  assert.deepEqual(emptyState.rows, [])
  assert.equal(requestCount, beforeEmpty + 1, '权威空月不得循环请求')
  console.log('  [empty] 权威空月与缺失缓存区分 PASS')

  loader = async () => ({ rows: rows(2, 'repair') })
  prepareUserDataForUser('corrupt-account')
  seedCachedDataForTest({ dailyStoreStaffByMonth: {} })
  await loadDailyStoreStaffMonth('2026-08')
  const beforeRepair = requestCount
  delete getUserData().dailyStoreStaffByMonth['2026-08']
  assert.equal(getDailyStoreStaffMonthState('2026-08').status, STAFF_MONTH_LOAD_STATE.NOT_LOADED)
  await loadDailyStoreStaffMonth('2026-08')
  assert.equal(requestCount, beforeRepair + 1)
  assert.equal(getDailyStoreStaff('2026-08').length, 2)
  console.log('  [corrupt] marker/payload 不一致自动重载 PASS')

  prepareUserDataForUser('same-account-race')
  seedCachedDataForTest({ dailyStoreStaffByMonth: {} })
  const raceResolvers = []
  loader = () => new Promise((resolve) => raceResolvers.push(resolve))
  const olderRequest = loadDailyStoreStaffMonth('2026-08')
  const newerRequest = loadDailyStoreStaffMonth('2026-08', { force: true })
  await Promise.resolve()
  raceResolvers[1]({ rows: rows(1, 'newer') })
  await newerRequest
  raceResolvers[0]({ rows: rows(1, 'older') })
  const olderResult = await olderRequest
  assert.equal(olderResult.status, 'ignored')
  assert.equal(getDailyStoreStaff('2026-08')[0].id, 'newer-1')
  console.log('  [same-account-race] 强制刷新后的旧响应丢弃 PASS')

  loader = async () => { throw new Error('month unavailable') }
  prepareUserDataForUser('error-account')
  seedCachedDataForTest({ dailyStoreStaffByMonth: {} })
  const failure = await loadDailyStoreStaffMonth('2026-08')
  const failureState = getDailyStoreStaffMonthState('2026-08')
  assert.equal(failure.status, STAFF_MONTH_LOAD_STATE.ERROR)
  assert.equal(failureState.status, STAFF_MONTH_LOAD_STATE.ERROR)
  assert.equal(failureState.hasPayload, false)
  assert.deepEqual(getDailyStoreStaff('2026-08'), [])
  console.log('  [error] 失败态无伪 payload PASS')

  console.log('P0 PAYROLL CACHE LIFECYCLE TEST OK')
} finally {
  globalThis.fetch = originalFetch
  resetUserData()
}
