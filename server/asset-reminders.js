import crypto from 'node:crypto'
import { prisma, dbReady } from './pg.js'
import { broadcast } from './notification-center.js'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 每日检查企业证照到期：30 / 15 / 7 天与已过期，写入提醒表；
 * 已预留企业微信（配置 Webhook 即发送）与邮件通知接口（后续接入）。
 */
export async function checkAssetReminders() {
  if (!dbReady()) return { checked: false, reason: 'no-db' }
  const now = new Date()
  const files = await prisma.assetFile.findMany({
    where: { deletedAt: null, category: 'license', isPermanent: false, expiryDate: { not: null } },
  })
  const reminders = []
  for (const file of files) {
    const daysLeft = Math.ceil((new Date(file.expiryDate).getTime() - now.getTime()) / DAY_MS)
    const type = daysLeft < 0 ? 'expired' : daysLeft <= 7 ? '7' : daysLeft <= 15 ? '15' : daysLeft <= 30 ? '30' : null
    if (!type) continue
    reminders.push({ file, daysLeft, type })
  }
  let createdCount = 0
  const digest = []
  for (const item of reminders) {
    const existing = await prisma.assetReminder.findUnique({
      where: { fileId_remindType: { fileId: item.file.id, remindType: item.type } },
    })
    if (existing) {
      if (existing.daysLeft !== item.daysLeft) {
        await prisma.assetReminder.update({ where: { id: existing.id }, data: { daysLeft: item.daysLeft } })
      }
      continue
    }
    await prisma.assetReminder.create({
      data: {
        id: `rem-${crypto.randomUUID()}`,
        fileId: item.file.id,
        fileName: item.file.name,
        storeKey: item.file.storeKey,
        remindType: item.type,
        daysLeft: item.daysLeft,
      },
    })
    createdCount += 1
    digest.push(`${item.file.name}（${item.type === 'expired' ? '已过期' : `${item.daysLeft} 天到期`}）`)
  }
  if (digest.length > 0) {
    const lines = [`BUDU 资产到期提醒（${new Date().toISOString().slice(0, 10)}）`, ...digest]
    broadcast('企业资产到期提醒', lines.join('\n')).catch(() => {})
    if (process.env.EMAIL_NOTIFY_ENABLED === '1') {
      console.info('[asset-reminder-email] 预留邮件接口，尚未配置 SMTP')
    }
  }
  return { checked: true, created: createdCount, total: reminders.length }
}

export function startAssetReminderJob() {
  const run = () => checkAssetReminders().catch((error) => console.error('[asset-reminder]', error.message))
  run()
  const timer = setInterval(run, 6 * 60 * 60 * 1000)
  if (typeof timer.unref === 'function') timer.unref()
}
