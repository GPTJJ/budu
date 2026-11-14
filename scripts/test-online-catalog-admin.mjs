import test from 'node:test'
import assert from 'node:assert/strict'
import { buildProductDoc, createOnlineCatalogPublisher, checksum } from '../server/online-catalog-publisher.js'
import { assertComboFlavors, assertComboOnShelf, comboSkus, findImportItem, normalizeComboInput, normalizeMedia, onlineSkuId, productProfileData, syncComboPolicies } from '../server/online-catalog.js'
import { withDisplayMedia, displayValue, classifyMediaValue, packageImageMirror, __resetMediaResolverForTest } from '../server/online-catalog-media.js'
import { parseImageDataUrl, buildCloudPath, uploadCatalogImage } from '../server/online-catalog-upload.js'
import { bannerData, bannerChecksum, serializeBanner } from '../server/online-catalog.js'
import { orderStateOf, orderStateWhere, normalizeOrderKeyword, autoCompleteCutoff } from '../server/online-catalog.js'

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


// ---- 导入匹配（ONLINE-CATALOG-COMBO-002） ----

test('findImportItem 优先用已有 SKU 映射反查，名称不一致也能收编', async () => {
  const calls = []
  const client = {
    onlineProductPolicy: {
      async findFirst({ where }) {
        calls.push(['policy', where.externalProductId])
        return { productId: 'it-balls' }
      },
    },
    inventoryItem: {
      async findUnique({ where }) { calls.push(['unique', where.id]); return { id: where.id, name: 'Balls 自选四款礼盒' } },
      async findFirst() { throw new Error('should not fall back to name match') },
    },
  }
  const item = await findImportItem(client, { id: 'bb', name: 'Balls-礼盒' })
  assert.equal(item.id, 'it-balls')
  assert.deepEqual(calls, [['policy', 'bb'], ['unique', 'it-balls']])
})

test('findImportItem 无映射时退回名称精确匹配', async () => {
  const client = {
    onlineProductPolicy: { async findFirst() { return null } },
    inventoryItem: {
      async findUnique() { throw new Error('no unique lookup expected') },
      async findFirst({ where }) { return { id: 'it-x', name: where.name } },
    },
  }
  const item = await findImportItem(client, { id: 'c9', name: ' 新商品 ' })
  assert.equal(item.id, 'it-x')
  assert.equal(item.name, '新商品')
})

test('findImportItem 映射指向的商品已删除时继续按名称兜底', async () => {
  const client = {
    onlineProductPolicy: { async findFirst() { return { productId: 'ghost' } } },
    inventoryItem: {
      async findUnique() { return null },
      async findFirst() { return { id: 'it-real' } },
    },
  }
  const item = await findImportItem(client, { id: 'x', name: '任意' })
  assert.equal(item.id, 'it-real')
})


// ---- 组合配置编辑（ONLINE-CATALOG-COMBO-003） ----

test('normalizeComboInput 归一化并派生单盒价', () => {
  const combo = normalizeComboInput({ slots: 4, repeat: true, flavorIds: ['b1', 'b2', 'b2', ' '] }, { priceCents: 29900n, mpId: 'bb' })
  assert.deepEqual(combo, { slots: 4, repeat: true, flavorIds: ['b1', 'b2'], unitPriceCent: 29900 })
})

test('normalizeComboInput 拒绝非法组合配置', () => {
  assert.throws(() => normalizeComboInput({ slots: 0, repeat: true, flavorIds: ['b1'] }, {}), /每盒口味数/)
  assert.throws(() => normalizeComboInput({ slots: 2.5, repeat: true, flavorIds: ['b1'] }, {}), /每盒口味数/)
  assert.throws(() => normalizeComboInput({ slots: 2, flavorIds: ['b1'] }, {}), /可否重复/)
  assert.throws(() => normalizeComboInput({ slots: 1, repeat: true, flavorIds: [] }, {}), /至少要有 1 个/)
  assert.throws(() => normalizeComboInput({ slots: 1, repeat: true, flavorIds: ['bb'] }, { mpId: 'bb' }), /不能把自己/)
  assert.throws(() => normalizeComboInput({ slots: 3, repeat: false, flavorIds: ['b1', 'b2'] }, {}), /不能超过可选口味数量/)
  assert.equal(normalizeComboInput(null), null)
})

