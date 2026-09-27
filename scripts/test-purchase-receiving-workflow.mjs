import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

for (const key of ['WECHAT_WORK_WEBHOOK_URL', 'WXWORK_CORP_ID', 'WXWORK_AGENT_ID', 'WXWORK_SECRET']) delete process.env[key]

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-purchase-receiving-'))
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = await createDisposablePgSchema('purchase_receiving')

const { createApp } = await import('../server/app.js')
const { prisma } = await import('../server/pg.js')
const server = createApp().listen(0)

const jsonHeaders = (cookie) => ({ 'Content-Type': 'application/json', Cookie: cookie })

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const register = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'purchase-manager', password: '123456' }),
  })
  if (!register.ok) throw new Error(`测试账号创建失败：${register.status} ${await register.text()}`)
  const cookie = register.headers.get('set-cookie')?.split(';')[0]
  await prisma.store.create({ data: { key: 'tongying', name: '北京通盈中心店' } })
  await prisma.inventoryItem.createMany({
    data: [
      { id: 'purchase-product', name: 'NO.2柠檬', category: 'product', unit: '颗' },
      { id: 'purchase-material', name: '保温袋', category: 'material', unit: '件' },
    ],
  })

  const supplierResponse = await fetch(`${base}/v2/suppliers`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ name: '采购测试供应商', contact: '测试联系人' }),
  })
  if (!supplierResponse.ok) throw new Error(`供应商创建失败：${supplierResponse.status} ${await supplierResponse.text()}`)
  const supplier = (await supplierResponse.json()).supplier

  const createPurchase = async (suffix, items) => {
    const response = await fetch(`${base}/v2/purchase-requests`, {
      method: 'POST',
      headers: jsonHeaders(cookie),
      body: JSON.stringify({
        storeKey: 'tongying',
        supplierId: supplier.id,
        expectedAt: '2026-09-01',
        note: `采购测试-${suffix}`,
        items,
      }),
    })
    if (!response.ok) throw new Error(`采购申请创建失败：${response.status} ${await response.text()}`)
    return (await response.json()).request
  }

  const purchase = await createPurchase('atomic', [
    { name: 'NO.2柠檬', category: 'product', quantity: 2, note: '产品' },
    { name: '保温袋', category: 'material', quantity: 5, note: '物料' },
    { name: '临时展示架', category: 'other', quantity: 1, note: '其他' },
  ])
  if (purchase.supplier !== supplier.name || !purchase.expectedAt) throw new Error('供应商或预计到货日期未进入采购读取合同')
  if (purchase.items.find((row) => row.itemId === 'purchase-product')?.unit !== '颗') throw new Error('产品真实单位未返回')
  if (purchase.items.find((row) => row.itemId === 'purchase-material')?.unit !== '件') throw new Error('物料真实单位未返回')
  const other = await prisma.inventoryItem.findUnique({ where: { name: '临时展示架' } })
  if (other?.category !== 'other') throw new Error('其他采购货品未保留 InventoryItem 分类权威')

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION fail_test_purchase_ledger() RETURNS trigger AS $body$
    BEGIN
      IF NEW.type = 'purchase_in' AND NEW."refId" = '${purchase.id}' THEN
        RAISE EXCEPTION 'forced purchase ledger failure';
      END IF;
      RETURN NEW;
    END;
    $body$ LANGUAGE plpgsql
  `)
  await prisma.$executeRawUnsafe('CREATE TRIGGER fail_test_purchase_ledger_trigger BEFORE INSERT ON "StockLedger" FOR EACH ROW EXECUTE FUNCTION fail_test_purchase_ledger()')

  const receiveBody = {
    items: purchase.items.map((row) => ({ itemId: row.itemId, receivedQty: row.quantity })),
  }
  const failedReceive = await fetch(`${base}/v2/purchase-requests/${purchase.id}/receive`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify(receiveBody),
  })
  const failedPayload = await failedReceive.json()
  if (failedReceive.status !== 500 || failedPayload.error !== '收货入库失败，库存未发生变化，请稍后重试。') throw new Error(`入库异常未返回安全业务错误：${failedReceive.status} ${JSON.stringify(failedPayload)}`)
  if (/prisma|stockledger|forced|sql/i.test(failedPayload.error)) throw new Error('入库异常向业务用户泄露了内部错误')

  const failedState = await prisma.purchaseRequest.findUnique({ where: { id: purchase.id }, include: { items: true } })
  if (failedState.status !== 'pending' || failedState.items.some((row) => row.receivedQty !== 0)) throw new Error('StockLedger 失败后采购状态或实收数量未回滚')
  if (await prisma.stockBalance.count() !== 0 || await prisma.stockLedger.count() !== 0) throw new Error('StockLedger 失败后库存余额或流水未回滚')

  await prisma.$executeRawUnsafe('DROP TRIGGER fail_test_purchase_ledger_trigger ON "StockLedger"')
  await prisma.$executeRawUnsafe('DROP FUNCTION fail_test_purchase_ledger()')

  const success = await fetch(`${base}/v2/purchase-requests/${purchase.id}/receive`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify(receiveBody),
  })
  if (!success.ok) throw new Error(`收货入库失败：${success.status} ${await success.text()}`)
  const receivedState = await prisma.purchaseRequest.findUnique({ where: { id: purchase.id }, include: { items: true } })
  if (receivedState.status !== 'received' || receivedState.items.some((row) => row.receivedQty !== row.orderedQty)) throw new Error('采购单或明细未进入已收货状态')
  const balances = await prisma.stockBalance.findMany({ where: { storeKey: 'tongying' } })
  const balanceByItem = Object.fromEntries(balances.map((row) => [row.itemId, row.quantity]))
  if (balanceByItem['purchase-product'] !== 2 || balanceByItem['purchase-material'] !== 5 || balanceByItem[other.id] !== 1) throw new Error('StockBalance 未按实收数量增加')
  const ledgers = await prisma.stockLedger.findMany({ where: { refId: purchase.id }, orderBy: { itemId: 'asc' } })
  if (ledgers.length !== 3 || ledgers.some((row) => row.type !== 'purchase_in' || row.change !== balanceByItem[row.itemId] || row.balance !== balanceByItem[row.itemId])) throw new Error('StockLedger 事实不完整或余额快照错误')

  const beforeDuplicate = { balances: await prisma.stockBalance.count(), ledgers: await prisma.stockLedger.count() }
  const duplicate = await fetch(`${base}/v2/purchase-requests/${purchase.id}/receive`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify(receiveBody),
  })
  if (duplicate.status !== 409 || !(await duplicate.text()).includes('已入库')) throw new Error('重复收货未按业务状态拒绝')
  if (await prisma.stockBalance.count() !== beforeDuplicate.balances || await prisma.stockLedger.count() !== beforeDuplicate.ledgers) throw new Error('重复收货产生了新库存事实')

  const concurrentPurchase = await createPurchase('concurrent', [
    { name: 'NO.2柠檬', category: 'product', quantity: 4 },
  ])
  const concurrentResponses = await Promise.all([1, 2].map(() => fetch(`${base}/v2/purchase-requests/${concurrentPurchase.id}/receive`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ items: [{ itemId: 'purchase-product', receivedQty: 4 }] }),
  })))
  const statuses = concurrentResponses.map((response) => response.status).sort()
  if (statuses[0] !== 200 || statuses[1] !== 409) throw new Error(`并发收货未保证单次成功：${statuses.join(',')}`)
  const concurrentBalance = await prisma.stockBalance.findUnique({ where: { storeKey_itemId: { storeKey: 'tongying', itemId: 'purchase-product' } } })
  if (concurrentBalance.quantity !== 6) throw new Error('并发收货重复增加或丢失库存')
  if (await prisma.stockLedger.count({ where: { refId: concurrentPurchase.id } }) !== 1) throw new Error('并发收货产生重复 StockLedger')

  const list = await fetch(`${base}/v2/purchase-requests`, { headers: { Cookie: cookie } }).then((response) => response.json())
  const listed = list.rows.find((row) => row.id === purchase.id)
  if (listed?.supplier !== supplier.name || listed?.storeName !== '北京通盈中心店' || listed?.items.length !== 3) throw new Error('采购列表缺少供应商、门店或商品摘要')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log('PURCHASE RECEIVING WORKFLOW TEST OK')
