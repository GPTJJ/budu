import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-notification-read-'))
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = await createDisposablePgSchema('notification_read')

const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema')
const { createApp } = await import('../server/app.js')
const { prisma } = await import('../server/pg.js')
const server = createApp().listen(0)

const json = async (response) => ({ status: response.status, body: await response.json() })

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const register = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'notification-reader', password: '123456' }),
  })
  if (!register.ok) throw new Error(`测试账号创建失败：${register.status}`)
  const cookie = register.headers.get('set-cookie')?.split(';')[0]
  const headers = { 'Content-Type': 'application/json', Cookie: cookie }
  const startedAt = new Date('2026-08-31T12:00:00.000Z')

  await prisma.notification.createMany({
    data: Array.from({ length: 7 }, (_, index) => ({
      id: `notification-${index + 1}`,
      username: 'notification-reader',
      title: `通知 ${index + 1}`,
      content: '未读状态同步测试',
      status: index < 4 ? 'unread' : 'read',
      readAt: index < 4 ? null : startedAt,
      createdAt: new Date(startedAt.getTime() + index * 1000),
    })),
  })
  await prisma.notificationDelivery.create({
    data: { id: 'delivery-authority-guard', notificationId: 'notification-1', channel: 'inapp', status: 'sent' },
  })
  const deliveryBefore = await prisma.notificationDelivery.findUnique({ where: { id: 'delivery-authority-guard' } })

  const initial = await json(await fetch(`${base}/v2/notifications?limit=50`, { headers }))
  if (initial.status !== 200 || initial.body.totalCount !== 7 || initial.body.unreadCount !== 4 || initial.body.rows.length !== 7) {
    throw new Error(`初始通知 projection 错误：${JSON.stringify(initial)}`)
  }

  const single = await json(await fetch(`${base}/v2/notifications/read`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ids: ['notification-1'] }),
  }))
  if (single.status !== 200 || single.body.updatedCount !== 1 || single.body.unreadCount !== 3 || single.body.totalCount !== 7) {
    throw new Error(`单条已读 projection 错误：${JSON.stringify(single)}`)
  }

  const through = new Date('2026-08-31T12:00:10.000Z')
  await prisma.notification.create({
    data: {
      id: 'notification-concurrent-new',
      username: 'notification-reader',
      title: '并发新通知',
      content: '必须保持未读',
      status: 'unread',
      createdAt: new Date('2026-08-31T12:00:11.000Z'),
    },
  })
  const all = await json(await fetch(`${base}/v2/notifications/read`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ all: true, through: through.toISOString() }),
  }))
  if (all.status !== 200 || all.body.updatedCount !== 3 || all.body.unreadCount !== 1 || all.body.totalCount !== 8) {
    throw new Error(`全部已读并发边界错误：${JSON.stringify(all)}`)
  }

  const reloaded = await json(await fetch(`${base}/v2/notifications?unread=1`, { headers }))
  if (reloaded.status !== 200 || reloaded.body.unreadCount !== 1 || reloaded.body.totalCount !== 8 || reloaded.body.rows.map((row) => row.id).join(',') !== 'notification-concurrent-new') {
    throw new Error(`刷新后 unread projection 未持久化：${JSON.stringify(reloaded)}`)
  }

  const invalid = await fetch(`${base}/v2/notifications/read`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ all: true, through: 'not-a-date' }),
  })
  if (invalid.status !== 400) throw new Error(`无效截止时间未 fail closed：${invalid.status}`)

  const deliveryAfter = await prisma.notificationDelivery.findUnique({ where: { id: 'delivery-authority-guard' } })
  if (JSON.stringify(deliveryAfter) !== JSON.stringify(deliveryBefore)) throw new Error('NotificationDelivery 被已读操作修改')
} finally {
  await new Promise((resolve) => server.close(resolve))
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log('NOTIFICATION READ AUTHORITY TEST OK')
