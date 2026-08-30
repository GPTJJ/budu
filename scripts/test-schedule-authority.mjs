// BUDU Data Authority 1.0 — DA-3 Schedule Authority Tests
// 冻结：Schedule 读/写权威 = PostgreSQL；前端不得再读/写 KV schedules。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const page = fs.readFileSync(path.join(root, 'src/components/SchedulePage.jsx'), 'utf8')
const schedServer = fs.readFileSync(path.join(root, 'server/schedule.js'), 'utf8')
const userData = fs.readFileSync(path.join(root, 'src/utils/userData.js'), 'utf8')

test('DA-3: SchedulePage 不再读取/写入 KV schedules', () => {
  assert.ok(!page.includes('getSchedules('), 'SchedulePage 不得调用 getSchedules（KV 读）')
  assert.ok(!page.includes('commitSchedules('), 'SchedulePage 不得调用 commitSchedules（KV 写）')
  assert.ok(page.includes('/v2/schedules'), 'SchedulePage 使用 PG 接口')
  assert.ok(page.includes('/v2/schedules/batch'), 'SchedulePage 最终保存使用 PG 批量接口')
  assert.ok(page.includes('setSchedules'), 'SchedulePage 以 PG 数据为状态')
})

test('DA-3: 服务端排班路由为纯 PG 实现', () => {
  assert.ok(schedServer.includes('prisma.schedule.'), '服务端使用 prisma.schedule')
  assert.ok(!schedServer.includes('loadDb('), '服务端排班路由不得读取 KV')
  assert.ok(!schedServer.includes("from './store.js'"), '服务端排班路由不得引用 KV 存储层')
  assert.ok(schedServer.includes("scheduleRouter.get('/schedules'") && schedServer.includes("scheduleRouter.put('/schedules/batch'"), 'GET/批量 PUT 路由存在')
  assert.ok(schedServer.includes('return prismaClient.$transaction(async (tx)'), '批量排班保存使用单一数据库 transaction')
  assert.ok(schedServer.includes('pg_advisory_xact_lock'), '同门店周版本比较与写入受事务锁保护')
})

test('DA-3: KV getSchedules/commitSchedules 在运行时无调用方（仅存档定义）', () => {
  // SchedulePage 已无调用；确认全 src 无其它调用方
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const st = fs.statSync(full)
      if (st.isDirectory()) walk(full)
      else if (/\.(js|jsx)$/.test(name)) {
        const src = fs.readFileSync(full, 'utf8')
        const lines = src.split('\n')
        lines.forEach((line, i) => {
          if (/getSchedules\(|commitSchedules\(/.test(line) && !line.includes('export function')) {
            assert.fail(`${full}:${i + 1} -> ${line.trim()}`)
          }
        })
      }
    }
  }
  walk(path.join(root, 'src'))
  assert.ok(true, '无其它调用方')
})

test('DA-3: 新排班写入以 Employee.id 为身份键，legacy name-only fail closed', async () => {
  const { normalizeShifts } = await import('../server/schedule.js')
  assert.throws(() => normalizeShifts([{ staff: '同名员工', time: '早班' }]), /稳定员工 ID/)
  assert.throws(() => normalizeShifts([
    { employeeId: 'emp-1', staff: '员工甲', time: '早班' },
    { employeeId: 'emp-1', staff: '员工甲', time: '晚班' },
  ]), /重复排班/)
  assert.deepEqual(normalizeShifts([
    { employeeId: 'emp-1', staff: '同名员工', time: '早班' },
    { employeeId: 'emp-2', staff: '同名员工', time: '晚班' },
  ]).map((row) => row.employeeId), ['emp-1', 'emp-2'])
  assert.deepEqual(normalizeShifts(
    [{ staff: '历史员工', time: '早班', note: '' }],
    { allowedLegacy: [{ staff: '历史员工', time: '早班', note: '' }] },
  ), [{ staff: '历史员工', time: '早班', note: '' }])
  assert.throws(() => normalizeShifts(
    [{ staff: '历史员工', time: '晚班', note: '' }],
    { allowedLegacy: [{ staff: '历史员工', time: '早班', note: '' }] },
  ), /稳定员工 ID/)
})

