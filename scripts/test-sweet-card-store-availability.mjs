import assert from 'node:assert/strict'
import crypto from 'node:crypto'
if (new URL(process.env.DATABASE_URL || '').pathname !== '/budu_sc_availability_isolated') throw Error('ISOLATED_DATABASE_REQUIRED')
process.env.SWEET_CARD_ENABLED = '1'
process.env.XIDAN_SWEET_CARD_COMMERCIAL = '1'
process.env.SWEET_CARD_CREDENTIAL_KEY = '11'.repeat(32)
process.env.JWT_SECRET = 'availability-isolated-only'
const { createApp } = await import('../server/app.js')
const { prisma } = await import('../server/pg.js')
const { signToken } = await import('../server/auth.js')
const { tokenHash } = await import('../server/sweet-card-core.js')
const suffix = crypto.randomUUID().slice(0, 8)
const id = tag => `av-${suffix}-${tag}`
const server = createApp().listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const origin = `http://127.0.0.1:${server.address().port}/api/v2`
const passed = []
const pass = name => { passed.push(name); console.log(`PASS ${name}`) }
const request = async (user, path, method = 'GET', body) => {
  const r = await fetch(origin + path, { method, headers: { Cookie: `budu_token=${signToken(user, process.env.JWT_SECRET)}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const expect = (result, status) => { assert.equal(result.status, status, JSON.stringify(result)); return result.body }
const economic = async () => {
  const [l, a, r, f] = await Promise.all([prisma.sweetCardLedger.aggregate({ _sum: { amountCents: true }, _count: true }), prisma.sweetCardAccount.aggregate({ _sum: { balanceCents: true } }), prisma.sweetCardRedemption.count(), prisma.sweetCardRefund.count()])
  assert.equal(l._sum.amountCents, a._sum.balanceCents)
  return { ledger: String(l._sum.amountCents), balance: String(a._sum.balanceCents), rows: l._count, redemptions: r, refunds: f }
}
try {
  const stores = {}
  for (const [tag, type, active, policy] of [['a','DIRECT',true,true],['b','DIRECT',true,true],['partner','NON_DIRECT',true,true],['inactive','DIRECT',false,true],['new','DIRECT',true,null],['unknown','UNKNOWN',true,true]]) {
    stores[tag] = await prisma.store.create({ data: { key: id(tag), name: id(tag), operationType: type, active } })
    if (policy !== null) await prisma.sweetCardStorePolicy.create({ data: { storeId: id(tag), eligible: policy } })
  }
  const admin = await prisma.user.create({ data: { id: id('admin'), username: id('admin'), passwordHash: 'isolated', role: 'developer' } })
  const staff = await prisma.user.create({ data: { id: id('staff'), username: id('staff'), passwordHash: 'isolated', role: 'staff', storeKeys: Object.values(stores).map(s => s.key), permissions: { modules: { 'store-pos': true }, sweetCardPosRedeem: false, sweetCardProductionTest: false } } })
  const denied = await prisma.user.create({ data: { id: id('denied'), username: id('denied'), passwordHash: 'isolated', role: 'staff', storeKeys: [id('a')], permissions: { modules: { 'store-pos': false } } } })
  const other = await prisma.user.create({ data: { id: id('other'), username: id('other'), passwordHash: 'isolated', role: 'staff', storeKeys: [id('b')], permissions: { modules: { 'store-pos': true } } } })
  const global = async enabled => expect(await request(admin, '/sweet-cards/availability/global', 'PUT', { enabled }), 200)
  const toggle = async (tag, enabled) => expect(await request(admin, `/sweet-cards/availability/stores/${id(tag)}`, 'PUT', { enabled }), 200)
  await global(true)
  const productId = id('product')
  await prisma.inventoryItem.create({ data: { id: productId, name: productId, sku: productId, salePriceCents: 100n, costPriceCents: 0n, isActive: true } })
  const batchId = id('batch'), accountId = id('account'), token = `budu:sc:v1:${suffix}.acceptance-only`
  await prisma.sweetCardBatch.create({ data: { id: batchId, name: id('ACCEPTANCE'), businessPurpose: 'ACCEPTANCE_TEST', faceValueCents: 10000n, cardCount: 1, totalInitialAmountCents: 10000n, validityType: 'LONG_TERM', carrierType: 'ELECTRONIC', bindingMode: 'NONE', createdById: admin.id,
    accounts: { create: { id: accountId, publicCardNo: id('card'), initialAmountCents: 10000n, balanceCents: 10000n, validityType: 'LONG_TERM', status: 'ACTIVE', carrierType: 'ELECTRONIC', bindingMode: 'NONE',
      credentials: { create: { id: id('credential'), publicTokenId: id('token'), tokenHash: tokenHash(token), tokenCiphertext: 'test', tokenIv: 'test', tokenTag: 'test', status: 'ACTIVE', carrierType: 'ELECTRONIC' } },
      ledger: { create: { id: id('issue'), type: 'ISSUE', amountCents: 10000n, balanceAfterCents: 10000n, requestKey: id('issue') } } } } } })
  let sequence = 0
  const order = async (tag = 'a') => {
    const key = id(`order-${++sequence}`)
    // The order fixture uses the production schema; redemption and settlement are real APIs.
    await prisma.order.create({ data: { id: key, orderNo: key, storeId: id(tag), cashierId: staff.id, subtotal: 100n, payableAmount: 100n, status: 'pending_payment', paymentStatus: 'unpaid', checkoutKey: key, cartHash: key,
      items: { create: { id: `${key}-item`, productId, productNameSnapshot: productId, skuSnapshot: productId, unitPrice: 100n, costPriceSnapshot: 0n, quantity: 1, lineAmount: 100n, actualAmount: 100n } } } })
    return key
  }
  const redeem = (key, user = staff, extra = {}, requestKey = `${key}-redeem`) => request(user, `/pos/orders/${key}/sweet-card/redeem`, 'POST', { token, amountCents: '100', requestKey, ...extra })
  const allow = async name => { const key = await order(); expect(await redeem(key), 201); const o = await prisma.order.findUnique({ where: { id: key } }); assert.equal(o.paymentStatus, 'paid'); assert.equal(o.status, 'completed'); pass(name); return key }
  const deny = async (name, tag = 'a', user = staff, extra = {}) => { const key = await order(tag); const before = await economic(); expect(await redeem(key, user, extra), 403); assert.deepEqual(await economic(), before); pass(name) }
  const inspectedOrder = await order()
  const inspected = expect(await request(staff, `/pos/orders/${inspectedOrder}/sweet-card/inspect`, 'POST', { token }), 200)
  assert.equal(inspected.card.maximumRedeemableCents, '100'); pass('POS inspect normal permission ALLOW')
  await prisma.productCategory.create({ data: { id: id('blocked-category'), name: id('blocked-category') } })
  await prisma.sweetCardCategoryPolicy.create({ data: { categoryId: id('blocked-category'), blocked: true } })
  await prisma.inventoryItem.update({ where: { id: productId }, data: { productCategoryId: id('blocked-category') } })
  const blockedBefore = await economic()
  expect(await redeem(await order()), 409)
  assert.deepEqual(await economic(), blockedBefore)
  await prisma.inventoryItem.update({ where: { id: productId }, data: { productCategoryId: null } })
  pass('Product authority and blacklist still DENY with zero effect')
  const first = await allow('A normal POS without legacy permission ALLOW')
  await deny('B no POS DENY', 'a', denied)
  await toggle('a', false); await deny('C store OFF DENY'); await toggle('a', true)
  await prisma.user.update({ where: { id: staff.id }, data: { permissions: { modules: { 'store-pos': false } } } })
  await deny('D revoked current permission DENY')
  await prisma.user.update({ where: { id: staff.id }, data: { permissions: { modules: { 'store-pos': true } } } })
  await allow('E newly granted POS immediately ALLOW')
  await deny('F NON_DIRECT DENY', 'partner'); await deny('inactive DIRECT DENY', 'inactive'); await deny('UNKNOWN DENY', 'unknown')
  await global(false); await deny('G global OFF DENY')
  const refund = async (key, name) => {
    const a = await prisma.sweetCardAccount.findUnique({ where: { id: accountId } })
    const result = expect(await request(staff, `/pos/orders/${key}/refunds`, 'POST', { reason: '隔离环境验收退款', requestKey: `${key}-refund` }), 201)
    assert.equal(result.refund.status, 'completed')
    expect(await request(staff, `/pos/orders/${key}/refunds`, 'POST', { reason: '隔离环境验收退款', requestKey: `${key}-refund` }), 201)
    const after = await prisma.sweetCardAccount.findUnique({ where: { id: accountId } })
    assert.equal(after.balanceCents, a.balanceCents + 100n)
    assert.equal(await prisma.sweetCardLedger.count({ where: { accountId, orderId: key, type: 'REFUND' } }), 1)
    await economic(); pass(name)
  }
  await refund(first, 'H global OFF historical refund exactly once')
  await global(true)
  const history = await allow('historical store-refund setup'); await toggle('a', false)
  await refund(history, 'I store OFF historical refund exactly once')
  await toggle('a', true); await allow('J re-enabled ALLOW')
  await deny('K spoof operator DENY', 'a', staff, { operatorId: admin.id })
  await deny('L spoof store DENY', 'a', staff, { storeId: id('b') })
  await deny('other store scope DENY', 'a', other)
  expect(await request(staff, `/sweet-cards/availability/stores/${id('a')}`, 'PUT', { enabled: false }), 403); pass('M ordinary POS config DENY')
  const adminRoutes = [['POST','/sweet-cards/batches'], ...['activate','void','lost','replace','freeze','bind'].map(action => ['POST', `/sweet-cards/cards/${accountId}/${action}`]), ['PUT','/sweet-cards/availability/global'], ['PUT','/sweet-cards/availability/all-direct'], ['GET','/sweet-cards/availability'], ['PUT','/sweet-cards/rules'], ['GET','/sweet-cards/overview'], ['GET','/sweet-cards/reconciliation'], ['GET','/sweet-cards/audit']]
  for (const [method, path] of adminRoutes) expect(await request(staff, path, method, method === 'GET' ? undefined : {}), 403)
  pass('N management permissions separate')
  await deny('Q new DIRECT missing policy DENY', 'new')
  const frozen = await economic()
  for (const enabled of [true, false]) {
    expect(await request(admin, '/sweet-cards/availability/all-direct', 'PUT', { enabled }), 200)
    for (const tag of ['a', 'b', 'new']) assert.equal((await prisma.sweetCardStorePolicy.findUnique({ where: { storeId: id(tag) } })).eligible, enabled)
    for (const tag of ['partner', 'inactive', 'unknown']) assert.equal((await prisma.sweetCardStorePolicy.findUnique({ where: { storeId: id(tag) } })).eligible, true)
  }
  pass('O/P batch only ACTIVE DIRECT')
  await global(false); await global(true); assert.deepEqual(await economic(), frozen); pass('R toggles leave all financial facts unchanged')
  expect(await request(admin, '/sweet-cards/rules', 'PUT', { eligibleStoreIds: [id('partner')] }), 409)
  expect(await request(admin, `/sweet-cards/availability/stores/${id('partner')}`, 'PUT', { enabled: true }), 403)
  pass('legacy policy bypass blocked')
  await toggle('a', true)
  // Hold the disabling update uncommitted; redemption must wait/retry and DENY once it commits.
  let release, locked
  const ready = new Promise(r => { locked = r }), gate = new Promise(r => { release = r })
  const disabling = prisma.$transaction(async tx => { await tx.sweetCardStorePolicy.update({ where: { storeId: id('a') }, data: { eligible: false } }); locked(); await gate }, { timeout: 10000 })
  await ready
  const concurrentOrder = await order(), beforeRace = await economic()
  const racing = redeem(concurrentOrder)
  await new Promise(r => setTimeout(r, 150)); release(); await disabling
  const raceResult = await racing
  assert.ok([403, 409].includes(raceResult.status), JSON.stringify(raceResult))
  expect(await redeem(concurrentOrder), 403)
  assert.deepEqual(await economic(), beforeRace); pass('concurrent disable controlled DENY without partial effect')
  await toggle('a', true)
  const duplicate = await order()
  const duplicateResults = await Promise.all([redeem(duplicate), redeem(duplicate)])
  assert.deepEqual(duplicateResults.map(r => r.status).sort(), [200,201]); assert.equal(await prisma.sweetCardRedemption.count({ where: { orderId: duplicate } }), 1)
  pass('concurrent duplicate redemption exactly once')
  const audit = await prisma.sweetCardAuditLog.findMany({ where: { actorId: admin.id, action: { startsWith: 'SWEET_CARD_' } } })
  for (const a of audit) { assert.ok(a.createdAt); assert.ok(a.metadata); assert.ok(!JSON.stringify(a.metadata).includes(token)) }
  assert.ok(audit.some(a => a.action === 'SWEET_CARD_GLOBAL_DISABLED')); pass('config audit actor previous/new timestamp no credential')
  console.log(JSON.stringify({ result: 'STORE_AVAILABILITY_MATRIX_PASS', passed, final: await economic() }))
} finally { server.close(); await prisma.$disconnect() }
