import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-safe-delete-'))
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = await createDisposablePgSchema('developer_safe_delete')
const { createApp } = await import('../server/app.js')
const { prisma } = await import('../server/pg.js')
const { hashPassword } = await import('../server/auth.js')
const server = createApp().listen(0)
const ids = { mailing: 'safe-mailing', invoice: 'safe-invoice', transfer: 'safe-transfer', purchase: 'safe-purchase', partnerSupply: 'safe-partner-order' }

const request = (base, cookie, endpoint, options = {}) => fetch(`${base}${endpoint}`, { ...options, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(options.headers || {}) } })

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const registered = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'safe-developer', password: 'login-secret' }) })
  if (!registered.ok) throw new Error(`developer registration failed: ${registered.status}`)
  const developer = (await registered.json()).user
  const developerCookie = registered.headers.get('set-cookie')?.split(';')[0]
  const secondPassword = await request(base, developerCookie, '/auth/second-password', { method: 'PUT', body: JSON.stringify({ oldPassword: 'login-secret', newSecondPassword: 'delete-secret' }) })
  if (!secondPassword.ok) throw new Error(`second password setup failed: ${await secondPassword.text()}`)

  await prisma.user.create({ data: { id: 'safe-admin', username: 'safe-admin', passwordHash: hashPassword('admin-secret'), role: 'admin', storeKeys: [], permissions: {} } })
  const adminLogin = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'safe-admin', password: 'admin-secret' }) })
  const adminCookie = adminLogin.headers.get('set-cookie')?.split(';')[0]

  await prisma.store.createMany({ data: [{ key: 'guanshe', name: '官舍店' }, { key: 'xidan', name: '西单店' }] })
  await prisma.inventoryItem.create({ data: { id: 'safe-product', name: '安全删除测试商品', category: 'product', transferEnabled: true } })
  await prisma.mailingRecord.create({ data: { id: ids.mailing, method: '顺丰邮寄', postage: '包邮', address: '测试地址', recipient: '测试顾客', phone: '13800000000', status: 'shipped', createdBy: developer.username, shippedAt: new Date() } })
  await prisma.invoice.create({ data: { id: ids.invoice, storeKey: 'guanshe', companyName: '测试企业', amountCents: 12300n, status: 'done', createdBy: developer.username } })
  await prisma.transferRequest.create({ data: { id: ids.transfer, fromStoreKey: 'guanshe', toStoreKey: 'xidan', status: 'shipped', createdBy: developer.username, shippedAt: new Date(), items: { create: { id: 'safe-transfer-item', itemId: 'safe-product', quantity: 2, itemNameSnapshot: '安全删除测试商品' } } } })
  await prisma.purchaseRequest.create({ data: { id: ids.purchase, storeKey: 'guanshe', status: 'received', createdBy: developer.username, items: { create: { id: 'safe-purchase-item', itemId: 'safe-product', orderedQty: 3, receivedQty: 3, itemNameSnapshot: '安全删除测试商品' } } } })
  await prisma.partner.create({ data: { id: 'safe-partner', name: '安全删除测试合作商', defaultStoreKey: 'guanshe' } })
  await prisma.partnerSupplyOrder.create({ data: { id: ids.partnerSupply, orderNo: 'PS-SAFE-1', partnerId: 'safe-partner', partnerNameSnapshot: '安全删除测试合作商', fromStoreKey: 'guanshe', fromStoreNameSnapshot: '官舍店', businessDate: new Date('2026-08-29T00:00:00.000Z'), status: 'shipped', defaultDiscountBpsSnapshot: 6500, effectiveDiscountBps: 6500, totalAmountCents: 6500n, createdById: developer.id, createdBy: developer.username, shippedAt: new Date(), items: { create: { id: 'safe-partner-item', productId: 'safe-product', productCodeSnapshot: 'SAFE', productNameSnapshot: '安全删除测试商品', retailPriceCentsSnapshot: 10000n, discountBpsSnapshot: 6500, partnerUnitPriceCents: 6500n, quantity: 1, subtotalCents: 6500n } }, receipts: { create: { id: 'safe-receipt', amountCents: 6500n, receivedDate: new Date('2026-08-29T00:00:00.000Z'), createdById: developer.id, createdBy: developer.username } } } })
  await prisma.notification.createMany({ data: [
    ['mailing', ids.mailing, 'store-mailing'], ['invoice', ids.invoice, 'finance-invoice'],
    ['transfer', ids.transfer, 'inventory-transfer'], ['purchase', ids.purchase, 'inventory-purchase'],
    ['partner-supply-order', ids.partnerSupply, 'partner-supply'],
  ].map(([refType, refId, target], index) => ({ id: `safe-notification-${index}`, username: developer.username, title: '安全删除测试通知', content: '测试', refType, refId, target })) })

  const forbidden = await request(base, adminCookie, `/v2/developer-sensitive-records/invoice/${ids.invoice}/delete`, { method: 'POST', body: JSON.stringify({ reasonCode: 'test', secondPassword: 'anything' }) })
  if (forbidden.status !== 403) throw new Error('admin received developer sensitive delete permission')

  const wrong = await request(base, developerCookie, `/v2/developer-sensitive-records/invoice/${ids.invoice}/delete`, { method: 'POST', body: JSON.stringify({ reasonCode: 'test', secondPassword: 'wrong-secret' }) })
  if (wrong.status !== 401) throw new Error('wrong secondary password was accepted')
  for (const [type, id] of Object.entries(ids)) {
    const response = await request(base, developerCookie, `/v2/developer-sensitive-records/${type}/${id}/delete`, { method: 'POST', body: JSON.stringify({ reasonCode: 'input_error', secondPassword: 'delete-secret' }) })
    if (!response.ok) throw new Error(`${type} delete failed: ${response.status} ${await response.text()}`)
  }

  const [mailingRows, invoiceRows, transferRows, purchaseRows, partnerRows, report] = await Promise.all([
    request(base, developerCookie, '/v2/mailing-records').then((res) => res.json()),
    request(base, developerCookie, '/v2/invoices').then((res) => res.json()),
    request(base, developerCookie, '/v2/transfer-requests').then((res) => res.json()),
    request(base, developerCookie, '/v2/purchase-requests').then((res) => res.json()),
    request(base, developerCookie, '/v2/partner-supply-orders').then((res) => res.json()),
    request(base, developerCookie, '/v2/partner-supply-report').then((res) => res.json()),
  ])
  if ([mailingRows, invoiceRows, transferRows, purchaseRows, partnerRows].some((result) => result.rows?.length)) throw new Error('deleted record remained in a normal list')
  if (report.orders?.length || report.receipts?.length || report.summary?.length) throw new Error('deleted partner order remained in reports/statistics')
  const [notifications, unread] = await Promise.all([
    request(base, developerCookie, '/v2/notifications').then((res) => res.json()),
    request(base, developerCookie, '/v2/notifications/unread-count').then((res) => res.json()),
  ])
  if (notifications.rows?.length || unread.count !== 0) throw new Error('deleted business records remained in normal notifications or unread counts')

  const childCounts = await Promise.all([prisma.transferItem.count(), prisma.purchaseItem.count(), prisma.partnerSupplyItem.count(), prisma.partnerReceipt.count()])
  if (childCounts.some((count) => count !== 1)) throw new Error(`child records changed: ${childCounts.join(',')}`)
  const blockedReceiptMutation = await request(base, developerCookie, '/v2/partner-receipts/safe-receipt/void', { method: 'POST', body: JSON.stringify({ reason: 'must be blocked' }) })
  if (blockedReceiptMutation.status !== 409) throw new Error('deleted partner order still allowed child mutation')

  const deleted = await request(base, developerCookie, '/v2/developer-sensitive-records').then((res) => res.json())
  if (deleted.rows?.length !== 5 || !Object.values(ids).every((id) => deleted.rows.some((row) => row.id === id))) throw new Error('deleted records center did not return all five domains')
  for (const [type, id] of Object.entries(ids)) {
    const detail = await request(base, developerCookie, `/v2/developer-sensitive-records/${type}/${id}`).then((res) => res.json())
    if (detail.record.id !== id || detail.audits.length !== 1 || JSON.stringify(detail).includes('delete-secret')) throw new Error(`${type} detail/audit is invalid or leaked a password`)
    const restored = await request(base, developerCookie, `/v2/developer-sensitive-records/${type}/${id}/restore`, { method: 'POST', body: JSON.stringify({ secondPassword: 'delete-secret' }) })
    if (!restored.ok || (await restored.json()).id !== id) throw new Error(`${type} restore failed or changed original ID`)
  }

  const [activeRows, audits] = await Promise.all([
    Promise.all(Object.entries({ mailingRecord: ids.mailing, invoice: ids.invoice, transferRequest: ids.transfer, purchaseRequest: ids.purchase, partnerSupplyOrder: ids.partnerSupply }).map(([delegate, id]) => prisma[delegate].findUnique({ where: { id } }))),
    prisma.sensitiveRecordAudit.findMany(),
  ])
  if (activeRows.some((row) => row.deletedAt || row.deletedBy || row.deleteReason)) throw new Error('restore did not reactivate original records cleanly')
  if (audits.length !== 10 || audits.filter((row) => row.action === 'DELETE').length !== 5 || audits.filter((row) => row.action === 'RESTORE').length !== 5) throw new Error('delete/restore audit chain is incomplete')
  if (audits.some((row) => JSON.stringify(row).includes('delete-secret'))) throw new Error('audit leaked secondary password')
  const wrongStatuses = []
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await request(base, developerCookie, `/v2/developer-sensitive-records/invoice/${ids.invoice}/delete`, { method: 'POST', body: JSON.stringify({ reasonCode: 'test', secondPassword: 'always-wrong' }) })
    wrongStatuses.push(response.status)
  }
  if (wrongStatuses.join(',') !== '401,401,401,401,429') throw new Error(`secondary password rate limit failed: ${wrongStatuses.join(',')}`)
  const lockedCorrectAttempt = await request(base, developerCookie, `/v2/developer-sensitive-records/invoice/${ids.invoice}/delete`, { method: 'POST', body: JSON.stringify({ reasonCode: 'test', secondPassword: 'delete-secret' }) })
  if (lockedCorrectAttempt.status !== 429) throw new Error('rate-limited secondary password could bypass lock with a correct password')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log('DEVELOPER SAFE DELETE WORKFLOW TEST OK')