test('assertComboFlavors 校验口味存在、已上架且不是组合商品', async () => {
  const client = (rows) => ({ onlineProductProfile: { async findMany() { return rows } } })
  const okRows = [{ mpId: 'b1', status: 'ON', combo: null }, { mpId: 'b2', status: 'ON', combo: null }]
  await assertComboFlavors(client(okRows), { flavorIds: ['b1', 'b2'] }, 'bb')

  await assert.rejects(() => assertComboFlavors(client([okRows[0]]), { flavorIds: ['b1', 'b9'] }, 'bb'), /不存在：b9/)
  await assert.rejects(() => assertComboFlavors(client([{ mpId: 'b1', status: 'ON', combo: { slots: 4 } }]), { flavorIds: ['b1'] }, 'bb'), /不能是组合商品/)
  await assert.rejects(() => assertComboFlavors(client([{ mpId: 'b1', status: 'OFF', combo: null }]), { flavorIds: ['b1'] }, 'bb'), /未上架/)
})

test('normalizeComboInput 拒绝自己作为口味（保存路径）', () => {
  assert.throws(() => normalizeComboInput({ slots: 4, repeat: true, flavorIds: ['bb', 'b1'] }, { priceCents: 29900n, mpId: 'bb' }), /不能把自己/)
})


// ---- 组合 SKU 映射同步（ONLINE-CATALOG-COMBO-004） ----

