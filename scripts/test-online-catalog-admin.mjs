import test from 'node:test'
import assert from 'node:assert/strict'
import { buildProductDoc, createOnlineCatalogPublisher, checksum } from '../server/online-catalog-publisher.js'
import { normalizeMedia, onlineSkuId, productProfileData } from '../server/online-catalog.js'
import { withDisplayMedia, displayValue, classifyMediaValue, packageImageMirror, __resetMediaResolverForTest } from '../server/online-catalog-media.js'
import { parseImageDataUrl, buildCloudPath, uploadCatalogImage } from '../server/online-catalog-upload.js'

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
        // @cloudbase/node-sdk takes the payload directly (no { data } wrapper).
        async update(payload) {
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('update payload must be an object')
          if ('data' in payload) throw new Error('do not wrap payloads in { data } — node-sdk takes fields directly')
          const current = docs.get(id)
          if (!current) throw new Error('missing doc')
          docs.set(id, { ...current, ...payload })
        },
        async set(payload) {
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('set payload must be an object')
          if ('data' in payload) throw new Error('do not wrap payloads in { data } — node-sdk takes fields directly')
          docs.set(id, { _id: id, ...payload })
        },
      }
    },
    async add(payload) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('add payload must be an object')
      if ('data' in payload) throw new Error('do not wrap payloads in { data } — node-sdk takes fields directly')
      const _id = `_${++sequence}`
      docs.set(_id, { _id, ...payload })
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

