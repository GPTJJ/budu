import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-partner-gate2-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'partner-gate-2-http-secret-only'
process.env.DATABASE_URL = process.env.PARTNER_GATE2_SCHEMA_READY === 'true'
  ? process.env.TEST_DATABASE_URL
  : await createDisposablePgSchema('partner_gate2')
if (!process.env.DATABASE_URL) throw new Error('PARTNER_GATE2_HTTP_NOT_RUN — 缺少 TEST_DATABASE_URL')

const { PrismaClient } = await import('@prisma/client')
const { hashPassword } = await import('../server/auth.js')
const { createCustomerSession, authenticateCustomerSession } = await import('../server/customer-auth.js')
const { createApp } = await import('../server/app.js')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
const suffix = crypto.randomUUID().slice(0, 8)

const usernames = {
  developer: `gate2_dev_${suffix}`,
  admin: `gate2_admin_${suffix}`,
  staff: `gate2_staff_${suffix}`,
  customer: `gate2_customer_${suffix}`,
}
const userIds = Object.fromEntries(Object.keys(usernames).map((key) => [key, `gate2-${key}-${suffix}`]))
const storeKey = 'guanshe' // Canonical fixed store key also accepted by the legacy compatibility API.

await prisma.store.create({ data: { key: storeKey, name: 'Gate 2 发货店' } })
await prisma.user.createMany({ data: [
  { id: userIds.developer, username: usernames.developer, passwordHash: hashPassword('123456'), role: 'developer', status: 'active', storeKeys: [], permissions: {} },
  { id: userIds.admin, username: usernames.admin, passwordHash: hashPassword('123456'), role: 'admin', status: 'active', storeKeys: [], permissions: {} },
  { id: userIds.staff, username: usernames.staff, passwordHash: hashPassword('123456'), role: 'staff', status: 'active', storeKeys: [storeKey], permissions: {} },
  { id: userIds.customer, username: usernames.customer, passwordHash: hashPassword('123456'), role: 'customer', status: 'active', storeKeys: [], permissions: {} },
] })
await prisma.partner.create({ data: {
  id: `qinhuangdao-${suffix}`, name: `秦皇岛-${suffix}`, companyName: '秦皇岛兼容主体', contactName: '兼容联系人', contactPhone: '13800138009',
  status: 'ACTIVE', defaultStoreKey: storeKey, defaultDiscountBps: 6500, isActive: true,
} })

const app = createApp({ partnerDomainMirrorUsers: async () => {} })
const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const request = (pathname, { cookie = '', method = 'GET', body } = {}) => fetch(`${origin}${pathname}`, {
  method,
  headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
})
const login = async (username) => {
  const response = await request('/api/auth/login', { method: 'POST', body: { username, password: '123456' } })
  assert.equal(response.status, 200)
  return response.headers.get('set-cookie').split(';')[0]
}
const partnerPayload = (tag, username) => ({
  name: `Gate 2 Partner ${tag} ${suffix}`,
  companyName: `Gate 2 Company ${tag}`,
  contactName: `联系人 ${tag}`,
  contactPhone: '13800138000',
  cooperationStartDate: '2026-09-06',
  defaultDiscountBps: 6500,
  defaultStoreKey: storeKey,
  invoiceTitle: `Gate 2 Company ${tag}`,
  taxpayerId: `TAX-${tag}-${suffix}`,
  contractReference: `ARCHIVE-${tag}`,
  internalNote: `INTERNAL-ONLY-${tag}`,
  store: { name: `${tag} 一号店`, contactName: `店长 ${tag}`, phone: '13800138001', province: '北京市', city: '北京市', district: '西城区', addressLine: `${tag} 测试路1号`, status: 'ACTIVE' },
  account: { username, password: '123456' },
})

