import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-transfer-box-piece-'))
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = await createDisposablePgSchema('transfer_box_piece')
const { createApp } = await import('../server/app.js')
const { prisma } = await import('../server/pg.js')
const server = createApp().listen(0)
const json = async (response) => ({ status: response.status, body: await response.json() })

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const register = await fetch(`${origin}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'transfer-admin', password: '123456' }) })
  if (!register.ok) throw new Error(`注册失败：${register.status}`)
  const cookie = register.headers.get('set-cookie')?.split(';')[0]
  const headers = { 'Content-Type': 'application/json', Cookie: cookie }
  const productResult = await json(await fetch(`${origin}/api/v2/products`, { method: 'POST', headers, body: JSON.stringify({
    name: '柠檬散糖', sku: 'BUDU-LEMON', transferCode: 'NO.2', salePriceCents: '', costPriceCents: '', unit: '颗',
    isActive: false, transferEnabled: true, partnerSupplyEnabled: false, sortOrder: 1,
    transferBoxEnabled: true, transferBoxWeightGrams: 2500, transferPieceEnabled: true, transferPieceWeightGrams: 6,
  }) }))
  if (productResult.status !== 201) throw new Error(`创建规格商品失败：${productResult.status} ${JSON.stringify(productResult.body)}`)
  const product = productResult.body.product
  if (!product.transferBoxEnabled || product.transferPieceWeightGrams !== 6) throw new Error('商品中心未返回正式包装规格')

  const createTransfer = (items) => fetch(`${origin}/api/v2/transfer-requests`, { method: 'POST', headers, body: JSON.stringify({ fromStoreKey: 'guanshe', toStoreKey: 'tongying', items }) }).then(json)
  const box = await createTransfer([{ itemId: product.productId, name: product.name, category: 'product', boxQuantity: 1, pieceQuantity: 0 }])
  if (box.status !== 200 || box.body.request.items[0].boxQuantity !== 1 || box.body.request.items[0].pieceQuantity !== 0) throw new Error('仅整箱调拨失败')
  const piece = await createTransfer([{ itemId: product.productId, name: product.name, category: 'product', boxQuantity: 0, pieceQuantity: 166 }])
  if (piece.status !== 200 || piece.body.request.items[0].pieceQuantity !== 166) throw new Error('仅散颗调拨失败')
  const mixed = await createTransfer([{ itemId: product.productId, name: '伪造名称不会成为快照', category: 'product', boxQuantity: 1, pieceQuantity: 166 }])
  const mixedItem = mixed.body.request?.items?.[0]
  if (mixed.status !== 200 || mixedItem.productName !== product.name || mixedItem.boxQuantity !== 1 || mixedItem.pieceQuantity !== 166 || mixedItem.estimatedWeightGrams !== 3496) throw new Error(`混合调拨失败：${JSON.stringify(mixed.body)}`)
  const stored = await prisma.transferItem.findMany({ where: { requestId: mixed.body.request.id }, orderBy: { quantityUnit: 'asc' } })
  if (stored.length !== 2 || stored.some((row) => row.quantityUnit === 'legacy') || stored.reduce((sum, row) => sum + row.quantity, 0) !== 167) throw new Error('箱/颗未按两个真实单位行保存')

  const zero = await createTransfer([{ itemId: product.productId, name: product.name, category: 'product', boxQuantity: 0, pieceQuantity: 0 }])
  if (zero.status !== 400) throw new Error('0箱0颗未被拒绝')
  const converted = await createTransfer([{ itemId: product.productId, name: product.name, category: 'product', quantity: 417 }])
  if (converted.status !== 409) throw new Error('规格商品仍允许伪装为总颗数 legacy quantity')

  const legacyProduct = await prisma.inventoryItem.create({ data: { id: 'legacy-product', name: '历史普通商品', category: 'product', transferCode: 'OLD', transferEnabled: true } })
  const legacy = await createTransfer([{ itemId: legacyProduct.id, name: legacyProduct.name, category: 'product', quantity: 3 }])
  if (legacy.status !== 200 || legacy.body.request.items[0].quantity !== 3 || legacy.body.request.items[0].boxQuantity !== undefined) throw new Error('普通商品 legacy quantity 回归失败')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log('TRANSFER BOX PIECE WORKFLOW TEST OK')