test('buildProductDoc keeps the combo definition and syncs its box price', () => {
  const combo = { slots: 4, repeat: true, flavorIds: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'], unitPriceCent: 19900 }
  const doc = buildProductDoc({ profile: profile({ mpId: 'bb', title: 'Balls-礼盒', priceCents: 29900n }), category, item, combo })
  assert.equal(doc.combo.slots, 4)
  assert.equal(doc.combo.repeat, true)
  assert.deepEqual(doc.combo.flavorIds, ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'])
  assert.equal(doc.combo.unitPriceCent, 29900, '组合单盒价必须跟随线上价')
  assert.equal(doc.unitPriceCent, 29900)
})

test('buildProductDoc never emits a combo for normal products', () => {
  assert.equal(buildProductDoc({ profile: profile(), category, item }).combo, null)
  assert.equal(buildProductDoc({ profile: profile(), category, item, combo: 'garbage' }).combo, null)
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

test('productProfileData treats an empty price field as “not provided”', () => {
  const created = productProfileData({ status: 'ON', price: '' }, { item: { name: 'x', salePriceCents: 1250n } })
  assert.equal(created.priceCents, 1250n, '新建时空白线上价应跟随 POS 售价')
  const edited = productProfileData(
    { status: 'ON', price: '' },
    { existing: { title: '旧标题', priceCents: 990n }, item: { name: 'x', salePriceCents: 1250n } },
  )
  assert.equal(edited.priceCents, 990n, '编辑时空白线上价应保留原值')
})


// ---- 首页/列表图片展示（ONLINE-CATALOG-MEDIA-001） ----

test('media: 小程序包内路径映射到 OS 镜像目录且拒绝路径穿越', () => {
  assert.equal(packageImageMirror('/images/c1.jpg'), '/mp-images/c1.jpg')
  assert.equal(packageImageMirror('/images/..%2fsecret.jpg'), '')
  assert.equal(packageImageMirror('/images/a/b.jpg'), '')
  assert.equal(packageImageMirror('https://cdn/a.jpg'), '')
  assert.equal(packageImageMirror(''), '')
})

test('media: 只有 cloud:// 需要解析，data:/https 原样可用', () => {
  assert.equal(classifyMediaValue('cloud://env.bucket/a.jpg'), 'cloud')
  assert.equal(classifyMediaValue('/images/s1.jpg'), 'package')
  assert.equal(classifyMediaValue('data:image/jpeg;base64,AAA'), 'inline')
  assert.equal(displayValue('cloud://env.bucket/a.jpg', {}), '')
  assert.equal(displayValue('cloud://env.bucket/a.jpg', { 'cloud://env.bucket/a.jpg': 'https://temp/a.jpg' }), 'https://temp/a.jpg')
  assert.equal(displayValue('/images/s1.jpg', {}), '/mp-images/s1.jpg')
  assert.equal(displayValue('https://cdn/a.jpg', {}), 'https://cdn/a.jpg')
})

test('media: 批量解析 cloud:// 且不污染原始 media，结果命中缓存', async () => {
  const calls = []
  __resetMediaResolverForTest(() => ({
    async getTempFileURL({ fileList }) {
      calls.push(fileList)
      return { fileList: fileList.map((id) => ({ fileID: id, code: 'SUCCESS', tempFileURL: `https://temp/${id.split('/').pop()}` })) }
    },
  }))
  const media = { cover: 'cloud://env.bucket/c1/cover.jpg', gallery: ['/images/c1.jpg', 'cloud://env.bucket/c1/g1.jpg'], detail: [] }
  const [row] = await withDisplayMedia([{ id: 'p1', media }])
  assert.equal(row.mediaDisplay.cover, 'https://temp/cover.jpg')
  assert.deepEqual(row.media, media, '原始 media 必须保持 cloud:// 原值')
  assert.equal(row.mediaDisplay.gallery[0], '/mp-images/c1.jpg')
  assert.equal(row.mediaDisplay.gallery[1], 'https://temp/g1.jpg')
  await withDisplayMedia([{ id: 'p1', media }])
  assert.equal(calls.length, 1, '第二次应命中缓存，不再请求云存储')
  __resetMediaResolverForTest()
})

test('media: 云存储不可用时降级为空串而不是抛错', async () => {
  __resetMediaResolverForTest(() => ({ async getTempFileURL() { throw new Error('Access Denied') } }))
  const [row] = await withDisplayMedia([{ id: 'p', media: { cover: 'cloud://env.bucket/x.jpg' } }])
  assert.equal(row.mediaDisplay.cover, '')
  __resetMediaResolverForTest()
})


// ---- 图片上传（改为云存储，库里只存 cloud://） ----

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('upload: 解析 data URL 并校验真实文件头', () => {
  const parsed = parseImageDataUrl(PNG_1PX)
  assert.equal(parsed.ext, 'png')
  assert.ok(parsed.buffer.length > 0)
})

test('upload: 拒绝非图片、伪装图片与超大文件', () => {
  assert.throws(() => parseImageDataUrl('not-a-data-url'), /图片格式不支持/)
  assert.throws(() => parseImageDataUrl('data:text/html;base64,PGgxPg=='), /只支持 JPG/)
  const fakeJpeg = `data:image/jpeg;base64,${Buffer.from('hello').toString('base64')}`
  assert.throws(() => parseImageDataUrl(fakeJpeg), /不是有效图片/)
  assert.throws(() => parseImageDataUrl(PNG_1PX, { maxBytes: 10 }), /图片过大/)
})

test('upload: 云路径按月分目录且文件名不可预测', () => {
  const path = buildCloudPath('jpg', new Date('2026-11-14T10:00:00Z'))
  assert.match(path, /^online-catalog\/media\/202611\/[0-9a-f-]{36}\.jpg$/)
  assert.notEqual(path, buildCloudPath('jpg', new Date('2026-11-14T10:00:00Z')))
})

test('upload: 成功时把文件写进云存储并返回 fileID', async () => {
  const calls = []
  const client = {
    async uploadFile(payload) {
      calls.push(payload)
      return { fileID: `cloud://env.bucket/${payload.cloudPath}` }
    },
  }
  const result = await uploadCatalogImage(PNG_1PX, { client })
  assert.match(result.fileId, /^cloud:\/\/env\.bucket\/online-catalog\/media\/\d{6}\/[0-9a-f-]{36}\.png$/)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].fileContent.length > 0)
})

test('upload: 云存储异常或无 fileID 时报错而不是静默成功', async () => {
  await assert.rejects(() => uploadCatalogImage(PNG_1PX, { client: { async uploadFile() { throw new Error('COS down') } } }), /图片上传失败/)
  await assert.rejects(() => uploadCatalogImage(PNG_1PX, { client: { async uploadFile() { return {} } } }), /未返回文件标识/)
})
