import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import cookieParser from 'cookie-parser'
import { hashPassword, signToken } from '../server/auth.js'
import { authenticateInternalToken } from '../server/internal-auth.js'
import {
  PRINCIPAL_TYPES,
  partnerScopedWhere,
  resolveExternalPrincipal,
  resolveInternalPrincipal,
} from '../server/principals.js'
import {
  authenticateCustomerSession,
  createCustomerSession,
} from '../server/customer-auth.js'
import {
  PARTNER_SESSION_COOKIE,
  authenticatePartnerSession,
  createPartnerAuthRouter,
  createPartnerSession,
  resolvePartnerBinding,
} from '../server/partner-auth.js'

const markerKey = 'gate-1-partner-marker-key-only'
const epoch = new Date('2026-09-06T00:00:00.000Z')

function fixture({ bindingStatus = 'active', partnerActive = true, partnerStatus = 'ACTIVE', duplicateBinding = false } = {}) {
  const users = new Map([
    ['internal-a', { id: 'internal-a', username: 'internal', passwordHash: hashPassword('123456'), role: 'developer', status: 'active', employeeId: '' }],
    ['partner-user-a', { id: 'partner-user-a', username: 'partner-a', passwordHash: hashPassword('123456'), role: 'partner', status: 'active' }],
    ['partner-user-b', { id: 'partner-user-b', username: 'partner-b', passwordHash: hashPassword('123456'), role: 'partner', status: 'active' }],
    ['customer-a', { id: 'customer-a', username: 'customer', passwordHash: 'unusable', role: 'customer', status: 'active' }],
    ['disabled-partner', { id: 'disabled-partner', username: 'partner-disabled', passwordHash: hashPassword('123456'), role: 'partner', status: 'disabled' }],
  ])
  const partners = new Map([
    ['partner-a', { id: 'partner-a', name: 'Partner A', companyName: 'Partner A Company', contactName: 'Alice', contactPhone: '13800000001', status: partnerActive ? partnerStatus : '', defaultDiscountBps: 6500, note: 'INTERNAL-A', version: 1, isActive: partnerActive, updatedAt: epoch }],
    ['partner-b', { id: 'partner-b', name: 'Partner B', companyName: 'Partner B Company', contactName: 'Bob', contactPhone: '13800000002', status: 'ACTIVE', defaultDiscountBps: 7000, note: 'INTERNAL-B', version: 1, isActive: true, updatedAt: epoch }],
  ])
  const bindings = [
    { id: 'binding-a', userId: 'partner-user-a', partnerId: 'partner-a', status: bindingStatus, updatedAt: epoch, partner: partners.get('partner-a') },
    { id: 'binding-b', userId: 'partner-user-b', partnerId: 'partner-b', status: 'active', updatedAt: epoch, partner: partners.get('partner-b') },
  ]
  if (duplicateBinding) bindings.push({ id: 'binding-a-duplicate', userId: 'partner-user-a', partnerId: 'partner-b', status: 'active', updatedAt: epoch, partner: partners.get('partner-b') })
  const sessions = new Map()
  const stores = [
    { id: 'store-a', partnerId: 'partner-a', name: 'Partner A Store', contactName: 'A', phone: '1', province: '北京市', city: '北京市', district: '西城区', addressLine: 'A Road', status: 'ACTIVE', version: 1 },
    { id: 'store-b', partnerId: 'partner-b', name: 'Partner B Store', contactName: 'B', phone: '2', province: '天津市', city: '天津市', district: '和平区', addressLine: 'B Road', status: 'ACTIVE', version: 1 },
  ]
  const db = {
    customerSession: {
      create: async ({ data }) => {
        const row = { ...data, revokedAt: null, user: users.get(data.userId) }
        sessions.set(data.tokenHash, row)
        return row
      },
      findUnique: async ({ where }) => sessions.get(where.tokenHash) || null,
      update: async ({ where, data }) => {
        const row = [...sessions.values()].find(item => item.id === where.id)
        if (!row) throw new Error('missing session')
        Object.assign(row, data)
        return row
      },
    },
    partnerUser: {
      findMany: async ({ where, take }) => bindings.filter(row => row.userId === where.userId).slice(0, take),
    },
    partner: {
      findUnique: async ({ where }) => partners.get(where.id) || null,
    },
    partnerStore: {
      findMany: async ({ where, take }) => stores.filter(row => row.partnerId === where.partnerId).slice(0, take),
      findFirst: async ({ where }) => stores.find(row => row.id === where.id && row.partnerId === where.partnerId) || null,
    },
  }
  return { db, users, partners, bindings, sessions, stores }
}