test('DA-3: 批量保存任一校验失败时零部分写入，陈旧 version 明确冲突', async () => {
  const { replaceScheduleStoresAtomic, scheduleVersion } = await import('../server/schedule.js')
  let rows = [
    { id: 's-a', weekStart: '2026-08-24', storeKey: 'store-a', date: '2026-08-24', shifts: [{ employeeId: 'emp-a', staff: '员工甲', time: '早班', note: '' }], updatedAt: new Date('2026-08-24T00:00:00Z') },
    { id: 's-b', weekStart: '2026-08-24', storeKey: 'store-b', date: '2026-08-24', shifts: [{ employeeId: 'emp-b', staff: '员工乙', time: '早班', note: '' }], updatedAt: new Date('2026-08-24T00:00:00Z') },
  ]
  const validEmployeeIds = new Set(['emp-a', 'emp-b', 'emp-c'])
  const rowsFor = (storeKey) => rows.filter((row) => row.storeKey === storeKey)
  const prismaFake = {
    async $transaction(work) {
      const working = structuredClone(rows)
      const schedule = {
        async findMany({ where }) {
          const storeKeys = typeof where.storeKey === 'object' ? where.storeKey.in : [where.storeKey]
          return working
            .filter((row) => row.weekStart === where.weekStart && storeKeys.includes(row.storeKey))
            .sort((left, right) => left.storeKey.localeCompare(right.storeKey) || left.date.localeCompare(right.date))
        },
        async deleteMany({ where }) {
          for (let index = working.length - 1; index >= 0; index -= 1) {
            if (working[index].weekStart === where.weekStart && working[index].storeKey === where.storeKey) working.splice(index, 1)
          }
        },
        async create({ data }) {
          working.push({ ...structuredClone(data), createdAt: new Date(), updatedAt: data.updatedAt || new Date() })
        },
      }
      const tx = {
        schedule,
        employee: {
          async findMany({ where }) {
            return where.id.in.filter((id) => validEmployeeIds.has(id)).map((id) => ({ id }))
          },
        },
        async $queryRawUnsafe() {},
      }
      const result = await work(tx)
      rows = working
      return result
    },
  }

  const versions = {
    'store-a': scheduleVersion(rowsFor('store-a')),
    'store-b': scheduleVersion(rowsFor('store-b')),
  }
  const beforeInvalid = JSON.stringify(rows)
  await assert.rejects(replaceScheduleStoresAtomic(prismaFake, {
    weekStart: '2026-08-24',
    stores: [
      { storeKey: 'store-a', version: versions['store-a'], days: {} },
      { storeKey: 'store-b', version: versions['store-b'], days: { '2026-08-25': [{ employeeId: 'missing', staff: '不存在', time: '晚班' }] } },
    ],
  }), /不存在或已离职/)
  assert.equal(JSON.stringify(rows), beforeInvalid, '第二门店失败时第一门店不得被部分清空')

  await replaceScheduleStoresAtomic(prismaFake, {
    weekStart: '2026-08-24',
    stores: [
      { storeKey: 'store-a', version: versions['store-a'], days: { '2026-08-24': [{ employeeId: 'emp-a', staff: '员工甲', time: '晚班' }] } },
      { storeKey: 'store-b', version: versions['store-b'], days: { '2026-08-25': [{ employeeId: 'emp-c', staff: '员工丙', time: '通班' }] } },
    ],
  })
  assert.equal(rowsFor('store-a')[0].shifts[0].time, '晚班')
  assert.equal(rowsFor('store-b')[0].shifts[0].employeeId, 'emp-c')

  const staleVersion = scheduleVersion(rowsFor('store-a'))
  rowsFor('store-a')[0].updatedAt = new Date('2026-08-30T12:00:00Z')
  rowsFor('store-a')[0].shifts = [{ employeeId: 'emp-a', staff: '员工甲', time: '通班' }]
  await assert.rejects(replaceScheduleStoresAtomic(prismaFake, {
    weekStart: '2026-08-24',
    stores: [{ storeKey: 'store-a', version: staleVersion, days: {} }],
  }), (error) => error.status === 409 && /其他管理员/.test(error.message))
  assert.equal(rowsFor('store-a')[0].shifts[0].time, '通班', '并发更新不得被陈旧 draft 覆盖')
})
