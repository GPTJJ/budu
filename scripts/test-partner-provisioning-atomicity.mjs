import assert from 'node:assert/strict'
import test from 'node:test'
import { provisionPartner } from '../server/partner-domain.js'

const developer = { id: 'developer-a', username: 'developer-a', role: 'developer', status: 'active' }
const body = {
  name: '原子合作商', companyName: '原子公司', contactName: '联系人', contactPhone: '13800138000',
  cooperationStartDate: '2026-09-06', defaultDiscountBps: 6500, defaultStoreKey: 'xidan',
  invoiceTitle: '原子公司', taxpayerId: 'TAX-ATOMIC', contractReference: 'ARCHIVE-1', internalNote: 'internal',
  store: { name: '一号店', contactName: '店长', phone: '13800138001', province: '北京市', city: '北京市', district: '西城区', addressLine: '测试路1号', status: 'ACTIVE' },
  account: { username: 'atomic_partner', password: '123456' },
}

function fakeDb(failAt = '', seed = {}) {
  const state = {
    partners: [...(seed.partners || [])], stores: [], users: [...(seed.users || [])], bindings: [], audits: [],
  }
  const db = {
    state,
    async $transaction(work) {
      const next = structuredClone(state)
      const timestamp = new Date('2026-09-06T00:00:00.000Z')
      const tx = {
        store: { findUnique: async ({ where }) => where.key === 'xidan' ? { key: 'xidan', active: true } : null },
        partner: {
          findFirst: async ({ where }) => next.partners.find((row) => row.name.toLowerCase() === where.name.equals.toLowerCase()) || null,
          create: async ({ data }) => { if (failAt === 'partner') throw new Error('PARTNER_CREATE_FAILED'); const row = { ...data, version: 1, createdAt: timestamp, updatedAt: timestamp }; next.partners.push(row); return row },
        },
        partnerStore: {
          create: async ({ data }) => { if (failAt === 'store') throw new Error('STORE_CREATE_FAILED'); const row = { ...data, version: 1, createdAt: timestamp, updatedAt: timestamp }; next.stores.push(row); return row },
        },
        user: {
          findUnique: async ({ where }) => next.users.find((row) => row.username === where.username) || null,
          create: async ({ data }) => { if (failAt === 'user') throw new Error('USER_CREATE_FAILED'); const row = { ...data, createdAt: timestamp }; next.users.push(row); return row },
        },
        partnerUser: {
          create: async ({ data }) => {
            if (failAt === 'binding') throw new Error('BINDING_CREATE_FAILED')
            const user = next.users.find((row) => row.id === data.userId)
            const row = { ...data, createdAt: timestamp, updatedAt: timestamp, user: { username: user?.username || '' } }
            next.bindings.push(row); return row
          },
        },
        partnerAuditLog: { create: async ({ data }) => { next.audits.push(data); return data } },
      }
      const result = await work(tx)
      Object.assign(state, next)
      return result
    },
  }
  return db
}

for (const phase of ['partner', 'store', 'user', 'binding']) {
  test(`E provisioning rollback leaves no orphan when ${phase} creation fails`, async () => {
    const db = fakeDb(phase)
    await assert.rejects(() => provisionPartner({ body, currentUser: developer, db, mirrorUsers: async () => {} }))
    assert.deepEqual({ partners: db.state.partners.length, stores: db.state.stores.length, users: db.state.users.length, bindings: db.state.bindings.length, audits: db.state.audits.length }, { partners: 0, stores: 0, users: 0, bindings: 0, audits: 0 })
  })
}

test('I duplicate User identity blocks the transaction before any Partner facts exist', async () => {
  const db = fakeDb('', { users: [{ id: 'existing', username: body.account.username }] })
  await assert.rejects(() => provisionPartner({ body, currentUser: developer, db, mirrorUsers: async () => {} }), /用户名已存在/)
  assert.equal(db.state.partners.length, 0)
  assert.equal(db.state.stores.length, 0)
  assert.equal(db.state.bindings.length, 0)
  assert.equal(db.state.users.length, 1)
})

for (const currentUser of [developer, { id: 'admin-a', username: 'admin-a', role: 'admin', status: 'active' }]) {
  test(`${currentUser.role === 'developer' ? 'A' : 'B'}/E/J successful provisioning commits Partner, Store, User, binding and audit together`, async () => {
    const db = fakeDb()
    await provisionPartner({ body, currentUser, db, mirrorUsers: async () => {} })
    assert.deepEqual({ partners: db.state.partners.length, stores: db.state.stores.length, users: db.state.users.length, bindings: db.state.bindings.length, audits: db.state.audits.length }, { partners: 1, stores: 1, users: 1, bindings: 1, audits: 3 })
    assert.equal(db.state.users[0].role, 'partner')
    assert.notEqual(db.state.users[0].passwordHash, body.account.password)
    assert.equal(db.state.bindings[0].partnerId, db.state.partners[0].id)
  })
}
