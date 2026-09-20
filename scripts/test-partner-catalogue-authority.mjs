import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { productData } from '../server/products.js'
import { listPartnerCatalogue } from '../server/partner-replenishment-catalogue.js'

const product = { id: 'product-a', name: '独立开关测试', sku: 'CAT-A', unit: '份', category: 'product', salePriceCents: '500', costPriceCents: '100', isActive: false, partnerOrderUnit: 'NATIVE', updatedAt: new Date() }
const partner = { id: 'partner-a', status: 'ACTIVE', defaultDiscountBps: 6500 }
const principal = { partnerId: partner.id }
function db(rows) {
  return { partner: { findUnique: async () => partner }, inventoryItem: { findMany: async ({ where }) => rows.filter(r => r.category === where.category && r.partnerReplenishmentEnabled === where.partnerReplenishmentEnabled) } }
}

test('旧供货 ON / Partner 人工 OFF 不进入目录，后续旧业务保存仍保持 OFF', async () => {
  const off = productData({ ...product, partnerSupplyEnabled: true, partnerReplenishmentEnabled: false })
  const { partnerReplenishmentEnabled, ...oldSave } = { ...product, ...off }
  const saved = productData(oldSave, '', off)
  assert.equal(saved.partnerReplenishmentEnabled, false)
  assert.equal(saved.partnerSupplyEnabled, true)
  assert.deepEqual(await listPartnerCatalogue({ db: db([{ ...product, ...saved }]), principal }), [])
})

test('旧供货 OFF / Partner 人工 ON 进入目录，旧业务保存不得覆盖 ON', async () => {
  const on = productData({ ...product, partnerSupplyEnabled: false, partnerReplenishmentEnabled: true })
  const { partnerReplenishmentEnabled, ...oldSave } = { ...product, ...on }
  const saved = productData(oldSave, '', on)
  assert.equal(saved.partnerReplenishmentEnabled, true)
  assert.equal(saved.partnerSupplyEnabled, false)
  const rows = await listPartnerCatalogue({ db: db([{ ...product, ...saved }]), principal })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].referencePriceCents, '325')
})

test('商品保存接口拒绝 Partner 和无商品管理权限账号', async () => {
  // dbReady only checks configuration; the denied requests must never reach a DB call.
  const previous = process.env.DATABASE_URL
  process.env.DATABASE_URL = 'postgresql://isolated@127.0.0.1:1/never_connect'
  const { productsRouter } = await import('../server/products.js')
  for (const role of ['partner', 'staff', 'customer']) {
    const app = express()
    app.use(express.json(), (req, res, next) => { req.user = { id: 'denied', role, status: 'active' }; next() }, productsRouter)
    const server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    try {
      const result = await fetch(`http://127.0.0.1:${server.address().port}/products/product-a`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, partnerReplenishmentEnabled: true }) })
      assert.equal(result.status, 403, role)
    } finally { await new Promise(resolve => server.close(resolve)) }
  }
  if (previous === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = previous
})