test('A/C/G internal and customer principal types are explicit and mutually exclusive', async () => {
  const { db, users } = fixture()
  const internal = resolveInternalPrincipal(users.get('internal-a'))
  assert.equal(internal.type, PRINCIPAL_TYPES.INTERNAL)
  assert.equal(resolveInternalPrincipal(users.get('partner-user-a')), null)
  assert.equal(resolveInternalPrincipal(users.get('customer-a')), null)
  assert.equal(resolveExternalPrincipal(users.get('customer-a'), PRINCIPAL_TYPES.CUSTOMER).type, PRINCIPAL_TYPES.CUSTOMER)
  assert.equal(resolveExternalPrincipal(users.get('internal-a'), PRINCIPAL_TYPES.CUSTOMER), null)

  const customer = await createCustomerSession({ userId: 'customer-a', markerKey, db, now: new Date(epoch.getTime() + 1000) })
  const authenticated = await authenticateCustomerSession({ rawToken: customer.rawToken, markerKey, db, now: new Date(epoch.getTime() + 2000) })
  assert.equal(authenticated.principal.type, PRINCIPAL_TYPES.CUSTOMER)
})

test('B partner principal resolves only through one active binding and active Partner', async () => {
  const { db, users } = fixture()
  const issued = await createPartnerSession({ user: users.get('partner-user-a'), markerKey, db, now: new Date(epoch.getTime() + 1000) })
  const authenticated = await authenticatePartnerSession({ rawToken: issued.rawToken, markerKey, db, now: new Date(epoch.getTime() + 2000) })
  assert.deepEqual(authenticated.principal, {
    type: PRINCIPAL_TYPES.PARTNER,
    userId: 'partner-user-a',
    partnerUserId: 'binding-a',
    partnerId: 'partner-a',
  })
})

test('Gate 2 PAUSED and TERMINATED remain readable principals while new-business policy stays separate', async () => {
  for (const partnerStatus of ['PAUSED', 'TERMINATED']) {
    const { db, users } = fixture({ partnerStatus })
    const issued = await createPartnerSession({ user: users.get('partner-user-a'), markerKey, db, now: new Date(epoch.getTime() + 1000) })
    assert.equal(issued.principal.partnerId, 'partner-a')
  }
})

test('D/E stale, missing, duplicate, disabled binding, disabled User and disabled Partner fail closed', async () => {
  await assert.rejects(resolvePartnerBinding({ userId: 'missing', db: fixture().db }), /PARTNER_PRINCIPAL_DENIED/)
  await assert.rejects(resolvePartnerBinding({ userId: 'partner-user-a', db: fixture({ duplicateBinding: true }).db }), /PARTNER_PRINCIPAL_DENIED/)
  await assert.rejects(resolvePartnerBinding({ userId: 'partner-user-a', db: fixture({ bindingStatus: 'disabled' }).db }), /PARTNER_PRINCIPAL_DENIED/)
  await assert.rejects(resolvePartnerBinding({ userId: 'partner-user-a', db: fixture({ partnerActive: false }).db }), /PARTNER_PRINCIPAL_DENIED/)

  const disabled = fixture()
  await assert.rejects(createPartnerSession({ user: disabled.users.get('disabled-partner'), markerKey, db: disabled.db }), /PARTNER_PRINCIPAL_DENIED/)

  const stale = fixture()
  const issued = await createPartnerSession({ user: stale.users.get('partner-user-a'), markerKey, db: stale.db, now: new Date(epoch.getTime() + 1000) })
  stale.bindings[0].updatedAt = new Date(epoch.getTime() + 1500)
  await assert.rejects(authenticatePartnerSession({ rawToken: issued.rawToken, markerKey, db: stale.db, now: new Date(epoch.getTime() + 2000) }), /PARTNER_SESSION_STALE/)
})

test('F/G/J internal JWT cannot become Partner and external principals cannot enter internal auth', async () => {
  const { users } = fixture()
  const getUserById = async id => users.get(id) || null
  const internalToken = signToken(users.get('internal-a'), markerKey)
  const internal = await authenticateInternalToken({ token: internalToken, secret: markerKey, getUserById })
  assert.equal(internal.principal.type, PRINCIPAL_TYPES.INTERNAL)
  await assert.rejects(authenticateInternalToken({ token: signToken(users.get('partner-user-a'), markerKey), secret: markerKey, getUserById }), /账号已停用/)
  await assert.rejects(authenticateInternalToken({ token: signToken(users.get('customer-a'), markerKey), secret: markerKey, getUserById }), /账号已停用/)
  await assert.rejects(authenticateInternalToken({ token: 'malformed', secret: markerKey, getUserById }), /未登录/)
})

