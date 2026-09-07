import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  createCustomerPosRedemptionPresentation,
  resolveSweetCardClaimEntry,
} from '../server/sweet-card-claim.js'
import { isSweetCardToken, newCredential } from '../server/sweet-card-core.js'

process.env.SWEET_CARD_CREDENTIAL_KEY = '31'.repeat(32)

const ownerId = 'customer-owner-id'
const walletRef = '11111111-2222-3333-4444-555555555555'
const now = new Date('2026-09-07T12:00:00.000Z')

function fixture(overrides = {}) {
  const generated = newCredential()
  const account = {
    id: 'account-pos-presentation',
    publicCardNo: 'SC2026POSPRESENT',
    status: 'ACTIVE',
    balanceCents: 5000n,
    bindingMode: 'REQUIRED',
    validFrom: new Date('2026-09-01T00:00:00.000Z'),
    expiresAt: new Date('2027-09-01T00:00:00.000Z'),
    binding: { userId: ownerId },
    credentials: [{
      id: 'credential-pos', status: 'ACTIVE', revokedAt: null, createdAt: now,
      tokenCiphertext: generated.ciphertext, tokenIv: generated.iv, tokenTag: generated.tag,
    }],
    ...overrides,
  }
  let availableStoreCount = 1
  const db = {
    sweetCardClaim: {
      findFirst: async ({ where }) => where.id === walletRef && where.userId === ownerId
        ? { id: walletRef, userId: ownerId, account }
        : null,
    },
    store: { count: async () => availableStoreCount },
  }
  return {
    account,
    db,
    generated,
    setAvailableStoreCount(value) { availableStoreCount = value },
  }
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error => error?.message === code)
}

test('owned active card returns an image-only POS redemption presentation', async () => {
  const { db, generated } = fixture()
  let renderedToken = ''
  const result = await createCustomerPosRedemptionPresentation({
    userId: ownerId, walletRef, db, now,
    renderQr: async token => {
      renderedToken = token
      return 'data:image/png;base64,cG9zLXByZXNlbnRhdGlvbg=='
    },
  })
  assert.equal(renderedToken, generated.token)
  assert.equal(isSweetCardToken(renderedToken), true)
  assert.equal(result.purpose, 'POS_REDEMPTION')
  assert.equal(result.balanceCents, '5000')
  assert.equal(result.qrImageDataUrl, 'data:image/png;base64,cG9zLXByZXNlbnRhdGlvbg==')
  assert.doesNotMatch(JSON.stringify(result), /budu:sc:v1:|credential-pos|tokenCiphertext|tokenIv|tokenTag/)
})

test('the default renderer produces a PNG data URL without returning the credential text', async () => {
  const { db } = fixture()
  const result = await createCustomerPosRedemptionPresentation({ userId: ownerId, walletRef, db, now })
  assert.match(result.qrImageDataUrl, /^data:image\/png;base64,/)
  assert.doesNotMatch(JSON.stringify(result), /budu:sc:v1:/)
})

test('another customer cannot request the card presentation', async () => {
  const { db } = fixture()
  await expectCode(createCustomerPosRedemptionPresentation({
    userId: 'different-customer', walletRef, db, now,
  }), 'SWEET_CARD_NOT_FOUND')
})

test('binding ownership remains a second server-side ownership guard', async () => {
  const { db } = fixture({ binding: { userId: 'different-customer' } })
  await expectCode(createCustomerPosRedemptionPresentation({ userId: ownerId, walletRef, db, now }), 'SWEET_CARD_OWNERSHIP_DENIED')
  const unbound = fixture({ binding: null })
  await expectCode(createCustomerPosRedemptionPresentation({ userId: ownerId, walletRef, db: unbound.db, now }), 'SWEET_CARD_BINDING_REQUIRED')
})

test('FROZEN LOST EXPIRED EXHAUSTED and CREATED cards are denied before QR rendering', async () => {
  for (const status of ['FROZEN', 'LOST', 'EXPIRED', 'EXHAUSTED', 'CREATED']) {
    const { db } = fixture({ status })
    await expectCode(createCustomerPosRedemptionPresentation({ userId: ownerId, walletRef, db, now }), 'POS_PRESENTATION_CARD_UNAVAILABLE')
  }
})

test('balance validity store availability and active credential all fail closed', async () => {
  const empty = fixture({ balanceCents: 0n })
  await expectCode(createCustomerPosRedemptionPresentation({ userId: ownerId, walletRef, db: empty.db, now }), 'POS_PRESENTATION_BALANCE_EMPTY')
  const expired = fixture({ expiresAt: new Date('2026-09-07T11:59:59.000Z') })
  await expectCode(createCustomerPosRedemptionPresentation({ userId: ownerId, walletRef, db: expired.db, now }), 'POS_PRESENTATION_CARD_EXPIRED')
  const future = fixture({ validFrom: new Date('2026-09-07T12:00:01.000Z') })
  await expectCode(createCustomerPosRedemptionPresentation({ userId: ownerId, walletRef, db: future.db, now }), 'POS_PRESENTATION_CARD_NOT_ACTIVE')
  const noStore = fixture(); noStore.setAvailableStoreCount(0)
  await expectCode(createCustomerPosRedemptionPresentation({ userId: ownerId, walletRef, db: noStore.db, now }), 'POS_PRESENTATION_NO_AVAILABLE_STORE')
  const noCredential = fixture({ credentials: [] })
  await expectCode(createCustomerPosRedemptionPresentation({ userId: ownerId, walletRef, db: noCredential.db, now }), 'POS_PRESENTATION_CREDENTIAL_UNAVAILABLE')
})

test('credential and QR rendering failures expose only stable public error codes', async () => {
  const corrupt = fixture({ credentials: [{
    id: 'credential-corrupt', status: 'ACTIVE', revokedAt: null, createdAt: now,
    tokenCiphertext: 'bad', tokenIv: 'bad', tokenTag: 'bad',
  }] })
  await expectCode(createCustomerPosRedemptionPresentation({ userId: ownerId, walletRef, db: corrupt.db, now }), 'POS_PRESENTATION_CREDENTIAL_UNAVAILABLE')
  const valid = fixture()
  await expectCode(createCustomerPosRedemptionPresentation({
    userId: ownerId, walletRef, db: valid.db, now,
    renderQr: async () => { throw new Error('renderer-internal-detail') },
  }), 'POS_PRESENTATION_RENDER_FAILED')
})

test('Claim QR and POS Redemption QR remain protocol-separated', () => {
  const { generated } = fixture()
  assert.equal(isSweetCardToken('budu:claim:v1:' + 'a'.repeat(43)), false)
  assert.throws(() => resolveSweetCardClaimEntry(generated.token), error => error?.message === 'CLAIM_CREDENTIAL_INVALID')
})

test('presentation adds no economic writer and POS still owns redemption idempotency', async () => {
  const { db } = fixture()
  await createCustomerPosRedemptionPresentation({ userId: ownerId, walletRef, db, now })
  assert.equal('sweetCardLedger' in db, false)
  assert.equal('sweetCardRedemption' in db, false)
  assert.equal('sweetCardAccount' in db, false)
  const source = fs.readFileSync(new URL('../server/sweet-card.js', import.meta.url), 'utf8')
  assert.match(source, /sweetCardRouter\.post\('\/pos\/orders\/:id\/sweet-card\/redeem'/)
  assert.match(source, /sweetCardRedemption\.findUnique\(\{ where: \{ requestKey:/)
  assert.match(source, /sweetCardLedger\.create/)
  assert.match(source, /retrySweetCardTransaction\(runTransaction\)/)
})
