import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-partner-supply-'))
process.env.DATA_DIR = dataDir
process.env.DATABASE_URL = await createDisposablePgSchema('partner_supply')
const { createApp } = await import('../server/app.js')
const { prisma } = await import('../server/pg.js')
const { ensureNotificationTemplates } = await import('../server/notification-center.js')
const server = createApp().listen(0)

const jsonHeaders = (cookie) => ({ 'Content-Type': 'application/json', Cookie: cookie })

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const register = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'partner-admin', password: '123456' }) })
  if (!register.ok) throw new Error(`注册失败：${register.status} ${await register.text()}`)
  const cookie = register.headers.get('set-cookie')?.split(';')[0]
  const me = (await register.json()).user
  await prisma.store.createMany({ data: [{ key: 'guanshe', name: '北京官舍店' }, { key: 'tongying', name: '北京通盈中心店' }] })
  await prisma.user.update({ where: { id: me.id }, data: { storeKeys: ['guanshe'] } })
  await ensureNotificationTemplates()

  const categoryResponse = await fetch(`${base}/v2/product-categories`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ name: '糖果', sortOrder: 1, isActive: true }) })
  if (!categoryResponse.ok) throw new Error(`产品分类创建失败：${categoryResponse.status} ${await categoryResponse.text()}`)
  const category = (await categoryResponse.json()).category
  const productResponse = await fetch(`${base}/v2/transfer-master-items`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ category: 'product', code: 'NO.1', name: 'NO.1树莓', productCategoryId: category.id, sortOrder: 1, enabled: true }) })
  if (!productResponse.ok) throw new Error(`产品创建失败：${productResponse.status} ${await productResponse.text()}`)
  const product = (await productResponse.json()).item
  await prisma.inventoryItem.update({ where: { id: product.id }, data: { salePriceCents: 500n, isActive: true } })

  const partnerResponse = await fetch(`${base}/v2/partners`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ name: '秦皇岛合作商', contactName: '合作联系人', contactPhone: '13800000000', defaultStoreKey: 'guanshe', defaultDiscountBps: 6500, isActive: true, note: '真实合作商资料' }) })
  if (!partnerResponse.ok) throw new Error(`合作商创建失败：${partnerResponse.status} ${await partnerResponse.text()}`)
  let partner = (await partnerResponse.json()).partner
  if (partner.defaultStoreKey !== 'guanshe' || partner.defaultDiscountBps !== 6500) throw new Error('合作商默认门店或折扣未保存')

  const stockBefore = await Promise.all([prisma.stockBalance.count(), prisma.stockLedger.count()])
  const createOrder = async (businessDate = '2026-08-20') => fetch(`${base}/v2/partner-supply-orders`, {
    method: 'POST', headers: jsonHeaders(cookie),
    body: JSON.stringify({ partnerId: partner.id, fromStoreKey: 'guanshe', businessDate, effectiveDiscountBps: 6500, note: '微信群订单', items: [{ productId: product.id, quantity: 100 }] }),
  })
  const orderResponse = await createOrder()
  if (!orderResponse.ok) throw new Error(`供货单创建失败：${orderResponse.status} ${await orderResponse.text()}`)
  let order = (await orderResponse.json()).order
  const item = order.items[0]
  if (order.status !== 'pending' || order.totalAmountCents !== '32500' || item.retailPriceCents !== '500' || item.discountBps !== 6500 || item.partnerUnitPriceCents !== '325' || item.subtotalCents !== '32500') throw new Error('价格冻结或整数金额计算错误')
  if (item.productCode !== 'NO.1' || item.productName !== 'NO.1树莓' || item.productCategory !== '糖果') throw new Error('产品身份或分类快照缺失')
  if (!order.createdById || order.createdBy !== 'partner-admin') throw new Error('创建人稳定身份审计缺失')
  if (await prisma.notification.count({ where: { templateKey: 'partner_supply_new', refId: order.id } }) < 1) throw new Error('新供货单未通知发货门店处理人员')

  await prisma.inventoryItem.update({ where: { id: product.id }, data: { name: 'NO.1树莓新版', salePriceCents: 600n } })
  const partnerEdit = await fetch(`${base}/v2/partners/${partner.id}`, { method: 'PUT', headers: jsonHeaders(cookie), body: JSON.stringify({ ...partner, defaultDiscountBps: 7000 }) })
  if (!partnerEdit.ok) throw new Error(`合作商折扣编辑失败：${partnerEdit.status} ${await partnerEdit.text()}`)
  partner = (await partnerEdit.json()).partner
  const readFrozen = await fetch(`${base}/v2/partner-supply-orders?start=2026-08-01&end=2026-08-31`, { headers: { Cookie: cookie } }).then((response) => response.json())
  order = readFrozen.rows.find((row) => row.id === order.id)
  if (order.totalAmountCents !== '32500' || order.items[0].productName !== 'NO.1树莓' || order.items[0].retailPriceCents !== '500' || order.effectiveDiscountBps !== 6500) throw new Error('主数据变化改写了历史供货金额或快照')

  const firstReceipt = await fetch(`${base}/v2/partner-supply-orders/${order.id}/receipts`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ amountCents: '20000', receivedDate: '2026-08-29', note: '微信首款' }) })
  if (!firstReceipt.ok) throw new Error(`首笔收款失败：${firstReceipt.status} ${await firstReceipt.text()}`)
  order = (await firstReceipt.json()).order
  if (order.paymentStatus !== 'partial' || order.receivedAmountCents !== '20000' || order.outstandingAmountCents !== '12500') throw new Error('部分收款汇总错误')
  const firstReceiptId = order.receipts.find((receipt) => receipt.status === 'active').id
  const overpay = await fetch(`${base}/v2/partner-supply-orders/${order.id}/receipts`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ amountCents: '12501', receivedDate: '2026-08-29' }) })
  if (overpay.status !== 409) throw new Error('系统允许已收款超过应收款')
  const voidResponse = await fetch(`${base}/v2/partner-receipts/${firstReceiptId}/void`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ reason: '金额录入错误' }) })
  if (!voidResponse.ok || (await voidResponse.json()).receipt.status !== 'voided') throw new Error('收款作废未保留审计状态')

  const concurrent = await Promise.all([15000, 15000].map((amount) => fetch(`${base}/v2/partner-supply-orders/${order.id}/receipts`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ amountCents: String(amount), receivedDate: '2026-08-29', note: '并发收款' }) })))
  if (concurrent.filter((response) => response.status === 201).length !== 1 || concurrent.filter((response) => response.status === 409).length !== 1) throw new Error('并发收款没有阻止累计溢收')
  const finalReceipt = await fetch(`${base}/v2/partner-supply-orders/${order.id}/receipts`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ amountCents: '17500', receivedDate: '2026-08-29', note: '尾款' }) })
  if (!finalReceipt.ok) throw new Error(`尾款登记失败：${finalReceipt.status} ${await finalReceipt.text()}`)
  order = (await finalReceipt.json()).order
  if (order.paymentStatus !== 'settled' || order.receivedAmountCents !== '32500' || order.receipts.filter((receipt) => receipt.status === 'active').length !== 2 || order.receipts.filter((receipt) => receipt.status === 'voided').length !== 1) throw new Error('多笔收款、结清或作废追溯错误')

  const report = await fetch(`${base}/v2/partner-supply-report?start=2026-08-29&end=2026-08-29&partnerId=${partner.id}`, { headers: { Cookie: cookie } }).then((response) => response.json())
  if (report.orders.length !== 0 || report.receipts.length !== 2 || report.summary[0]?.receivedAmountCents !== '32500') throw new Error('供货业务日期与实际收款日期口径混淆')

  const ship = await fetch(`${base}/v2/partner-supply-orders/${order.id}/ship`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ version: order.version }) })
  if (!ship.ok) throw new Error(`确认发货失败：${ship.status} ${await ship.text()}`)
  order = (await ship.json()).order
  if (order.status !== 'shipped' || order.shippedBy !== 'partner-admin' || !order.shippedById || !order.shippedAt) throw new Error('发货审计事实缺失')
  const withdrawShipped = await fetch(`${base}/v2/partner-supply-orders/${order.id}/withdraw`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ version: order.version }) })
  if (withdrawShipped.status !== 409) throw new Error('已发货供货单可被撤回')

  const secondOrderResponse = await createOrder('2026-08-21')
  if (!secondOrderResponse.ok) throw new Error(`待撤回供货单创建失败：${secondOrderResponse.status} ${await secondOrderResponse.text()}`)
  const secondOrder = (await secondOrderResponse.json()).order
  const withdraw = await fetch(`${base}/v2/partner-supply-orders/${secondOrder.id}/withdraw`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ version: secondOrder.version }) })
  const withdrawnOrder = (await withdraw.json()).order
  if (!withdraw.ok || withdrawnOrder.status !== 'withdrawn' || withdrawnOrder.paymentStatus !== 'void' || withdrawnOrder.outstandingAmountCents !== '0') throw new Error('待备货撤回失败、记录被删除或仍被计作应收')

  const disablePartner = await fetch(`${base}/v2/partners/${partner.id}`, { method: 'PUT', headers: jsonHeaders(cookie), body: JSON.stringify({ ...partner, isActive: false }) })
  if (!disablePartner.ok) throw new Error('合作商停用失败')
  partner = (await disablePartner.json()).partner
  const disabledPartnerCreate = await createOrder('2026-08-22')
  if (disabledPartnerCreate.status !== 409) throw new Error('停用合作商仍可创建新供货单')
  const enablePartner = await fetch(`${base}/v2/partners/${partner.id}`, { method: 'PUT', headers: jsonHeaders(cookie), body: JSON.stringify({ ...partner, isActive: true }) })
  partner = (await enablePartner.json()).partner
  await prisma.inventoryItem.update({ where: { id: product.id }, data: { transferEnabled: false } })
  const disabledProductCreate = await createOrder('2026-08-23')
  if (disabledProductCreate.status !== 409) throw new Error('停用产品仍可创建新供货单')
  const activeProducts = await fetch(`${base}/v2/partner-supply-products`, { headers: { Cookie: cookie } }).then((response) => response.json())
  if (activeProducts.rows.some((row) => row.id === product.id)) throw new Error('停用产品仍出现在合作商选货列表')

  const historical = await fetch(`${base}/v2/partner-supply-orders?start=2026-08-01&end=2026-08-31`, { headers: { Cookie: cookie } }).then((response) => response.json())
  if (!historical.rows.some((row) => row.id === order.id && row.status === 'shipped' && row.items[0].productName === 'NO.1树莓')) throw new Error('停用主数据后历史供货记录不可追溯')
  const stockAfter = await Promise.all([prisma.stockBalance.count(), prisma.stockLedger.count()])
  if (JSON.stringify(stockAfter) !== JSON.stringify(stockBefore)) throw new Error('合作商供货错误修改了实时库存或库存流水')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log('PARTNER SUPPLY WORKFLOW TEST OK')
