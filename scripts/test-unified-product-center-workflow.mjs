import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-unified-product-center-'))
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = await createDisposablePgSchema('unified_product_center')
const { createApp } = await import('../server/app.js')
const { prisma } = await import('../server/pg.js')
const server = createApp().listen(0)
const jsonHeaders = (cookie) => ({ 'Content-Type': 'application/json', Cookie: cookie })
const json = async (response) => ({ status: response.status, body: await response.json() })

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/v2`
  const register = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'product-admin', password: '123456' }) })
  if (!register.ok) throw new Error(`注册失败：${register.status} ${await register.text()}`)
  const cookie = register.headers.get('set-cookie')?.split(';')[0]

  const categoryResult = await json(await fetch(`${base}/product-categories`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ name: '太妃糖', sortOrder: 1, isActive: true }) }))
  if (categoryResult.status !== 201) throw new Error(`分类创建失败：${categoryResult.status} ${JSON.stringify(categoryResult.body)}`)
  const category = categoryResult.body.category

  const transferResult = await json(await fetch(`${base}/transfer-master-items`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ category: 'product', code: 'NO.1', name: 'NO.1树莓', productCategoryId: category.id, sortOrder: 1, enabled: true }) }))
  if (transferResult.status !== 201) throw new Error(`历史调拨商品创建失败：${transferResult.status} ${JSON.stringify(transferResult.body)}`)
  const transferProduct = transferResult.body.item
  const stableId = transferProduct.id

  const allProducts = await json(await fetch(`${base}/products`, { headers: { Cookie: cookie } }))
  if (allProducts.status !== 200 || !allProducts.body.rows.some((row) => row.productId === stableId && row.transferEnabled && !row.isActive)) throw new Error('统一商品中心未读取历史调拨 InventoryItem')

  const editResult = await json(await fetch(`${base}/products/${stableId}`, { method: 'PUT', headers: jsonHeaders(cookie), body: JSON.stringify({
    ...allProducts.body.rows.find((row) => row.productId === stableId),
    name: 'NO.1树莓', sku: '', transferCode: 'NO.1', productCategoryId: category.id,
    salePriceCents: '500', costPriceCents: '', isActive: false, transferEnabled: true, partnerSupplyEnabled: true,
  }) }))
  if (editResult.status !== 200 || editResult.body.product.productId !== stableId) throw new Error(`稳定 ID 编辑失败：${editResult.status} ${JSON.stringify(editResult.body)}`)

  const duplicate = await fetch(`${base}/products`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ name: 'NO.1树莓', sku: 'OTHER-1', salePriceCents: '500', costPriceCents: '200', isActive: true, transferEnabled: false, partnerSupplyEnabled: false, sortOrder: 2 }) })
  if (duplicate.status !== 409) throw new Error('系统允许按同名新增后隐式覆盖或合并历史商品')
  if (await prisma.inventoryItem.count({ where: { name: 'NO.1树莓' } }) !== 1) throw new Error('同名冲突改变了商品行数')

  const posResult = await json(await fetch(`${base}/products`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ name: 'POS布丁', sku: 'POS-1', productCategoryId: '', salePriceCents: '7200', costPriceCents: '2300', unit: '份', isActive: true, transferEnabled: false, partnerSupplyEnabled: false, sortOrder: 2 }) }))
  if (posResult.status !== 201) throw new Error(`POS 商品创建失败：${posResult.status} ${JSON.stringify(posResult.body)}`)
  const posId = posResult.body.product.productId

  const batchCategory = await json(await fetch(`${base}/products/bulk`, { method: 'PUT', headers: jsonHeaders(cookie), body: JSON.stringify({ ids: [stableId, posId], operation: 'category', productCategoryId: category.id }) }))
  if (batchCategory.status !== 200 || batchCategory.body.updated !== 2 || batchCategory.body.rows.some((row) => row.productCategoryId !== category.id)) throw new Error('批量分类失败')
  const batchPartner = await json(await fetch(`${base}/products/bulk`, { method: 'PUT', headers: jsonHeaders(cookie), body: JSON.stringify({ ids: [posId], operation: 'purpose', purpose: 'partner', enabled: true }) }))
  if (batchPartner.status !== 200 || !batchPartner.body.rows[0].partnerSupplyEnabled || batchPartner.body.rows[0].transferEnabled) throw new Error('合作商开关未保持独立')

  const posProducts = await json(await fetch(`${base}/pos/products`, { headers: { Cookie: cookie } }))
  if (posProducts.status !== 200 || !posProducts.body.rows.some((row) => row.productId === posId) || posProducts.body.rows.some((row) => row.productId === stableId)) throw new Error('POS eligibility 未按正式 POS 属性过滤')
  const transferProducts = await json(await fetch(`${base}/transfer-master-items?active=true&category=product`, { headers: { Cookie: cookie } }))
  if (transferProducts.status !== 200 || !transferProducts.body.rows.some((row) => row.id === stableId) || transferProducts.body.rows.some((row) => row.id === posId)) throw new Error('调拨 eligibility 未按 transferEnabled 过滤')
  const partnerProducts = await json(await fetch(`${base}/partner-supply-products`, { headers: { Cookie: cookie } }))
  if (partnerProducts.status !== 200 || !partnerProducts.body.rows.some((row) => row.id === stableId) || !partnerProducts.body.rows.some((row) => row.id === posId)) throw new Error('合作商 eligibility 未按独立开关及正式零售价过滤')

  await prisma.inventoryItem.update({ where: { id: stableId }, data: { transferEnabled: false } })
  const afterTransferDisable = await json(await fetch(`${base}/partner-supply-products`, { headers: { Cookie: cookie } }))
  if (!afterTransferDisable.body.rows.some((row) => row.id === stableId)) throw new Error('合作商选择器仍错误依赖 transferEnabled')
  if (await prisma.inventoryItem.count({ where: { category: 'product' } }) !== 2) throw new Error('统一过程中商品数据丢失或产生隐式副本')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log('UNIFIED PRODUCT CENTER WORKFLOW TEST OK')