try {
  const developerCookie = await login(usernames.developer)
  const adminCookie = await login(usernames.admin)
  const staffCookie = await login(usernames.staff)

  const createA = await request('/api/v2/partner-management/partners', { cookie: developerCookie, method: 'POST', body: partnerPayload('A', `partner_a_${suffix}`) })
  assert.equal(createA.status, 201)
  let partnerA = (await createA.json()).partner
  assert.equal(partnerA.stores.length, 1)
  assert.equal(partnerA.users.length, 1)
  assert.equal(partnerA.audits.length, 3)

  const createB = await request('/api/v2/partner-management/partners', { cookie: adminCookie, method: 'POST', body: partnerPayload('B', `partner_b_${suffix}`) })
  assert.equal(createB.status, 201)
  const partnerB = (await createB.json()).partner
  assert.equal((await request('/api/v2/partner-management/partners', { cookie: staffCookie, method: 'POST', body: partnerPayload('C', `partner_c_${suffix}`) })).status, 403)

  const partnerLogin = await request('/api/partner/auth/login', { method: 'POST', body: { username: `partner_a_${suffix}`, password: '123456' } })
  assert.equal(partnerLogin.status, 200)
  let partnerCookie = partnerLogin.headers.get('set-cookie').split(';')[0]
  assert.equal((await request('/api/v2/partner-management/partners', { cookie: partnerCookie })).status, 401)

  const profileResponse = await request('/api/partner/profile', { cookie: partnerCookie })
  assert.equal(profileResponse.status, 200)
  const profileJson = await profileResponse.json()
  assert.equal(profileJson.partner.id, partnerA.id)
  assert.equal(profileJson.partner.defaultDiscountBps, 6500)
  assert.doesNotMatch(JSON.stringify(profileJson), /INTERNAL-ONLY|passwordHash|permissions|employeeId/)
  assert.equal((await request(`/api/partner/profile?partnerId=${partnerB.id}`, { cookie: partnerCookie })).status, 400)

  const secondStore = { name: 'A 二号店', contactName: '二店店长', phone: '13800138002', province: '河北省', city: '秦皇岛市', district: '海港区', addressLine: 'Gate 2 路2号', status: 'ACTIVE' }
  const addStore = await request(`/api/v2/partner-management/partners/${partnerA.id}/stores`, { cookie: developerCookie, method: 'POST', body: secondStore })
  assert.equal(addStore.status, 201)
  assert.equal((await request('/api/partner/stores', { cookie: partnerCookie }).then((response) => response.json())).rows.length, 2)
  assert.equal((await request(`/api/partner/stores/${partnerB.stores[0].id}`, { cookie: partnerCookie })).status, 404)

  assert.equal((await request(`/api/v2/partner-management/partners/${partnerA.id}/users`, { cookie: developerCookie, method: 'POST', body: { username: `partner_a2_${suffix}`, password: '123456' } })).status, 409)
  const firstBinding = partnerA.users[0]
  assert.equal((await request(`/api/v2/partner-management/partners/${partnerA.id}/users/${firstBinding.id}/status`, { cookie: developerCookie, method: 'PUT', body: { status: 'disabled' } })).status, 200)
  assert.equal((await request('/api/partner/profile', { cookie: partnerCookie })).status, 401)
  assert.equal((await request(`/api/v2/partner-management/partners/${partnerA.id}/users`, { cookie: developerCookie, method: 'POST', body: { username: `partner_a2_${suffix}`, password: '123456' } })).status, 201)
  assert.equal(await prisma.partnerUser.count({ where: { partnerId: partnerA.id } }), 2)
  assert.equal(await prisma.partnerUser.count({ where: { partnerId: partnerA.id, status: 'active' } }), 1)

  const countsBeforeFailure = {
    partners: await prisma.partner.count(), stores: await prisma.partnerStore.count(), users: await prisma.user.count(), bindings: await prisma.partnerUser.count(),
  }
  const duplicateUserPayload = partnerPayload('DUP-USER', `partner_b_${suffix}`)
  assert.equal((await request('/api/v2/partner-management/partners', { cookie: developerCookie, method: 'POST', body: duplicateUserPayload })).status, 409)
  const duplicatePartnerPayload = partnerPayload('DUP-NAME', `p_unique_${suffix}`)
  duplicatePartnerPayload.name = partnerA.name
  const duplicatePartnerResponse = await request('/api/v2/partner-management/partners', { cookie: developerCookie, method: 'POST', body: duplicatePartnerPayload })
  assert.equal(duplicatePartnerResponse.status, 409, await duplicatePartnerResponse.text())
  assert.deepEqual({ partners: await prisma.partner.count(), stores: await prisma.partnerStore.count(), users: await prisma.user.count(), bindings: await prisma.partnerUser.count() }, countsBeforeFailure)

  const invalidDiscounts = [-1, 0, 10001, 65.5, '65%', '1e2']
  for (const value of invalidDiscounts) {
    assert.equal((await request(`/api/v2/partner-management/partners/${partnerA.id}`, { cookie: developerCookie, method: 'PUT', body: { ...partnerA, defaultDiscountBps: value } })).status, 400)
  }
  const updateDiscount = await request(`/api/v2/partner-management/partners/${partnerA.id}`, { cookie: developerCookie, method: 'PUT', body: { ...partnerA, defaultDiscountBps: 7000 } })
  assert.equal(updateDiscount.status, 200)
  partnerA = (await updateDiscount.json()).partner
  assert.equal(partnerA.defaultDiscountBps, 7000)
  assert.equal(await prisma.partnerAuditLog.count({ where: { partnerId: partnerA.id, action: 'PARTNER_DISCOUNT_CHANGED' } }), 1)

  const paused = await request(`/api/v2/partner-management/partners/${partnerA.id}/status`, { cookie: adminCookie, method: 'PUT', body: { status: 'PAUSED', version: partnerA.version } })
  assert.equal(paused.status, 200)
  partnerA = (await paused.json()).partner
  assert.equal(partnerA.status, 'PAUSED')
  assert.equal(partnerA.version, 3)
  const staleLegacyBody = { ...partnerA, isActive: true }
  const legacyProfileEdit = await request(`/api/v2/partners/${partnerA.id}`, { cookie: developerCookie, method: 'PUT', body: { ...partnerA, note: 'paused profile edit' } })
  assert.equal(legacyProfileEdit.status, 200)
  partnerA.version = (await legacyProfileEdit.json()).partner.version
  assert.equal((await prisma.partner.findUnique({ where: { id: partnerA.id } })).status, 'PAUSED', 'omitted legacy isActive cannot reactivate a paused partner')
  assert.equal((await request(`/api/v2/partners/${partnerA.id}`, { cookie: developerCookie, method: 'PUT', body: staleLegacyBody })).status, 409, 'stale legacy version cannot overwrite the canonical lifecycle')
  const pausedLogin = await request('/api/partner/auth/login', { method: 'POST', body: { username: `partner_a2_${suffix}`, password: '123456' } })
  assert.equal(pausedLogin.status, 200)
  partnerCookie = pausedLogin.headers.get('set-cookie').split(';')[0]
  assert.equal((await request('/api/partner/profile', { cookie: partnerCookie })).status, 200)

  const terminated = await request(`/api/v2/partner-management/partners/${partnerA.id}/status`, { cookie: developerCookie, method: 'PUT', body: { status: 'TERMINATED', version: partnerA.version } })
  assert.equal(terminated.status, 200)
  partnerA = (await terminated.json()).partner
  assert.equal(partnerA.status, 'TERMINATED')
  assert.equal((await prisma.partner.findUnique({ where: { id: partnerA.id } })).isActive, false)
  const beforeLegacy = await prisma.partner.findUnique({ where: { id: partnerA.id } })
  const auditCount = await prisma.partnerAuditLog.count({ where: { partnerId: partnerA.id, action: 'PARTNER_STATUS_CHANGED' } })
  assert.equal((await request(`/api/v2/partners/${partnerA.id}`, { cookie: developerCookie, method: 'PUT', body: { ...partnerA, isActive: true } })).status, 409, 'legacy Boolean cannot revive TERMINATED')
  assert.deepEqual(await prisma.partner.findUnique({ where: { id: partnerA.id } }), beforeLegacy, 'rejected compatibility write is atomic')
  for (const compatibilityFields of [{}, { isActive: false }]) {
    const edit = await request(`/api/v2/partners/${partnerA.id}`, { cookie: developerCookie, method: 'PUT', body: { ...partnerA, ...compatibilityFields, note: 'terminated profile edit' } })
    assert.equal(edit.status, 200)
    partnerA.version = (await edit.json()).partner.version
    const canonical = await prisma.partner.findUnique({ where: { id: partnerA.id } })
    assert.equal(canonical.status, 'TERMINATED')
    assert.equal(canonical.isActive, false)
  }
  assert.equal(await prisma.partnerAuditLog.count({ where: { partnerId: partnerA.id, action: 'PARTNER_STATUS_CHANGED' } }), auditCount, 'profile edits do not invent lifecycle transitions')
  assert.equal((await request(`/api/v2/partner-management/partners/${partnerA.id}/users`, { cookie: developerCookie, method: 'POST', body: { username: `partner_a3_${suffix}`, password: '123456' } })).status, 409)

  const qinhuangdao = await request('/api/v2/partners', { cookie: developerCookie }).then((response) => response.json())
  assert.equal(qinhuangdao.rows.find((row) => row.id === `qinhuangdao-${suffix}`).defaultDiscountBps, 6500)

  const customerSession = await createCustomerSession({ userId: userIds.customer, markerKey: process.env.JWT_SECRET, db: prisma })
  const authenticatedCustomer = await authenticateCustomerSession({ rawToken: customerSession.rawToken, markerKey: process.env.JWT_SECRET, db: prisma })
  assert.equal(authenticatedCustomer.userId, userIds.customer)

  console.log(JSON.stringify({
    result: 'PARTNER_DOMAIN_HTTP_PASS', developerCreate: true, adminCreate: true, staffDenied: true,
    provisioningAtomic: true, multipleStores: true, multiplePartnerUsersSchema: true, oneActiveAccountLimit: true,
    tenantIsolation: true, pausedReadAccess: true, terminatedNewBusinessDenied: true, discountAudit: true,
    qinhuangdao6500Preserved: true, customerAuthPreserved: true, internalAuthPreserved: true, gate1PartnerAuthPreserved: true,
  }))
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
