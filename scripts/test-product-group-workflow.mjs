import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-product-group-'))
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = await createDisposablePgSchema('product_group')
const { createApp } = await import('../server/app.js')
const { prisma } = await import('../server/pg.js')
const server = createApp().listen(0)
const jsonHeaders = (cookie) => ({ 'Content-Type': 'application/json', Cookie: cookie })
const json = async (response) => ({ status: response.status, body: await response.json() })
const coverImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X8W3WQAAAABJRU5ErkJggg=='

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const base = `${origin}/api/v2`
  const register = await fetch(`${origin}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'group-admin', password: '123456' }) })
  if (!register.ok) throw new Error(`注册失败：${register.status} ${await register.text()}`)
  const cookie = register.headers.get('set-cookie')?.split(';')[0]
  await prisma.store.create({ data: { key: 'tongying', name: '北京通盈中心店' } })

  const createProduct = async (name, sku, sortOrder, price = '7900') => {
    const result = await json(await fetch(`${base}/products`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({
      name, sku, salePriceCents: price, costPriceCents: '3000', unit: '个', image: name.endsWith('蓝') ? coverImage : '', isActive: true,
      transferEnabled: name.endsWith('蓝'), partnerSupplyEnabled: name.endsWith('蓝'), sortOrder,
    }) }))
    if (result.status !== 201) throw new Error(`创建商品失败：${result.status} ${JSON.stringify(result.body)}`)
    return result.body.product
  }
  const blue = await createProduct('12号幸运小饼干-蓝', 'LUCKY-12-BLUE', 1)
  const green = await createProduct('12号幸运小饼干-绿', 'LUCKY-12-GREEN', 2)
  const yellow = await createProduct('12号幸运小饼干-黄', 'LUCKY-12-YELLOW', 3, '8900')
  const single = await createProduct('小草包', 'GRASS-BAG', 4, '12900')
  const stableIds = [blue.productId, green.productId, yellow.productId, single.productId]

  const created = await json(await fetch(`${base}/product-groups`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({
    name: '12号幸运小饼干', coverImage, sortOrder: 8, isActive: true,
    members: [
      { productId: blue.productId, variantName: '蓝' },
      { productId: green.productId, variantName: '绿' },
      { productId: yellow.productId, variantName: '黄' },
    ],
  }) }))
  if (created.status !== 201 || created.body.group.memberCount !== 3) throw new Error(`商品组创建失败：${created.status} ${JSON.stringify(created.body)}`)
  const group = created.body.group
  if (group.members.find((item) => item.productId === blue.productId)?.variantName !== '蓝') throw new Error('款式名称未保存')

  const duplicateMembership = await fetch(`${base}/product-groups`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({
    name: '错误重复组', sortOrder: 9, isActive: true, members: [{ productId: blue.productId, variantName: '重复' }],
  }) })
  if (duplicateMembership.status !== 409) throw new Error('同一 SKU 被允许加入两个商品组')
  if (await prisma.productGroup.count() !== 1) throw new Error('失败的重复分组没有完整回滚')
  if ((await prisma.inventoryItem.findUnique({ where: { id: blue.productId } })).productGroupId !== group.id) throw new Error('重复分组改变了原成员关系')

  const yellowCurrent = group.members.find((item) => item.productId === yellow.productId)
  const disabled = await json(await fetch(`${base}/products/${yellow.productId}`, { method: 'PUT', headers: jsonHeaders(cookie), body: JSON.stringify({ ...yellowCurrent, isActive: false }) }))
  if (disabled.status !== 200 || disabled.body.product.productId !== yellow.productId) throw new Error('停用组内 SKU 失败')

  const posProducts = await json(await fetch(`${base}/pos/products`, { headers: { Cookie: cookie } }))
  if (posProducts.status !== 200) throw new Error('POS 商品接口失败')
  const posIds = posProducts.body.rows.map((item) => item.productId)
  if (!posIds.includes(blue.productId) || !posIds.includes(green.productId) || !posIds.includes(single.productId) || posIds.includes(yellow.productId)) throw new Error('POS eligibility 或停用 SKU 过滤不正确')
  if (posProducts.body.rows.find((item) => item.productId === blue.productId)?.productGroup?.id !== group.id) throw new Error('POS 未返回人工商品组关系')
  const groupImage = await fetch(`${base}/pos/product-groups/${group.id}/image`, { headers: { Cookie: cookie } })
  if (groupImage.status !== 200 || groupImage.headers.get('content-type') !== 'image/png') throw new Error('商品组主图接口失败')

  const orderResult = await json(await fetch(`${base}/pos/orders`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({
    storeId: 'tongying', checkoutKey: 'product-group-checkout-1', items: [{ productId: blue.productId, quantity: 1 }], discountPercent: 100, remark: '',
  }) }))
  if (orderResult.status !== 201 || orderResult.body.order.items[0]?.productId !== blue.productId) throw new Error(`真实 SKU 下单失败：${orderResult.status} ${JSON.stringify(orderResult.body)}`)
  const orderItem = await prisma.orderItem.findFirst({ where: { orderId: orderResult.body.order.id } })
  if (orderItem?.productId !== blue.productId || orderItem.productNameSnapshot !== '12号幸运小饼干-蓝') throw new Error('OrderItem 写入了商品组身份或错误快照')

  const transfer = await json(await fetch(`${base}/transfer-master-items?active=true&category=product`, { headers: { Cookie: cookie } }))
  if (!transfer.body.rows.some((item) => item.id === blue.productId)) throw new Error('商品组关系破坏门店调拨真实商品选择')
  const partner = await json(await fetch(`${base}/partner-supply-products`, { headers: { Cookie: cookie } }))
  if (!partner.body.rows.some((item) => item.id === blue.productId)) throw new Error('商品组关系破坏合作商供货真实商品选择')

  const disabledGroup = await json(await fetch(`${base}/product-groups/${group.id}`, { method: 'PUT', headers: jsonHeaders(cookie), body: JSON.stringify({
    name: group.name, coverImage, sortOrder: 10, isActive: false, version: group.version,
    members: [{ productId: blue.productId, variantName: '蓝' }],
  }) }))
  if (disabledGroup.status !== 200 || disabledGroup.body.group.isActive !== false || disabledGroup.body.group.memberCount !== 1) throw new Error('商品组编辑或停用失败')
  const detachedGreen = await prisma.inventoryItem.findUnique({ where: { id: green.productId } })
  if (!detachedGreen || detachedGreen.productGroupId !== null || detachedGreen.variantName !== '') throw new Error('移出商品组没有只解除展示关系')
  const finalIds = (await prisma.inventoryItem.findMany({ orderBy: { id: 'asc' }, select: { id: true } })).map((item) => item.id)
  if (!stableIds.every((id) => finalIds.includes(id)) || finalIds.length !== stableIds.length) throw new Error('商品组流程合并、删除或复制了 InventoryItem')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log('PRODUCT GROUP WORKFLOW TEST OK')
