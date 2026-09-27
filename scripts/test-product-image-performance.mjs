import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import sharp from 'sharp'
import { createWebpThumbnail, imageVersion, resetProductImageCacheForTests, sendStoredImage } from '../server/product-images.js'
import { serializeProduct } from '../server/products.js'

async function sampleDataUrl() {
  const source = await sharp({ create: { width: 640, height: 400, channels: 3, background: '#d84f86' } }).jpeg({ quality: 90 }).toBuffer()
  return `data:image/jpeg;base64,${source.toString('base64')}`
}

function responseRecorder() {
  const headers = {}
  return {
    headers,
    body: null,
    statusCode: 200,
    setHeader(name, value) { headers[name.toLowerCase()] = value },
    send(body) { this.body = body },
    status(code) { this.statusCode = code; return this },
    end() {},
  }
}

test('product list serialization never returns the PostgreSQL Base64 original', () => {
  const row = serializeProduct({
    id: 'p-1', name: '测试商品', sku: 'SKU-1', posCategory: '', transferCode: '', salePriceCents: 100n,
    costPriceCents: 50n, unit: '份', image: 'data:image/jpeg;base64,ZmFrZQ==', barcode: '', isActive: true,
    transferEnabled: false, partnerSupplyEnabled: false, productCategoryId: null, productCategory: null,
    productGroupId: null, productGroup: null, variantName: '', trackInventory: false, sortOrder: 0, version: 1,
    createdAt: new Date('2026-08-29T00:00:00Z'), updatedAt: new Date('2026-08-29T00:00:00Z'),
  })
  assert.equal(row.image, '')
  assert.equal(row.hasImage, true)
  assert.doesNotMatch(JSON.stringify(row), /data:image\//)
})

test('product and POS list queries do not read PostgreSQL image payloads', async () => {
  const [productsSource, posSource] = await Promise.all([
    readFile(new URL('../server/products.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/pos.js', import.meta.url), 'utf8'),
  ])
  assert.match(productsSource, /export const productListSelect = \{/)
  assert.match(productsSource, /select: productListSelect/)
  assert.match(productsSource, /where: \{ category: 'product', image: \{ not: '' \} \},\s*select: \{ id: true \}/)
  assert.match(posSource, /import \{ productListSelect, serializeProduct \}/)
  assert.match(posSource, /select: productListSelect/)
})

test('thumbnail is a cached WebP constrained to 320px', async () => {
  resetProductImageCacheForTests()
  const dataUrl = await sampleDataUrl()
  const first = await createWebpThumbnail(dataUrl, 'p-1:v1')
  const second = await createWebpThumbnail(dataUrl, 'p-1:v1')
  const metadata = await sharp(first).metadata()
  assert.equal(metadata.format, 'webp')
  assert.equal(metadata.width, 320)
  assert.equal(metadata.height, 200)
  assert.equal(first, second)
})

test('versioned image responses are immutable while unversioned responses revalidate', async () => {
  const dataUrl = await sampleDataUrl()
  const updatedAt = new Date('2026-08-29T00:00:00Z')
  const version = imageVersion(updatedAt)
  const versioned = responseRecorder()
  await sendStoredImage({ query: { v: version }, headers: {} }, versioned, { dataUrl, updatedAt, identity: 'product:p-1', thumbnail: true })
  assert.equal(versioned.headers['content-type'], 'image/webp')
  assert.equal(versioned.headers['cache-control'], 'private, max-age=31536000, immutable')
  assert.match(versioned.headers.etag, /^".+"$/)
  const unversioned = responseRecorder()
  await sendStoredImage({ query: {}, headers: {} }, unversioned, { dataUrl, updatedAt, identity: 'product:p-1', thumbnail: true })
  assert.equal(unversioned.headers['cache-control'], 'private, max-age=0, must-revalidate')
})
