import assert from 'node:assert/strict'
import express from 'express'
if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).pathname !== '/p7c_isolated') throw new Error('Dedicated p7c_isolated database required')
process.env.SWEET_CARD_ENABLED = 'true'
process.env.SWEET_CARD_CREDENTIAL_KEY = 'ab'.repeat(32) // disposable fixture key
const { prisma } = await import('../server/pg.js')
const { sweetCardRouter } = await import('../server/sweet-card.js')
const app = express()
app.use(express.json(), (req, _res, next) => { req.user = { id: 'p7c-principal', role: 'developer', status: 'active', permissions: { sweetCardProductionTest: true } }; next() }, sweetCardRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
async function call(path, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const json = await response.json()
  assert.ok(response.ok, `${path}: HTTP ${response.status}`)
  return json
}
try {
  const issued = await call('/sweet-cards/batches', { name: 'P7C isolated issue', businessPurpose: 'ACCEPTANCE_TEST', cardCount: 1, faceValueCents: '50', validityType: 'LONG_TERM', carrierType: 'ELECTRONIC', bindingMode: 'OPTIONAL', activateNow: true })
  const cardId = issued.cards[0].accountId
  await prisma.member.create({ data: { id: 'p7c-member', name: 'P7C fixture', phone: 'p7c-fixture-only' } })
  const bound = await call(`/sweet-cards/cards/${cardId}/bind`, { memberId: 'p7c-member' })
  assert.equal(bound.binding.memberId, 'p7c-member')
  const queried = await call(`/sweet-cards/cards/${cardId}`)
  assert.equal(queried.card.balanceCents, '50'); assert.equal(queried.card.binding.memberId, 'p7c-member')
  assert.equal(queried.card.ledger.length, 1); assert.equal(queried.card.ledger[0].amountCents, '50')
  await call('/sweet-cards/cards'); await call('/sweet-cards/batches'); await call('/sweet-cards/overview')
  console.log('PASS: Sweet Card issue, bind, detail/list/batch/overview query; decimal string contract')
} finally {
  await new Promise(resolve => server.close(resolve)); await prisma.$disconnect()
}
