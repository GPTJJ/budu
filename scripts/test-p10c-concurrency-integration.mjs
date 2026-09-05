import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'

if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).pathname !== '/p10c_isolated') {
  throw new Error('P10C_TEST_DATABASE_URL must point to the dedicated p10c_isolated database')
}
process.env.SWEET_CARD_ENABLED = 'true'

const { prisma } = await import('../server/pg.js')
const { sweetCardRouter, retrySweetCardTransaction } = await import('../server/sweet-card.js')
const { tokenHash } = await import('../server/sweet-card-core.js')

const actor = {
  id: 'p10c-principal', role: 'developer', status: 'active',
  permissions: { sweetCardProductionTest: true },
}
const app = express()
app.use(express.json(), (req, _res, next) => { req.user = actor; next() }, sweetCardRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise((resolve) => server.once('listening', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

async function call(orderId, token, requestKey, amountCents = '10') {
  const response = await fetch(`${origin}/pos/orders/${orderId}/sweet-card/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, requestKey, amountCents }),
  })
  return { status: response.status, body: await response.json() }
}

async function seedCard(id, balanceCents) {
  const token = `budu:sc:v1:${id}.p10c-test-only`
  await prisma.sweetCardAccount.create({ data: {
    id: `account-${id}`, publicCardNo: `CARD-${id}`,
    initialAmountCents: balanceCents, balanceCents,
    validityType: 'LONG_TERM', status: 'ACTIVE', carrierType: 'ELECTRONIC', bindingMode: 'NONE',
    credentials: { create: {
      id: `credential-${id}`, publicTokenId: `token-${id}`, tokenHash: tokenHash(token),
      tokenCiphertext: 'test', tokenIv: 'test', tokenTag: 'test', status: 'ACTIVE', carrierType: 'ELECTRONIC',
    } },
    ledger: { create: {
      id: `issue-${id}`, type: 'ISSUE', amountCents: balanceCents,
      balanceAfterCents: balanceCents, requestKey: `issue-${id}`,
    } },
  } })
  return { accountId: `account-${id}`, token, startingBalance: balanceCents }
}

async function seedOrder(id, payableAmount = 10n) {
  await prisma.order.create({ data: {
    id: `order-${id}`, orderNo: `ORDER-${id}`, storeId: 'p10c-store', cashierId: actor.id,
    subtotal: payableAmount, payableAmount, status: 'pending_payment', paymentStatus: 'unpaid',
    checkoutKey: `checkout-${id}`, cartHash: `hash-${id}`,
    items: { create: {
      id: `item-${id}`, productId: 'p10c-product', productNameSnapshot: 'P10C product', skuSnapshot: 'P10C',
      unitPrice: payableAmount, costPriceSnapshot: 0n, quantity: 1,
      lineAmount: payableAmount, actualAmount: payableAmount,
    } },
  } })
  return `order-${id}`
}

async function cardFacts(card) {
  const [account, redemptions, debits] = await Promise.all([
    prisma.sweetCardAccount.findUnique({ where: { id: card.accountId } }),
    prisma.sweetCardRedemption.findMany({ where: { accountId: card.accountId }, include: { items: true } }),
    prisma.sweetCardLedger.findMany({ where: { accountId: card.accountId, type: 'REDEEM' } }),
  ])
  const redeemed = redemptions.reduce((sum, row) => sum + row.amountCents, 0n)
  const debited = debits.reduce((sum, row) => sum - row.amountCents, 0n)
  assert.equal(redeemed, debited)
  assert.equal(card.startingBalance - debited, account.balanceCents)
  assert.ok(account.balanceCents >= 0n)
  assert.ok(debited <= card.startingBalance)
  assert.equal(redemptions.reduce((sum, row) => sum + row.items.reduce((inner, item) => inner + item.redeemedAmountCents, 0n), 0n), redeemed)
  return { account, redemptions, debits, redeemed }
}

test('P10C application retry helper is bounded and P2034-only', async () => {
  const waits = []
  let attempts = 0
  const recovered = await retrySweetCardTransaction(async () => {
    attempts += 1
    if (attempts === 1) throw Object.assign(new Error('conflict'), { code: 'P2034' })
    return 'committed-once'
  }, { wait: async (attempt) => waits.push(attempt) })
  assert.equal(recovered, 'committed-once')
  assert.equal(attempts, 2)
  assert.deepEqual(waits, [1])

  attempts = 0
  await assert.rejects(
    () => retrySweetCardTransaction(async () => {
      attempts += 1
      throw Object.assign(new Error('conflict'), { code: 'P2034' })
    }, { wait: async (attempt) => waits.push(attempt) }),
    (error) => error.status === 409 && /并发冲突/.test(error.message),
  )
  assert.equal(attempts, 3)

  const fatal = Object.assign(new Error('unexpected'), { code: 'P2000' })
  await assert.rejects(() => retrySweetCardTransaction(async () => { throw fatal }), (error) => error === fatal)
})

test('P10C real Prisma concurrency and rollback matrix', async () => {
  await prisma.store.create({ data: { key: 'p10c-store', name: 'P10C isolated store' } })
  await prisma.sweetCardStorePolicy.create({ data: { storeId: 'p10c-store', eligible: true } })
  await prisma.inventoryItem.create({ data: { id: 'p10c-product', name: 'P10C product', salePriceCents: 10n, isActive: true } })

  // A. Ordinary single request.
  const single = await seedCard('single', 10n)
  assert.equal((await call(await seedOrder('single'), single.token, 'request-single')).status, 201)
  assert.equal((await cardFacts(single)).redemptions.length, 1)

  // B. Two intents compete for one available debit: one success, one controlled 409.
  const oneSlot = await seedCard('one-slot', 10n)
  const oneSlotOrders = await Promise.all([seedOrder('one-slot-a'), seedOrder('one-slot-b')])
  const oneSlotResponses = await Promise.all(oneSlotOrders.map((id, index) => call(id, oneSlot.token, `request-one-slot-${index}`)))
  assert.deepEqual(oneSlotResponses.map((row) => row.status).sort(), [201, 409])
  assert.equal(oneSlotResponses.some((row) => row.status === 500), false)
  assert.match(oneSlotResponses.find((row) => row.status === 409).body.error, /余额不足|并发冲突/)
  assert.equal((await cardFacts(oneSlot)).redemptions.length, 1)

  // C. Enough balance for both independent economic intents.
  const twoSlots = await seedCard('two-slots', 20n)
  const twoSlotOrders = await Promise.all([seedOrder('two-slots-a'), seedOrder('two-slots-b')])
  const twoSlotResponses = await Promise.all(twoSlotOrders.map((id, index) => call(id, twoSlots.token, `request-two-slots-${index}`)))
  assert.deepEqual(twoSlotResponses.map((row) => row.status).sort(), [201, 201])
  assert.equal((await cardFacts(twoSlots)).redemptions.length, 2)

  // D. Three intents compete for two available debits.
  const partial = await seedCard('partial', 20n)
  const partialOrders = await Promise.all(['a', 'b', 'c'].map((suffix) => seedOrder(`partial-${suffix}`)))
  const partialResponses = await Promise.all(partialOrders.map((id, index) => call(id, partial.token, `request-partial-${index}`)))
  assert.deepEqual(partialResponses.map((row) => row.status).sort(), [201, 201, 409])
  assert.equal(partialResponses.some((row) => row.status === 500), false)
  assert.equal((await cardFacts(partial)).redemptions.length, 2)

  // F. Concurrent delivery of one request identity replays one committed fact.
  const duplicate = await seedCard('duplicate', 10n)
  const duplicateOrder = await seedOrder('duplicate')
  const duplicateResponses = await Promise.all([
    call(duplicateOrder, duplicate.token, 'request-duplicate'),
    call(duplicateOrder, duplicate.token, 'request-duplicate'),
  ])
  assert.deepEqual(duplicateResponses.map((row) => row.status).sort(), [200, 201])
  assert.equal(duplicateResponses.filter((row) => row.body.reused === false).length, 1)
  assert.equal(duplicateResponses.filter((row) => row.body.reused === true).length, 1)
  assert.equal((await cardFacts(duplicate)).redemptions.length, 1)

  // H. A database failure after account debit-stage rolls the whole transaction back.
  const rollback = await seedCard('rollback', 10n)
  const rollbackOrder = await seedOrder('rollback')
  await prisma.$executeRawUnsafe(`CREATE FUNCTION p10c_force_late_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id = 'account-rollback' THEN RAISE EXCEPTION 'P10C_FORCED_LATE_FAILURE'; END IF;
      RETURN NEW;
    END $$`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER p10c_force_late_failure
      AFTER UPDATE ON sweet_card_accounts
      FOR EACH ROW EXECUTE FUNCTION p10c_force_late_failure()`)
  const failed = await call(rollbackOrder, rollback.token, 'request-rollback')
  assert.equal(failed.status, 500)
  await prisma.$executeRawUnsafe('DROP TRIGGER p10c_force_late_failure ON sweet_card_accounts')
  await prisma.$executeRawUnsafe('DROP FUNCTION p10c_force_late_failure()')
  const rollbackFacts = await cardFacts(rollback)
  assert.equal(rollbackFacts.account.balanceCents, 10n)
  assert.equal(rollbackFacts.redemptions.length, 0)
  assert.equal(rollbackFacts.debits.length, 0)
  const unchangedOrder = await prisma.order.findUnique({ where: { id: rollbackOrder }, include: { items: true } })
  assert.equal(unchangedOrder.status, 'pending_payment')
  assert.equal(unchangedOrder.paymentStatus, 'unpaid')
  assert.equal(unchangedOrder.sweetCardAmount, 0n)
  assert.ok(unchangedOrder.items.every((item) => item.sweetCardRedeemedAmount === 0n))

  console.log(JSON.stringify({
    result: 'P10C_MATRIX_PASS', single: [201], oneSlot: oneSlotResponses.map((row) => row.status),
    twoSlots: twoSlotResponses.map((row) => row.status), partial: partialResponses.map((row) => row.status),
    duplicate: duplicateResponses.map((row) => row.status), forcedLateFailure: 500,
    generic500InContention: false, deltaCents: '0', duplicateEconomicEffect: false,
  }))
})

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
})