test('H/J customer and Partner session namespaces reject collision, tampering and wrong marker keys', async () => {
  const { db, users } = fixture()
  const customer = await createCustomerSession({ userId: 'customer-a', markerKey, db, now: new Date(epoch.getTime() + 1000) })
  const partner = await createPartnerSession({ user: users.get('partner-user-a'), markerKey, db, now: new Date(epoch.getTime() + 1000) })
  await assert.rejects(authenticatePartnerSession({ rawToken: customer.rawToken, markerKey, db }), /PARTNER_SESSION_DENIED/)
  await assert.rejects(authenticateCustomerSession({ rawToken: partner.rawToken, markerKey, db }), /CUSTOMER_SESSION_DENIED/)
  await assert.rejects(authenticatePartnerSession({ rawToken: `${partner.rawToken}x`, markerKey, db }), /PARTNER_SESSION_DENIED/)
  await assert.rejects(authenticatePartnerSession({ rawToken: partner.rawToken, markerKey: 'different-marker-key', db }), /PARTNER_SESSION_DENIED/)
})

test('I tenant predicates always derive partnerId from authenticated principal', () => {
  const principal = { type: PRINCIPAL_TYPES.PARTNER, userId: 'partner-user-a', partnerUserId: 'binding-a', partnerId: 'partner-a' }
  assert.deepEqual(partnerScopedWhere(principal, { id: 'partner-b-order' }), { id: 'partner-b-order', partnerId: 'partner-a' })
  assert.throws(() => partnerScopedWhere(principal, { id: 'order', partnerId: 'partner-b' }), /PARTNER_TENANT_SCOPE_DENIED/)
  assert.throws(() => partnerScopedWhere({ ...principal, type: PRINCIPAL_TYPES.INTERNAL }, { id: 'order' }), /PARTNER_PRINCIPAL_DENIED/)
})

test('H/I/J/K Partner HTTP boundary uses its own cookie, blocks forged tenant input and revokes logout session', async () => {
  const state = fixture()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/partner', createPartnerAuthRouter({
    db: state.db,
    userByUsername: async username => [...state.users.values()].find(user => user.username === username) || null,
    secretLoader: async () => markerKey,
  }))
  const server = app.listen(0)
  await new Promise(resolve => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const request = (path, { cookie = '', method = 'GET', body } = {}) => fetch(`${origin}${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  try {
    const forged = await request('/api/partner/auth/login', { method: 'POST', body: { username: 'partner-a', password: '123456', partnerId: 'partner-b' } })
    assert.equal(forged.status, 400)
    const internalLogin = await request('/api/partner/auth/login', { method: 'POST', body: { username: 'internal', password: '123456' } })
    assert.equal(internalLogin.status, 401)
    const login = await request('/api/partner/auth/login', { method: 'POST', body: { username: 'partner-a', password: '123456' } })
    assert.equal(login.status, 200)
    const setCookie = login.headers.get('set-cookie') || ''
    assert.match(setCookie, new RegExp(`^${PARTNER_SESSION_COOKIE}=`))
    assert.match(setCookie, /HttpOnly/i)
    assert.match(setCookie, /Path=\/api\/partner/i)
    assert.match(setCookie, /SameSite=Strict/i)
    assert.doesNotMatch(setCookie, /(?:^|[,; ]+)budu_token=/)
    const partnerCookie = setCookie.split(';')[0]
    const me = await request('/api/partner/auth/me', { cookie: partnerCookie })
    assert.equal(me.status, 200)
    assert.deepEqual((await me.json()).principal, { type: 'PARTNER', partner: { id: 'partner-a', name: 'Partner A', status: 'ACTIVE' } })
    const profile = await request('/api/partner/profile', { cookie: partnerCookie })
    assert.equal(profile.status, 200)
    const profileBody = await profile.json()
    assert.equal(profileBody.partner.id, 'partner-a')
    assert.doesNotMatch(JSON.stringify(profileBody), /INTERNAL-A|passwordHash|permissions/)
    assert.equal((await request('/api/partner/profile?partnerId=partner-b', { cookie: partnerCookie })).status, 400)
    const stores = await request('/api/partner/stores', { cookie: partnerCookie })
    assert.deepEqual((await stores.json()).rows.map(row => row.id), ['store-a'])
    assert.equal((await request('/api/partner/stores/store-b', { cookie: partnerCookie })).status, 404)
    assert.equal((await request('/api/partner/auth/me', { cookie: `budu_token=${encodeURIComponent(partnerCookie)}` })).status, 401)

    const customer = await createCustomerSession({ userId: 'customer-a', markerKey, db: state.db })
    const logout = await request('/api/partner/auth/logout', { method: 'POST', cookie: partnerCookie })
    assert.equal(logout.status, 200)
    assert.equal((await request('/api/partner/auth/me', { cookie: partnerCookie })).status, 401)
    assert.equal((await authenticateCustomerSession({ rawToken: customer.rawToken, markerKey, db: state.db })).principal.type, 'CUSTOMER')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
