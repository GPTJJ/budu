import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import express from 'express'
import { canManagePartnerDomain } from '../shared/accountPermissions.js'
import { createPartnerDomainRouter } from '../server/partner-domain.js'
import {
  PARTNER_STATUSES,
  assertPartnerCanCreateBusiness,
  assertPartnerStoreCanCreateBusiness,
  validateDiscountBps,
} from '../server/partner-domain-policy.js'

test('A/B/C/D Partner admin authority is Developer/Admin only', () => {
  assert.equal(canManagePartnerDomain({ role: 'developer', status: 'active' }), true)
  assert.equal(canManagePartnerDomain({ role: 'admin', status: 'active' }), true)
  for (const role of ['finance', 'manager', 'staff', 'cashier', 'partner', 'customer']) {
    assert.equal(canManagePartnerDomain({ role, status: 'active' }), false, role)
  }
  assert.equal(canManagePartnerDomain({ role: 'developer', status: 'disabled' }), false)
})

test('C/D Partner admin HTTP boundary rejects ordinary Internal and Partner principals', async () => {
  const db = {
    partner: { findMany: async () => [] },
  }
  const app = express()
  app.use((req, _res, next) => {
    const role = String(req.headers['x-test-role'] || 'staff')
    req.user = { id: `test-${role}`, username: `test-${role}`, role, status: 'active' }
    next()
  })
  app.use('/api/v2', createPartnerDomainRouter({ db, mirrorUsers: async () => {} }))
  const server = app.listen(0)
  await new Promise(resolve => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await fetch(`${origin}/api/v2/partner-management/partners`, { headers: { 'x-test-role': 'developer' } })).status, 200)
    assert.equal((await fetch(`${origin}/api/v2/partner-management/partners`, { headers: { 'x-test-role': 'admin' } })).status, 200)
    assert.equal((await fetch(`${origin}/api/v2/partner-management/partners`, { headers: { 'x-test-role': 'staff' } })).status, 403)
    assert.equal((await fetch(`${origin}/api/v2/partner-management/partners`, { headers: { 'x-test-role': 'partner' } })).status, 403)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('M/N Partner lifecycle and PartnerStore lifecycle block new business fail closed', () => {
  assert.equal(assertPartnerCanCreateBusiness({ status: PARTNER_STATUSES.ACTIVE }).status, 'ACTIVE')
  assert.throws(() => assertPartnerCanCreateBusiness({ status: 'PAUSED' }), /暂停补货/)
  assert.throws(() => assertPartnerCanCreateBusiness({ status: 'TERMINATED' }), /停止合作/)
  assert.throws(() => assertPartnerCanCreateBusiness({ status: 'unknown' }))
  assert.equal(assertPartnerStoreCanCreateBusiness({ status: 'ACTIVE' }).status, 'ACTIVE')
  assert.throws(() => assertPartnerStoreCanCreateBusiness({ status: 'INACTIVE' }), /已停用/)
})

test('O discount basis points accept only exact safe integers in Qinhuangdao range', () => {
  assert.equal(validateDiscountBps(6500), 6500)
  assert.equal(validateDiscountBps('6500'), 6500)
  for (const value of [-1, 0, 10001, 1.2, Number.NaN, Number.MAX_VALUE, '65%', '1e2', '1 OR 1=1']) {
    assert.throws(() => validateDiscountBps(value), undefined, String(value))
  }
})

test('P discount mutation records actor plus before and after values', async () => {
  const timestamp = new Date('2026-09-06T00:00:00.000Z')
  const auditLogs = []
  const row = {
    id: 'partner-a', name: 'Partner A', companyName: 'Partner A Company', contactName: 'Alice', contactPhone: '13800000000',
    cooperationStartDate: null, status: 'ACTIVE', defaultDiscountBps: 6500, defaultStoreKey: 'xidan', invoiceTitle: '', taxpayerId: '', contractReference: '', note: '',
    version: 1, createdAt: timestamp, updatedAt: timestamp, partnerStores: [], partnerUsers: [], auditLogs, defaultStore: { key: 'xidan', name: '西单店' }, _count: { supplyOrders: 0 },
  }
  const db = {
    async $transaction(work) { return work(db) },
    store: { findUnique: async () => ({ key: 'xidan', active: true }) },
    partner: {
      findFirst: async () => null,
      findUnique: async ({ include } = {}) => include ? row : structuredClone(row),
      updateMany: async ({ where, data }) => {
        if (where.id !== row.id || where.version !== row.version) return { count: 0 }
        const nextVersion = row.version + data.version.increment
        Object.assign(row, data, { version: nextVersion, updatedAt: new Date('2026-09-06T01:00:00.000Z') })
        return { count: 1 }
      },
    },
    partnerAuditLog: { create: async ({ data }) => { auditLogs.unshift({ ...data, createdAt: timestamp }); return data } },
  }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.user = { id: 'developer-a', username: 'developer-a', role: 'developer', status: 'active' }; next() })
  app.use('/api/v2', createPartnerDomainRouter({ db, mirrorUsers: async () => {} }))
  const server = app.listen(0)
  await new Promise(resolve => server.once('listening', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/partner-management/partners/partner-a`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        name: row.name, companyName: row.companyName, contactName: row.contactName, contactPhone: row.contactPhone,
        defaultDiscountBps: 7000, defaultStoreKey: row.defaultStoreKey, version: 1,
      }),
    })
    assert.equal(response.status, 200)
    assert.equal(row.defaultDiscountBps, 7000)
    const changed = auditLogs.find(log => log.action === 'PARTNER_DISCOUNT_CHANGED')
    assert.equal(changed.actorUsername, 'developer-a')
    assert.equal(changed.before.defaultDiscountBps, 6500)
    assert.equal(changed.after.defaultDiscountBps, 7000)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('F/H schema keeps PartnerStore and PartnerUser as 1:N without unique partnerId', () => {
  const schema = fs.readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8')
  const partnerUser = schema.match(/model PartnerUser \{[\s\S]*?\n\}/)?.[0] || ''
  const partnerStore = schema.match(/model PartnerStore \{[\s\S]*?\n\}/)?.[0] || ''
  assert.doesNotMatch(partnerUser, /@unique\s+@map\("partner_id"\)|@@unique\(\[partnerId\]\)/)
  assert.doesNotMatch(partnerStore, /@unique\s*$|@@unique\(\[partnerId\]\)/m)
  assert.match(partnerStore, /partnerId\s+String/)
})

test('migration is additive and deterministically preserves inactive legacy semantics', () => {
  const sql = fs.readFileSync(new URL('../prisma/migrations/20260906200000_partner_domain_foundation/migration.sql', import.meta.url), 'utf8')
  assert.doesNotMatch(sql, /\bDROP\b|DELETE\s+FROM|TRUNCATE/i)
  assert.match(sql, /UPDATE "Partner" SET "status" = 'PAUSED' WHERE "isActive" = FALSE/)
  assert.match(sql, /FOREIGN KEY \("partnerId"\).*ON DELETE RESTRICT/s)
})
