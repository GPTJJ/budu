import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'

// This script creates financial fixtures ONLY in its dedicated disposable database.
if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).pathname !== '/p7c_isolated') throw new Error('Dedicated p7c_isolated database required')
process.env.SWEET_CARD_ENABLED = 'true'
const { prisma } = await import('../server/pg.js')
const { sweetCardRouter } = await import('../server/sweet-card.js')
const { tokenHash } = await import('../server/sweet-card-core.js')
const actor = { id: 'p7c-principal', role: 'developer', status: 'active', permissions: { sweetCardProductionTest: true } }
const token = 'budu:sc:v1:p7c-isolated.test-only'
const app = express()
app.use(express.json(), (req, _res, next) => { req.user = actor; next() }, sweetCardRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
async function call(id, key) {
  const response = await fetch(`${base}/pos/orders/${id}/sweet-card/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, amountCents: '10', requestKey: key }) })
  return { status: response.status, body: await response.json() }
}
async function facts(orderId) {
  return {
    order: await prisma.order.findUnique({ where: { id: orderId } }),
    redemption: await prisma.sweetCardRedemption.findUnique({ where: { orderId } }),
    debits: await prisma.sweetCardLedger.findMany({ where: { orderId, type: 'REDEEM' } }),
    items: await prisma.sweetCardRedemptionItem.findMany({ where: { redemption: { orderId } } }),
    account: await prisma.sweetCardAccount.findUnique({ where: { id: 'p7c-account' } }),
    payments: await prisma.payment.count({ where: { orderId } }),
  }
}
function compare(body, committed) {
  for (const [part, fields] of Object.entries({ redemption: ['amountCents', 'eligibleSubtotalCents', 'ineligibleSubtotalCents'], order: ['subtotal', 'discountAmount', 'payableAmount', 'sweetCardAmount'] })) {
    for (const field of fields) {
      assert.equal(typeof body[part][field], 'string', `${part}.${field}`)
      assert.equal(BigInt(body[part][field]), committed[part][field])
    }
    assert.deepEqual(Object.keys(body[part]).sort(), Object.keys(committed[part]).sort())
  }
  assert.equal(typeof body.order.version, 'number')
  assert.equal(typeof body.order.createdAt, 'string')
}

test('P7C real Prisma COMMIT / HTTP serialization / same economic request retry', async () => {
  try {
    assert.equal((await prisma.$queryRawUnsafe('SELECT current_database() AS name'))[0].name, 'p7c_isolated')
    await prisma.store.create({ data: { key: 'p7c-store', name: 'P7C isolated' } })
    await prisma.sweetCardStorePolicy.create({ data: { storeId: 'p7c-store', eligible: true } })
    await prisma.inventoryItem.create({ data: { id: 'p7c-product', name: 'P7C isolated', salePriceCents: 10n, isActive: true } })
    await prisma.sweetCardAccount.create({ data: { id: 'p7c-account', publicCardNo: 'P7C-TEST', initialAmountCents: 50n, balanceCents: 50n, validityType: 'LONG_TERM', status: 'ACTIVE', carrierType: 'ELECTRONIC', bindingMode: 'NONE' } })
    await prisma.sweetCardCredential.create({ data: { id: 'p7c-credential', accountId: 'p7c-account', publicTokenId: 'p7c-token', tokenHash: tokenHash(token), tokenCiphertext: 'test', tokenIv: 'test', tokenTag: 'test', status: 'ACTIVE', carrierType: 'ELECTRONIC' } })
    await prisma.sweetCardLedger.create({ data: { id: 'p7c-issue', accountId: 'p7c-account', type: 'ISSUE', amountCents: 50n, balanceAfterCents: 50n, requestKey: 'p7c-issue-request' } })
    // A large subtotal and matching discount prove lossless serialization without
    // changing the permitted 10-cent economic intent or any production facts.
    const high = 9007199254740993n
    await prisma.order.create({ data: { id: 'p7c-order', orderNo: 'P7C-ORDER', storeId: 'p7c-store', cashierId: actor.id, subtotal: high, discountAmount: high - 10n, payableAmount: 10n, status: 'pending_payment', paymentStatus: 'unpaid', checkoutKey: 'p7c-checkout', cartHash: 'p7c-hash', items: { create: { id: 'p7c-item', productId: 'p7c-product', productNameSnapshot: 'P7C isolated', skuSnapshot: 'P7C', unitPrice: high, costPriceSnapshot: 0n, quantity: 1, lineAmount: high, discountAmount: high - 10n, actualAmount: 10n } } } })
    const first = await call('p7c-order', 'p7c-economic-request')
    const committed = await facts('p7c-order')
    assert.equal(committed.account.balanceCents, 40n)
    assert.equal(committed.debits.length, 1); assert.equal(committed.items.length, 1); assert.equal(committed.payments, 0)
    assert.equal(committed.order.status, 'completed'); assert.equal(committed.order.paymentStatus, 'paid')
    assert.equal(committed.debits[0].amountCents, -10n); assert.equal(committed.items[0].redeemedAmountCents, 10n)
    const replay = await call('p7c-order', 'p7c-economic-request')
    assert.deepEqual(await facts('p7c-order'), committed, 'Retry must have no second economic effect, even after a response failure')
    if (process.env.P7C_EXPECT_BASELINE_FAILURE === '1') {
      assert.equal(first.status, 500); assert.equal(replay.status, 500)
      console.log('BASELINE: COMMIT + HTTP 500 reproduced; same-key retry has no second debit')
      return
    }
    assert.equal(first.status, 201); assert.equal(first.body.reused, false)
    assert.equal(replay.status, 200); assert.equal(replay.body.reused, true)
    compare(first.body, committed); compare(replay.body, committed)
    assert.equal(first.body.order.subtotal, '9007199254740993')
    assert.deepEqual({ ...first.body, reused: true }, replay.body)
    console.log('CANDIDATE: HTTP 201/200; all 7 money fields exact; delta 0; retry exactly once')
  } finally {
    await new Promise(resolve => server.close(resolve))
    await prisma.$disconnect()
  }
})
