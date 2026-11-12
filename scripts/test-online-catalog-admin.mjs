import test from 'node:test'
import assert from 'node:assert/strict'
import { buildProductDoc, createOnlineCatalogPublisher, checksum } from '../server/online-catalog-publisher.js'
import { normalizeMedia, onlineSkuId, productProfileData } from '../server/online-catalog.js'

const category = { name: '生巧克力', meta: { color: '#A13966', sub: '手工生巧' } }
const item = { name: '新商品', unit: '盒', spec: '100g/盒', salePriceCents: 13800n }

function profile(overrides = {}) {
  return {
    mpId: 'c7',
    title: '新商品',
    subtitle: '测试副标题',
    spec: '100g/盒',
    unit: '盒',
    priceCents: 13800n,
    shelfLife: '90天',
    storage: '冷冻',
    media: { cover: '', gallery: [], detail: [] },
    sortOrder: 7,
    status: 'ON',
    ...overrides,
  }
}

function fakeApp() {
  const docs = new Map()
  let sequence = 0
  const collection = () => ({
    where(query) {
      return {
        limit() {
          return {
            async get() {
              return { data: [...docs.values()].filter((doc) => Object.entries(query).every(([key, value]) => doc[key] === value)) }
            },
          }
        },
      }
    },
    doc(id) {
      return {
        async update({ data }) {
          const current = docs.get(id)
          if (!current) throw new Error('missing doc')
          docs.set(id, { ...current, ...data })
        },
        async set({ data }) {
          docs.set(id, { _id: id, ...data })
        },
      }
    },
    async add({ data }) {
      const _id = `_${++sequence}`
      docs.set(_id, { _id, ...data })
      return { _id }
    },
  })
  return {
    docs,
    database: () => ({ collection }),
    uploadFile: async ({ cloudPath }) => ({ fileID: `cloud://test-env/${cloudPath}` }),
  }
}

test('buildProductDoc projects the MiniProgram whitelist fields', () => {
  const doc = buildProductDoc({ profile: profile(), category, item })
  assert.equal(doc.id, 'c7')
  assert.equal(doc.name, '新商品')
  assert.equal(doc.category, '生巧克力')
  assert.equal(doc.status, 'on')
  assert.equal(doc.unitPriceCent, 13800)
  assert.equal(doc.combo, null)
  assert.deepEqual(doc.categoryMeta, category.meta)
  assert.equal(doc.sortOrder, 7)
})

test('buildProductDoc refuses an ON product without a positive price', () => {
  assert.throws(() => buildProductDoc({ profile: profile({ priceCents: 0n }), category, item }), /售价/)
})

test('buildProductDoc falls back to the POS price for an OFF product', () => {
  const doc = buildProductDoc({ profile: profile({ status: 'OFF', priceCents: null }), category, item })
  assert.equal(doc.status, 'off')
  assert.equal(doc.unitPriceCent, 13800)
})

test('publisher creates once, updates idempotently, and verifies read-back', async () => {
  const app = fakeApp()
  const publisher = createOnlineCatalogPublisher({ app, envId: 'test-env' })
  const first = await publisher.publishProduct({ profile: profile(), category, item })
  assert.equal(first.action, 'created')
  assert.equal(app.docs.size, 1)
  const second = await publisher.publishProduct({ profile: profile(), category, item })
  assert.equal(second.action, 'updated')
  assert.equal(app.docs.size, 1)
  assert.equal(first.checksum, second.checksum)
  assert.equal(first.checksum, checksum(first.doc))
})

test('publisher uploads data URLs to CloudBase storage and stores file ids', async () => {
  const app = fakeApp()
  const publisher = createOnlineCatalogPublisher({ app, envId: 'test-env' })
  const cover = `data:image/png;base64,${Buffer.from('cover').toString('base64')}`
  const result = await publisher.publishProduct({ profile: profile({ media: { cover, gallery: [], detail: [] } }), category, item })
  assert.match(result.doc.media.cover, /^cloud:\/\/test-env\/product-cover\/c7\/cover-0\.png$/)
})

test('publisher writes the category _meta document', async () => {
  const app = fakeApp()
  const publisher = createOnlineCatalogPublisher({ app, envId: 'test-env' })
  await publisher.publishCategories([category, { name: '糖果' }])
  assert.deepEqual(app.docs.get('_meta').categories, ['生巧克力', '糖果'])
})

test('normalizeMedia rejects unsafe image sources and accepts data URLs', () => {
  assert.throws(() => normalizeMedia({ cover: 'javascript:alert(1)' }), /格式/)
  const dataUrl = `data:image/jpeg;base64,${Buffer.from('x').toString('base64')}`
  assert.equal(normalizeMedia({ cover: dataUrl }).cover, dataUrl)
  assert.deepEqual(normalizeMedia({ gallery: ['cloud://env/a.jpg'] }).gallery, ['cloud://env/a.jpg'])
})

test('onlineSkuId is deterministic and combo-order insensitive', () => {
  assert.match(onlineSkuId('c1'), /^sku-[0-9a-f]{64}$/)
  assert.equal(onlineSkuId('bb', ['b2', 'b1']), onlineSkuId('bb', ['b1', 'b2']))
  assert.notEqual(onlineSkuId('bb'), onlineSkuId('bb', ['b1']))
})

test('productProfileData defaults price and identity from an existing item', () => {
  const data = productProfileData({ status: 'DRAFT' }, { item: { name: '默认名', salePriceCents: 500n, unit: '颗', spec: '6g' } })
  assert.equal(data.title, '默认名')
  assert.equal(data.priceCents, 500n)
  assert.equal(data.unit, '颗')
  assert.equal(data.status, 'DRAFT')
})

test('productProfileData refuses an ON product without a price', () => {
  assert.throws(() => productProfileData({ status: 'ON', title: 'x' }, { item: { name: 'x', salePriceCents: null } }), /售价/)
})
