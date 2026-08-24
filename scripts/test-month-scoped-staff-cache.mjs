// Gate 21：DailyStoreStaff 月键控缓存隔离
// A 8月仅存8月 / B 7月后8月保留 / C 回8月 / D 并发乱序 / E 同名保留 / F legacy NULL
// G 月过滤 / H 非法月 / I 失效只影响该月
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate21-cache-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'gate-21-test-secret-not-for-production'
delete process.env.DATA_STORE

const { createDisposablePgSchema } = await import('./helpers/test-pg-schema.mjs')
process.env.DATABASE_URL = await createDisposablePgSchema('gate21_cache')
const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema')
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

await prisma.store.createMany({ data: [{ key: 'guanshe', name: '北京官舍店' }] })
await prisma.employee.createMany({
  data: [
    { id: 'emp-A', employeeNo: 'BUDU-21-A', name: '张伟', currentStoreKey: 'guanshe', status: 'ACTIVE' },
    { id: 'emp-B', employeeNo: 'BUDU-21-B', name: '张伟', currentStoreKey: 'guanshe', status: 'ACTIVE' },
  ],
})
// 8 月行（含同名两人 + legacy NULL）；7 月行
await prisma.dailyStoreStaff.createMany({
  data: [
    { id: 'aug-a', storeId: 'guanshe', date: new Date('2026-08-01T00:00:00Z'), employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张伟', actualHours: 8 },
    { id: 'aug-b', storeId: 'guanshe', date: new Date('2026-08-01T00:00:00Z'), employeeId: 'emp-B', staffId: 'st-b', staffNameSnapshot: '张伟', actualHours: 8 },
    { id: 'aug-legacy', storeId: 'guanshe', date: new Date('2026-08-02T00:00:00Z'), employeeId: null, staffId: 'st-legacy', staffNameSnapshot: '王五', actualHours: 4 },
    { id: 'jul-x', storeId: 'guanshe', date: new Date('2026-07-15T00:00:00Z'), employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张伟', actualHours: 8 },
  ],
})

const { createApp } = await import('../server/app.js')
const server = createApp().listen(0)
const request = async (base, pathname, { cookie = '', method = 'GET' } = {}) =>
  fetch(`${base}${pathname}`, { method, headers: cookie ? { Cookie: cookie } : {} })

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const register = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'gate21-dev', password: '123456' }) })
  assert.equal(register.status, 200)
  const cookie = register.headers.get('set-cookie')?.split(';')[0] || ''
  assert.ok(cookie)

  const { seedCachedDataForTest, loadDailyStoreStaffMonth, getDailyStoreStaff, refreshDailyStoreStaffMonth, getUserData } = await import(path.join(root, 'src/utils/userData.js').replaceAll('\\', '/'))

  // 模拟前端：seed 空缓存，然后通过 API 加载
  seedCachedDataForTest({ entries: {}, staff: [], removedStaff: [], stores: [{ key: 'guanshe', name: '北京官舍店' }], schedules: {}, products: [], inventoryRequests: [], inventory: [], analysis: {}, productImages: {}, bigBonuses: [], dailyPayAdjustments: [], posDaily: [], posProductSales: [] })

  // 直接调用 load 需要 api() 打到测试 server——userData 的 api 用相对路径 /api，node 环境无 base。
  // 方案：手动构造缓存（模拟 load 结果）——但需要真实走 load 验证。改用 fetch mock。
  const { api } = await import(path.join(root, 'src/utils/api.js').replaceAll('\\', '/'))
  // 覆盖全局 fetch：把 /api/v2/daily-store-staff 指向测试 server
  const origFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const u = String(input)
    if (u.includes('/api/v2/daily-store-staff')) {
      const url = new URL(u, 'http://x')
      const month = url.searchParams.get('month')
      return origFetch(`${base}/v2/daily-store-staff?month=${month}`, { ...init, headers: { ...(init?.headers || {}), Cookie: cookie } })
    }
    return origFetch(input, init)
  }

  // A: 仅 8 月
  await loadDailyStoreStaffMonth('2026-08')
  let aug = getDailyStoreStaff('2026-08')
  assert.equal(aug.length, 3, 'A 8月 3 行')
  assert.equal(aug.every((r) => r.date.startsWith('2026-08')), true, 'A 全为 8 月')
  console.log('  [A] 8月仅8月 PASS')

  // B: 7 月后 8 月保留
  await loadDailyStoreStaffMonth('2026-07')
  const jul = getDailyStoreStaff('2026-07')
  assert.equal(jul.length, 1, 'B 7月 1 行')
  assert.equal(jul[0].date.startsWith('2026-07'), true)
  aug = getDailyStoreStaff('2026-08')
  assert.equal(aug.length, 3, 'B 8月仍 3 行（不被 7 月覆盖）')
  console.log('  [B] 7月后8月保留 PASS')

  // C: 回 8 月
  aug = getDailyStoreStaff('2026-08')
  assert.equal(aug.length, 3, 'C 回 8 月仍 3 行')
  assert.equal(aug.some((r) => r.id === 'aug-a'), true)
  console.log('  [C] 回8月 PASS')

  // D: 并发乱序——同时请求 8 月与 7 月（用 force 重新拉取模拟），最终键各自正确
  await Promise.all([loadDailyStoreStaffMonth('2026-08', { force: true }), loadDailyStoreStaffMonth('2026-07', { force: true })])
  assert.equal(getDailyStoreStaff('2026-08').length, 3, 'D 8月正确')
  assert.equal(getDailyStoreStaff('2026-07').length, 1, 'D 7月正确')
  console.log('  [D] 并发隔离 PASS')

  // E: 同名保留
  const augNames = getDailyStoreStaff('2026-08').filter((r) => r.date === '2026-08-01')
  assert.equal(augNames.length, 2, 'E 同名两行独立')
  assert.equal(augNames[0].employeeId !== augNames[1].employeeId, true)
  console.log('  [E] 同名保留 PASS')

  // F: legacy NULL
  const legacy = getDailyStoreStaff('2026-08').find((r) => r.id === 'aug-legacy')
  assert.equal(legacy.employeeId, null, 'F legacy NULL 原样')
  console.log('  [F] legacy NULL PASS')

  // G: 月过滤——7 月行绝不出现在 8 月 getter，反之亦然
  assert.equal(getDailyStoreStaff('2026-08').some((r) => r.date.startsWith('2026-07')), false, 'G 8月无7月行')
  assert.equal(getDailyStoreStaff('2026-07').some((r) => r.date.startsWith('2026-08')), false, 'G 7月无8月行')
  console.log('  [G] 月过滤 PASS')

  // H: 非法月——受控拒绝，不建缓存键
  await loadDailyStoreStaffMonth('2026-13')
  await loadDailyStoreStaffMonth('2026-8')
  await loadDailyStoreStaffMonth('foo')
  assert.equal(getDailyStoreStaff('2026-13').length, 0, 'H 非法月空')
  const keys = Object.keys(getUserData().dailyStoreStaffByMonth || {})
  console.log('  H keys:', JSON.stringify(keys))
  assert.equal(keys.some((k) => ['2026-13', '2026-8', 'foo'].includes(k)), false, 'H 无非法缓存键')
  console.log('  [H] 非法月 PASS')

  // I: 失效只影响该月——refresh 8 月后 7 月保留
  await refreshDailyStoreStaffMonth('2026-08')
  assert.equal(getDailyStoreStaff('2026-08').length, 3, 'I 8月刷新后 3 行')
  assert.equal(getDailyStoreStaff('2026-07').length, 1, 'I 7月不受影响')
  console.log('  [I] 失效隔离 PASS')

  globalThis.fetch = origFetch
  console.log('GATE 21 MONTH-SCOPED STAFF CACHE TEST OK')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
  if (schema) {
    const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL.replace(/schema=.*/, 'schema=public') } } })
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.$disconnect()
  }
}