const BB_COMBO = { slots: 4, repeat: true, flavorIds: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'] }

test('comboSkus 枚举出全部 126 种搭配且与结算侧同一套哈希', () => {
  const skus = comboSkus('bb', BB_COMBO)
  assert.equal(skus.length, 126)
  assert.equal(new Set(skus).size, 126)
  assert.ok(skus.includes(onlineSkuId('bb', ['b4', 'b3', 'b2', 'b1'])), '口味顺序不影响 SKU')
})

test('syncComboPolicies 建全量映射、停用过期搭配', async () => {
  const calls = { created: [], enabled: null, disabled: null }
  const tx = {
    onlineProductPolicy: {
      async createMany({ data }) { calls.created = data },
      async updateMany({ where, data }) {
        if (where.externalSkuId && where.externalSkuId.notIn) calls.disabled = { where, data }
        else calls.enabled = { where, data }
      },
    },
  }
  const count = await syncComboPolicies(tx, { mpId: 'bb', combo: BB_COMBO, productId: 'it-balls', enabled: true, userId: 'u1' })
  assert.equal(count, 126)
  assert.equal(calls.created.length, 126)
  assert.equal(calls.created[0].productId, 'it-balls')
  assert.equal(calls.created[0].enabled, true)
  assert.equal(calls.created[0].externalProductId, 'bb')
  assert.equal(calls.disabled.data.enabled, false, '不在新集合里的旧搭配必须停用')
})


// ---- 发布前在架阻断（ONLINE-CATALOG-COMBO-005） ----

function shelfClient(rows) {
  return { onlineProductProfile: { async findMany() { return rows } } }
}
const ON_ROWS = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((mpId) => ({ mpId, status: 'ON', combo: null }))

test('assertComboOnShelf 全部口味在架时放行', async () => {
  const docs = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((id) => ({ id, status: 'on', name: id }))
  await assertComboOnShelf({ mpId: 'bb', combo: BB_COMBO }, { client: shelfClient(ON_ROWS), docs })
})

test('assertComboOnShelf 线上文档下架时阻断并指出商品', async () => {
  const docs = ['b1', 'b2', 'b3', 'b4', 'b5'].map((id) => ({ id, status: 'on', name: id }))
  docs.push({ id: 'b6', status: 'off', name: '巧克力豆.青苹果益生菌' })
  await assert.rejects(
    () => assertComboOnShelf({ mpId: 'bb', combo: BB_COMBO }, { client: shelfClient(ON_ROWS), docs }),
    /未在架 b6（巧克力豆.青苹果益生菌）/,
  )
})

test('assertComboOnShelf 线上缺失口味文档时阻断', async () => {
  const docs = ['b1', 'b2', 'b3', 'b4', 'b5'].map((id) => ({ id, status: 'on', name: id }))
  await assert.rejects(() => assertComboOnShelf({ mpId: 'bb', combo: BB_COMBO }, { client: shelfClient(ON_ROWS), docs }), /未在架 b6/)
})

test('assertComboOnShelf 非组合商品直接放行且不读目录', async () => {
  let read = 0
  await assertComboOnShelf({ mpId: 'c1', combo: null }, { client: shelfClient([]), readCatalog: async () => { read += 1; return [] } })
  assert.equal(read, 0)
})

test('assertComboOnShelf 口味档案本身已下架时先被 DB 校验拦下', async () => {
  const rows = ON_ROWS.map((row) => (row.mpId === 'b6' ? { ...row, status: 'OFF' } : row))
  await assert.rejects(() => assertComboOnShelf({ mpId: 'bb', combo: BB_COMBO }, { client: shelfClient(rows), docs: [] }), /未上架：b6/)
})

// ---- 首页轮播（营销） ----

const BANNER_BASE = {
  image: 'cloud://env.bucket/online-catalog/media/202611/a.jpg',
  title: '92% 生巧克力',
  linkType: 'product',
  linkValue: 'c1',
  sortOrder: 1,
  enabled: true,
}

test('bannerData normalizes a full banner and trims optional copy', () => {
  const data = bannerData({ ...BANNER_BASE, en: '  NAMA  ', subtitle: '  高可可 ', ctaText: '查看详情' })
  assert.equal(data.en, 'NAMA')
  assert.equal(data.subtitle, '高可可')
  assert.equal(data.linkType, 'product')
  assert.equal(data.linkValue, 'c1')
  assert.equal(data.enabled, true)
})

test('bannerData rejects non-upload images and unsafe links', () => {
  assert.throws(() => bannerData({ ...BANNER_BASE, image: '' }), /请上传轮播图/)
  assert.throws(() => bannerData({ ...BANNER_BASE, image: 'http://insecure/a.jpg' }), /云存储文件或 https/)
  assert.throws(() => bannerData({ ...BANNER_BASE, image: '/images/a.jpg' }), /云存储文件或 https/)
  assert.throws(() => bannerData({ ...BANNER_BASE, linkType: 'page', linkValue: 'pages/home' }), /\/pages\//)
  assert.throws(() => bannerData({ ...BANNER_BASE, linkType: 'product', linkValue: '../etc' }), /小程序商品 ID/)
  assert.throws(() => bannerData({ ...BANNER_BASE, linkType: 'shop', linkValue: 'c1' }), /不需要填写目标值/)
  assert.throws(() => bannerData({ ...BANNER_BASE, linkType: 'unknown' }), /跳转类型不正确/)
  assert.throws(() => bannerData({ ...BANNER_BASE, title: '' }), /请填写标题/)
})

test('bannerData keeps stored values on a partial update (enable toggle)', () => {
  const existing = {
    image: 'cloud://env.bucket/a.jpg', mobileImage: '', title: '旧标题', en: '', subtitle: '',
    dateText: '', ctaText: '', linkType: 'product', linkValue: 'c1', sortOrder: 3, enabled: true,
  }
  const data = bannerData({ enabled: false }, { existing })
  assert.equal(data.enabled, false)
  assert.equal(data.title, '旧标题')
  assert.equal(data.linkValue, 'c1')
  assert.equal(data.sortOrder, 3)
})

test('bannerChecksum ignores disabled entries so toggling one back does not look dirty', () => {
  const on = { ...BANNER_BASE, image: 'https://cdn/a.jpg' }
  const off = { ...BANNER_BASE, image: 'https://cdn/b.jpg', enabled: false }
  assert.equal(bannerChecksum([on, off]), bannerChecksum([on]))
  assert.notEqual(bannerChecksum([on]), bannerChecksum([{ ...on, title: 'changed' }]))
})

test('serializeBanner exposes camelCase fields with safe defaults', () => {
  const out = serializeBanner({ id: 'bn-1', image: 'https://cdn/a.jpg', title: 'T', sortOrder: 2, enabled: true })
  assert.equal(out.id, 'bn-1')
  assert.equal(out.linkType, 'none')
  assert.equal(out.linkValue, '')
  assert.equal(out.mobileImage, '')
  assert.equal(out.enabled, true)
})

const DAY = 24 * 60 * 60 * 1000
const ago = (days) => new Date(Date.now() - days * DAY)

test('orderStateOf: pickup orders are completed immediately', () => {
  assert.equal(orderStateOf('PAID', { method: 'PICKUP', createdAt: new Date() }), 'COMPLETED')
})

test('orderStateOf: delivery auto-completes after 7 days, not before', () => {
  assert.equal(orderStateOf('PAID', { method: 'DELIVERY', createdAt: ago(7.01) }), 'COMPLETED')
  assert.equal(orderStateOf('PAID', { method: 'DELIVERY', createdAt: ago(8) }), 'COMPLETED')
  assert.equal(orderStateOf('PAID', { method: 'DELIVERY', createdAt: ago(3) }), 'SHIPPED')
  assert.equal(orderStateOf('PAID', { method: 'DELIVERY', createdAt: ago(6.99) }), 'SHIPPED')
})

test('orderStateOf: paid without fulfillment stays TO_SHIP; other statuses untouched', () => {
  assert.equal(orderStateOf('PAID', null), 'TO_SHIP')
  assert.equal(orderStateOf('PAID', undefined), 'TO_SHIP')
  assert.equal(orderStateOf('PENDING', null), 'PENDING')
  assert.equal(orderStateOf('PENDING', { method: 'PICKUP', createdAt: new Date() }), 'PENDING')
})

test('orderStateOf: refunds and cancellations take priority over completion', () => {
  assert.equal(orderStateOf('REFUNDED', { method: 'PICKUP', createdAt: ago(9) }), 'REFUNDED')
  assert.equal(orderStateOf('CANCELLED', { method: 'DELIVERY', createdAt: ago(9) }), 'CANCELLED')
})

test('orderStateWhere mirrors orderStateOf for every derived state', () => {
  const cutoff = new Date('2026-11-15T00:00:00Z')
  assert.deepEqual(orderStateWhere('REFUNDED', cutoff), { status: 'REFUNDED' })
  assert.deepEqual(orderStateWhere('CANCELLED', cutoff), { status: 'CANCELLED' })
  assert.deepEqual(orderStateWhere('PENDING', cutoff), { status: { notIn: ['PAID', 'REFUNDED', 'CANCELLED'] } })
  assert.deepEqual(orderStateWhere('TO_SHIP', cutoff), { status: 'PAID', fulfillmentAuthorization: { is: null } })
  assert.deepEqual(orderStateWhere('SHIPPED', cutoff), {
    status: 'PAID',
    fulfillmentAuthorization: { method: 'DELIVERY', createdAt: { gt: cutoff } },
  })
  assert.deepEqual(orderStateWhere('COMPLETED', cutoff), {
    status: 'PAID',
    fulfillmentAuthorization: { OR: [{ method: 'PICKUP' }, { method: 'DELIVERY', createdAt: { lte: cutoff } }] },
  })
  assert.equal(orderStateWhere('BOGUS', cutoff), null)
})

test('orderStateWhere cutoff defaults to 7 days ago', () => {
  const cutoff = orderStateWhere('SHIPPED').fulfillmentAuthorization.createdAt.gt
  const expected = autoCompleteCutoff().getTime()
  assert.ok(Math.abs(cutoff.getTime() - expected) < 5000, 'cutoff should be ~7 days ago')
})

test('normalizeOrderKeyword strips the derived customer label prefix', () => {
  assert.equal(normalizeOrderKeyword('顾客 4a0a'), '4a0a')
  assert.equal(normalizeOrderKeyword('顾客4a0a'), '4a0a')
  assert.equal(normalizeOrderKeyword(' 4a0a '), '4a0a')
  assert.equal(normalizeOrderKeyword('os-92e5567181d6'), 'os-92e5567181d6')
  assert.equal(normalizeOrderKeyword(''), '')
})
