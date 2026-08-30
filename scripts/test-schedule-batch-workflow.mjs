import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-schedule-batch-'))
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = await createDisposablePgSchema('schedule_batch')

const { PrismaClient } = await import('@prisma/client')
const { replaceScheduleStoresAtomic, scheduleVersion } = await import('../server/schedule.js')
const { resolveTransferScheduledRecipients } = await import('../server/transfer-notification.js')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

const weekStart = '2026-08-24'
const monday = '2026-08-24'
const tuesday = '2026-08-25'
const employees = [
  { id: 'emp-a', employeeNo: 'BUDU-S001', name: '测试甲', currentStoreKey: 'tongying' },
  { id: 'emp-b', employeeNo: 'BUDU-S002', name: '测试乙', currentStoreKey: 'tongying' },
  { id: 'emp-c', employeeNo: 'BUDU-S003', name: '测试丙', currentStoreKey: 'guanshe' },
]

const readRows = (storeKey) => prisma.schedule.findMany({
  where: { weekStart, storeKey },
  orderBy: { date: 'asc' },
  select: { id: true, date: true, shifts: true, updatedAt: true },
})

try {
  await prisma.employee.createMany({ data: employees })
  await prisma.user.createMany({ data: employees.map((employee) => ({
    id: `user-${employee.id}`,
    username: `user-${employee.id}`,
    passwordHash: 'test-only',
    role: 'staff',
    employeeId: employee.id,
    status: 'active',
  })) })
  await prisma.wechatBinding.createMany({ data: employees.map((employee) => ({
    id: `binding-${employee.id}`,
    username: `user-${employee.id}`,
    channel: 'wecom',
    openId: `wecom-${employee.id}`,
  })) })
  await prisma.schedule.createMany({ data: [
    {
      id: 'schedule-modern', weekStart, storeKey: 'tongying', date: monday,
      shifts: [{ employeeId: 'emp-a', staff: '测试甲', time: '早班', note: '' }],
    },
    {
      id: 'schedule-legacy', weekStart, storeKey: 'guanshe', date: monday,
      shifts: [{ staff: '历史员工', time: '早班', note: '' }],
    },
  ] })

  const originalTongying = await readRows('tongying')
  const originalGuanshe = await readRows('guanshe')
  const first = await replaceScheduleStoresAtomic(prisma, {
    weekStart,
    stores: [
      {
        storeKey: 'tongying', version: scheduleVersion(originalTongying),
        days: { [monday]: [
          { employeeId: 'emp-a', staff: '测试甲', time: '晚班', note: '已编辑' },
          { employeeId: 'emp-b', staff: '测试乙', time: '通班', note: '' },
        ] },
      },
      {
        storeKey: 'guanshe', version: scheduleVersion(originalGuanshe),
        days: {
          [monday]: [{ staff: '历史员工', time: '早班', note: '' }],
          [tuesday]: [{ employeeId: 'emp-c', staff: '测试丙', time: '晚班', note: '' }],
        },
      },
    ],
  })
  assert.equal(first.rows.length, 3, '两个门店应在一个批次内保存三个日期行')
  assert.deepEqual((await readRows('tongying'))[0].shifts.map((row) => row.employeeId), ['emp-a', 'emp-b'])
  assert.equal((await readRows('guanshe'))[0].shifts[0].employeeId, undefined, '未修改 legacy 行必须原样兼容')

  const freshTongying = await readRows('tongying')
  const freshGuanshe = await readRows('guanshe')
  const staleTongyingVersion = scheduleVersion(freshTongying)
  await prisma.schedule.update({
    where: { id: freshTongying[0].id },
    data: { shifts: [{ employeeId: 'emp-a', staff: '测试甲', time: '通班', note: '并发更新' }] },
  })
  const guansheBeforeConflict = JSON.stringify(await readRows('guanshe'))
  await assert.rejects(
    replaceScheduleStoresAtomic(prisma, {
      weekStart,
      stores: [
        { storeKey: 'guanshe', version: scheduleVersion(freshGuanshe), days: {} },
        { storeKey: 'tongying', version: staleTongyingVersion, days: {} },
      ],
    }),
    (error) => error.status === 409 && /其他管理员/.test(error.message),
  )
  assert.equal(JSON.stringify(await readRows('guanshe')), guansheBeforeConflict, '任一门店冲突时整个批次不得产生部分写入')

  const beforeInvalid = JSON.stringify(await readRows('tongying'))
  await assert.rejects(
    replaceScheduleStoresAtomic(prisma, {
      weekStart,
      stores: [{
        storeKey: 'tongying', version: scheduleVersion(await readRows('tongying')),
        days: { [monday]: [{ employeeId: 'missing', staff: '不存在', time: '早班', note: '' }] },
      }],
    }),
    (error) => error.status === 409 && /不存在或已离职/.test(error.message),
  )
  assert.equal(JSON.stringify(await readRows('tongying')), beforeInvalid, '员工校验失败不得改写排班')

  const beforeResolver = await resolveTransferScheduledRecipients({
    prismaClient: prisma,
    storeKey: 'tongying',
    businessDate: monday,
    personalConfig: { channel: 'wecom' },
  })
  assert.deepEqual(beforeResolver.scheduledEmployeeIds, ['emp-a'])

  const currentTongying = await readRows('tongying')
  await replaceScheduleStoresAtomic(prisma, {
    weekStart,
    stores: [{
      storeKey: 'tongying', version: scheduleVersion(currentTongying),
      days: { [monday]: [
        { employeeId: 'emp-a', staff: '测试甲', time: '早班', note: '' },
        { employeeId: 'emp-c', staff: '测试丙', time: '晚班', note: '' },
      ] },
    }],
  })
  const afterResolver = await resolveTransferScheduledRecipients({
    prismaClient: prisma,
    storeKey: 'tongying',
    businessDate: monday,
    personalConfig: { channel: 'wecom' },
  })
  assert.deepEqual(afterResolver.scheduledEmployeeIds, ['emp-a', 'emp-c'], '调拨 resolver 必须读取最终保存后的最新 PG 排班')

  console.log('SCHEDULE BATCH WORKFLOW TEST OK')
} finally {
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
