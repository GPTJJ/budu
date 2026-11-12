import express from 'express'
import assert from 'node:assert/strict'
import { onlineCatalogRouter, onlineSkuId } from '../server/online-catalog.js'
import { prisma } from '../server/pg.js'

if (!process.env.DATABASE_URL) {
  console.log('SKIP: DATABASE_URL not set; run with a migrated disposable PostgreSQL database')
  process.exit(0)
}

const suffix = 'apitest'
const mpId = 'c-apitest'
const categoryName = `API测试分类-${suffix}`
const itemName = `API测试商品-${suffix}`
const cover = `data:image/png;base64,${Buffer.from('cover').toString('base64')}`

async function cleanup() {
  await prisma.onlineProductPolicy.deleteMany({ where: { externalProductId: mpId } }).catch(() => {})
  await prisma.onlineProductProfile.deleteMany({ where: { mpId } }).catch(() => {})
  await prisma.onlineCategory.deleteMany({ where: { name: categoryName } }).catch(() => {})
  const items = await prisma.inventoryItem.findMany({ where: { name: itemName }, select: { id: true } }).catch(() => [])
  for (const item of items) {
    await prisma.inventoryItemCostHistory.deleteMany({ where: { inventoryItemId: item.id } }).catch(() => {})
    await prisma.inventoryItem.deleteMany({ where: { id: item.id } }).catch(() => {})
  }
}

await cleanup()

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use((req, res, next) => {
  req.user = { id: 'u-test', role: 'developer', status: 'active' }
  next()
})
app.use('/api/v2', onlineCatalogRouter)
const server = app.listen(0)
const base = `http://127.0.0.1:${server.address().port}/api/v2`
const call = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  let data = null
  try { data = await response.json() } catch { data = null }
  return { status: response.status, data }
}

let failure = null
try {
  const category = await call('/online-catalog/categories', {
    method: 'POST',
    body: JSON.stringify({ name: categoryName, sortOrder: 50 }),
  })
  assert.equal(category.status, 201)
  assert.equal(category.data.category.name, categoryName)
  const categoryId = category.data.category.id

  const created = await call('/online-catalog/products', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'new',
      name: itemName,
      sku: `SKU-${suffix}`,
      salePrice: '12.50',
      costPrice: '5.00',
      unit: '盒',
      spec: '100g',
      onlineCategoryId: categoryId,
      mpId,
      title: itemName,
      subtitle: '副标题',
      price: '13.00',
      shelfLife: '90天',
      storage: '冷冻',
      sortOrder: 50,
      status: 'ON',
      media: { cover, gallery: [], detail: [] },
    }),
  })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  assert.equal(created.data.product.mpId, mpId)
  assert.equal(created.data.product.priceCents, '1300')
  assert.equal(created.data.product.item.salePriceCents, '1250')
  assert.equal(created.data.product.status, 'ON')

  const policy = await prisma.onlineProductPolicy.findUnique({
    where: { namespace_externalProductId_externalSkuId: { namespace: 'cloudbase-miniprogram', externalProductId: mpId, externalSkuId: onlineSkuId(mpId) } },
  })
  assert.ok(policy, 'policy must exist')
  assert.equal(policy.enabled, true)

  const status = await call('/online-catalog/status')
  assert.equal(status.status, 200)
  assert.equal(status.data.cloudbase.configured, false)
  assert.ok(status.data.counts.products >= 1)

  const preview = await call(`/online-catalog/products/${created.data.product.id}/preview`)
  assert.equal(preview.status, 200)
  assert.equal(preview.data.doc.id, mpId)
  assert.equal(preview.data.doc.unitPriceCent, 1300)
  assert.match(preview.data.doc.media.cover, /^\[embedded image /)

  const list = await call('/online-catalog/products')
  assert.equal(list.status, 200)
  assert.ok(list.data.products.some((product) => product.mpId === mpId))

  const updated = await call(`/online-catalog/products/${created.data.product.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      title: '改名',
      price: '14.00',
      status: 'OFF',
      onlineCategoryId: categoryId,
      unit: '盒',
      spec: '100g',
      sortOrder: 51,
      media: { cover: '', gallery: [], detail: [] },
    }),
  })
  assert.equal(updated.status, 200, JSON.stringify(updated.data))
  assert.equal(updated.data.product.title, '改名')
  assert.equal(updated.data.product.priceCents, '1400')
  assert.equal(updated.data.product.status, 'OFF')
  const policyAfter = await prisma.onlineProductPolicy.findUnique({
    where: { namespace_externalProductId_externalSkuId: { namespace: 'cloudbase-miniprogram', externalProductId: mpId, externalSkuId: onlineSkuId(mpId) } },
  })
  assert.equal(policyAfter.enabled, false)

  const items = await call(`/online-catalog/items?q=${encodeURIComponent(itemName)}`)
  assert.equal(items.status, 200)
  assert.equal(items.data.items.length, 0, 'profiled item must not be offered again')

  const duplicate = await call('/online-catalog/products', {
    method: 'POST',
    body: JSON.stringify({ mode: 'existing', inventoryItemId: created.data.product.inventoryItemId, onlineCategoryId: categoryId, title: 'dup', price: '1.00', status: 'DRAFT' }),
  })
  assert.equal(duplicate.status, 409)

  // 未配置 TCB 凭据时必须 fail closed，且不得让未处理的 Promise 拒绝打崩进程。
  const publish = await call(`/online-catalog/products/${created.data.product.id}/publish`, { method: 'POST' })
  assert.equal(publish.status, 503, JSON.stringify(publish.data))
  assert.match(String(publish.data.error), /CloudBase|凭据/)
  const failedProfile = await prisma.onlineProductProfile.findUnique({ where: { id: created.data.product.id } })
  assert.equal(failedProfile.publishState, 'FAILED')
  assert.ok(failedProfile.lastError)
  const importWithoutCreds = await call('/online-catalog/import-existing', { method: 'POST' })
  assert.equal(importWithoutCreds.status, 503, JSON.stringify(importWithoutCreds.data))
  const stillAlive = await call('/online-catalog/categories')
  assert.equal(stillAlive.status, 200, 'publish failure must not take down the server')

  console.log('API_TEST_PASS')
} catch (error) {
  failure = error
  console.error('API_TEST_FAIL', error)
} finally {
  await cleanup()
  server.close()
  await prisma.$disconnect()
}
if (failure) process.exit(1)
