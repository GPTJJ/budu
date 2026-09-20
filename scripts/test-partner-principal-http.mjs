import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-partner-gate1-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'partner-gate-1-http-secret-only'
process.env.DATABASE_URL = process.env.PARTNER_GATE1_SCHEMA_READY === 'true'
  ? process.env.TEST_DATABASE_URL
  : await createDisposablePgSchema('partner_gate1')

if (!process.env.DATABASE_URL) {
  throw new Error('PARTNER_GATE1_HTTP_NOT_RUN — 缺少 TEST_DATABASE_URL')
}

const { PrismaClient } = await import('@prisma/client')
const { hashPassword, signToken } = await import('../server/auth.js')
const { createApp } = await import('../server/app.js')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
const suffix = crypto.randomUUID().slice(0, 8)
const ids = {
  store: `partner-g1-store-${suffix}`,
  internal: `partner-g1-internal-${suffix}`,
  partner: `partner-g1-partner-${suffix}`,
  customer: `partner-g1-customer-${suffix}`,
  tenant: `partner-g1-tenant-${suffix}`,
  binding: `partner-g1-binding-${suffix}`,
}

await prisma.store.create({ data: { key: ids.store, name: 'Gate 1 Store' } })
await prisma.user.createMany({ data: [
  { id: ids.internal, username: `gate1_internal_${suffix}`, passwordHash: hashPassword('123456'), role: 'developer', status: 'active', storeKeys: [], permissions: {} },
  { id: ids.partner, username: `gate1_partner_${suffix}`, passwordHash: hashPassword('123456'), role: 'partner', status: 'active', storeKeys: [], permissions: {} },
  { id: ids.customer, username: `gate1_customer_${suffix}`, passwordHash: hashPassword('123456'), role: 'customer', status: 'active', storeKeys: [], permissions: {} },
] })
await prisma.partner.create({ data: {
  id: ids.tenant,
  name: `Gate 1 Partner ${suffix}`,
  defaultStoreKey: ids.store,
  defaultDiscountBps: 6500,
  isActive: true,
} })
await prisma.partnerUser.create({ data: { id: ids.binding, partnerId: ids.tenant, userId: ids.partner } })

const app = createApp()
const server = app.listen(0)
await new Promise(resolve => server.once('listening', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const request = (pathname, { cookie = '', method = 'GET', body } = {}) => fetch(`${origin}${pathname}`, {
  method,
  headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
})

try {
  const internalLogin = await request('/api/auth/login', { method: 'POST', body: { username: `gate1_internal_${suffix}`, password: '123456' } })
  assert.equal(internalLogin.status, 200)
  const internalCookie = internalLogin.headers.get('set-cookie').split(';')[0]

  assert.equal((await request('/api/auth/login', { method: 'POST', body: { username: `gate1_partner_${suffix}`, password: '123456' } })).status, 403)
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { username: `gate1_customer_${suffix}`, password: '123456' } })).status, 403)
  assert.equal((await request('/api/partner/auth/login', { method: 'POST', body: { username: `gate1_internal_${suffix}`, password: '123456' } })).status, 401)

  const partnerLogin = await request('/api/partner/auth/login', { method: 'POST', body: { username: `gate1_partner_${suffix}`, password: '123456' } })
  assert.equal(partnerLogin.status, 200)
  const partnerCookie = partnerLogin.headers.get('set-cookie').split(';')[0]
  assert.match(partnerCookie, /^budu_partner_token=/)

  assert.equal((await request('/api/partner/auth/me', { cookie: partnerCookie })).status, 200)
  assert.equal((await request('/api/auth/me', { cookie: partnerCookie })).status, 401)
  assert.equal((await request('/api/v2/items', { cookie: partnerCookie })).status, 401)
  assert.equal((await request('/api/partner/auth/me', { cookie: internalCookie })).status, 401)

  const forgedInternalCookie = `budu_token=${signToken({ id: ids.partner, username: 'partner', role: 'partner' }, process.env.JWT_SECRET)}`
  assert.equal((await request('/api/auth/me', { cookie: forgedInternalCookie })).status, 403)

  const simultaneous = `${internalCookie}; ${partnerCookie}`
  assert.equal((await request('/api/auth/me', { cookie: simultaneous })).status, 200)
  assert.equal((await request('/api/partner/auth/me', { cookie: simultaneous })).status, 200)

  const adminList = await request('/api/admin/users', { cookie: internalCookie })
  assert.equal(adminList.status, 200)
  assert.equal((await adminList.json()).users.some(user => user.id === ids.partner || user.id === ids.customer), false)
  assert.equal((await request(`/api/admin/users/${ids.partner}/password`, { cookie: internalCookie, method: 'PUT', body: { newPassword: '654321' } })).status, 404)
  assert.equal((await request(`/api/admin/users/${ids.partner}/role`, { cookie: internalCookie, method: 'PUT', body: { role: 'staff' } })).status, 404)

  await prisma.partnerUser.update({ where: { id: ids.binding }, data: { status: 'disabled', disabledAt: new Date() } })
  assert.equal((await request('/api/partner/auth/me', { cookie: partnerCookie })).status, 401)
  await prisma.partnerUser.update({ where: { id: ids.binding }, data: { status: 'active', disabledAt: null } })
  assert.equal((await request('/api/partner/auth/me', { cookie: partnerCookie })).status, 401)

  const relogin = await request('/api/partner/auth/login', { method: 'POST', body: { username: `gate1_partner_${suffix}`, password: '123456' } })
  assert.equal(relogin.status, 200)
  const currentPartnerCookie = relogin.headers.get('set-cookie').split(';')[0]
  const logout = await request('/api/partner/auth/logout', { method: 'POST', cookie: currentPartnerCookie })
  assert.equal(logout.status, 200)
  assert.equal((await request('/api/partner/auth/me', { cookie: currentPartnerCookie })).status, 401)
  const revoked = await prisma.customerSession.findFirst({ where: { userId: ids.partner, principalType: 'PARTNER' }, orderBy: { createdAt: 'desc' } })
  assert.ok(revoked.revokedAt)

  console.log(JSON.stringify({
    result: 'PARTNER_PRINCIPAL_HTTP_PASS',
    internalPartnerCustomerIsolated: true,
    partnerCannotCallInternal: true,
    simultaneousCookieNamespaces: true,
    staleBindingDenied: true,
    genericAccountAdminDenied: true,
    logoutRevoked: true,
  }))
} finally {
  await new Promise(resolve => server.close(resolve))
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
