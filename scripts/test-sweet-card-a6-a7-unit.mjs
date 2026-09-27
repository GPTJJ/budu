import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  buildSweetCardPresentation,
  renderPhysicalClaimAsset,
  renderSweetCardPresentation,
  SWEET_CARD_PRESENTATION_FIELDS,
} from '../server/sweet-card-presentation.js'
import { resolveSweetCardClaimEntry } from '../server/sweet-card-claim.js'
import { revokeCustomerSession } from '../server/customer-auth.js'

const root = new URL('../', import.meta.url)
const read = path => fs.readFileSync(new URL(path, root), 'utf8')
const baseCard = Object.freeze({
  id: 'internal-card-id', publicCardNo: 'SC2026AABBCCDDEEFF', initialAmountCents: 50000n,
  balanceCents: 49875n, validityType: 'ONE_YEAR', expiresAt: new Date('2027-09-06T00:00:00Z'),
  status: 'ACTIVE', carrierType: 'PHYSICAL', bindingMode: 'OPTIONAL', binding: null,
  recipientLabel: '小布', giftingScenario: '生日快乐',
})

test('A6 carrier presentations share one authoritative economic DTO', () => {
  const physical = buildSweetCardPresentation(baseCard, { carrierType: 'PHYSICAL' })
  const electronic = buildSweetCardPresentation(baseCard, { carrierType: 'ELECTRONIC' })
  assert.equal(physical.currentBalanceDisplay, '¥498.75')
  assert.equal(electronic.currentBalanceDisplay, physical.currentBalanceDisplay)
  assert.notEqual(physical.carrierType, electronic.carrierType)
})

test('A6 template contract is display-only and replaceable', () => {
  const one = buildSweetCardPresentation(baseCard, { designVersion: 'minimal-v2' })
  const two = buildSweetCardPresentation(baseCard, { designVersion: 'campaign-autumn-v1' })
  assert.deepEqual(SWEET_CARD_PRESENTATION_FIELDS, Object.keys(one).filter(key => SWEET_CARD_PRESENTATION_FIELDS.includes(key)))
  assert.equal(one.currentBalanceDisplay, two.currentBalanceDisplay)
  assert.equal(one.maskedCardNo, two.maskedCardNo)
})

test('A6 recipient and campaign fields are escaped and bounded', () => {
  const model = buildSweetCardPresentation(baseCard, { recipientText: '<script>owner</script>', campaignText: 'x'.repeat(500) })
  const svg = renderSweetCardPresentation(model)
  assert.doesNotMatch(svg, /<script>/)
  assert.match(svg, /&lt;script&gt;/)
  assert.equal(model.campaignText.length, 120)
})

test('A6 electronic and physical assets use canonical brand without plaintext secret fields', () => {
  const token = `budu:claim:v1:${'a'.repeat(43)}`
  const qrDataUrl = `data:image/svg+xml;base64,${Buffer.from(`<svg data="${token}"/>`).toString('base64')}`
  const model = buildSweetCardPresentation(baseCard, { carrierType: 'ELECTRONIC', claimAsset: { state: 'ACTIVE' } })
  const electronic = renderSweetCardPresentation(model, { claimQrDataUrl: qrDataUrl })
  const physical = renderPhysicalClaimAsset({ claimQrDataUrl: qrDataUrl, maskedCardNo: model.maskedCardNo, expiresAt: new Date('2026-09-10') })
  for (const asset of [electronic, physical]) {
    assert.match(asset, /data:image\/svg\+xml;base64/)
    assert.doesNotMatch(asset, /internal-card-id|openid|proofHash|AppSecret|budu:sc:v1:/i)
    assert.doesNotMatch(asset, new RegExp(token.replaceAll(':', '\\:')))
  }
})

test('A6 legacy manufacturer contract and POS QR generation remain unchanged', () => {
  const source = read('server/sweet-card.js')
  assert.match(source, /\['cardNo', 'faceValueCents', 'validityType', 'carrierType', 'qrFile'\]/)
  assert.match(source, /QRCode\.toString\(decryptToken\(credential\)/)
  assert.match(source, /legacyCompatibility: 'CARD_NO_LOCATOR_PLUS_SECONDARY_CLAIM'/)
})

test('A6/A7 QR purpose separation is explicit', () => {
  const source = read('server/sweet-card.js')
  assert.match(source, /purpose: 'MINIPROGRAM_CLAIM'/)
  assert.match(source, /await createOfficialClaimCode\(\{ credentialId \}\)/)
  assert.doesNotMatch(source, /QRCode\.toDataURL\(claimEntry/)
  assert.match(read('server/sweet-card-core.js'), /SWEET_CARD_NAMESPACE = 'budu:sc:v1:'/) 
})

test('A7 token-only bootstrap does not enumerate database facts', () => {
  const token = `budu:claim:v1:${'b'.repeat(43)}`
  assert.deepEqual(resolveSweetCardClaimEntry(token), { state: 'PROOF_REQUIRED', proofDelivery: 'SEPARATE_CHANNEL' })
  assert.throws(() => resolveSweetCardClaimEntry('SC20260001'), /CLAIM_CREDENTIAL_INVALID/)
})

test('A7 admin issue requires verified holder and separate proof delivery', () => {
  const source = read('server/sweet-card.js')
  assert.match(source, /holderVerificationConfirmed !== true/)
  assert.match(source, /separateProofDelivery !== true/)
  assert.match(source, /proofDelivery: \{ channel: 'SEPARATE_CHANNEL_REQUIRED'/)
})

test('A7 public resolve and submit have bounded abuse controls and safe logs', () => {
  const source = read('server/sweet-card-claim.js')
  assert.match(source, /claimResolveLimiter/)
  assert.match(source, /claimSubmitLimiter/)
  assert.match(source, /safeRateKey\(req\.ip, rateToken\(req\)\)/)
  assert.match(source, /requestId.*event.*status.*channel/)
  assert.doesNotMatch(source.match(/function securityLog[\s\S]+?\n\}/)[0], /rawToken|rawProof|openId|session_key|AppSecret/)
})

test('A7 logout revokes the server-side session row', async () => {
  let update
  const db = {
    customerSession: {
      findUnique: async () => ({ id: 'session-id', userId: 'user-a', revokedAt: null, expiresAt: new Date(Date.now() + 60_000), user: { role: 'customer', status: 'active' } }),
      update: async args => { update = args; return args },
    },
  }
  const markerKey = 'marker-key-for-a7'
  const { customerAuthInternals } = await import('../server/customer-auth.js')
  const nonce = 'n'.repeat(43)
  const rawToken = `budu:customer-session:v1:${nonce}.${customerAuthInternals.sessionSignature(nonce, markerKey)}`
  assert.deepEqual(await revokeCustomerSession({ rawToken, markerKey, db }), { revoked: true })
  assert.equal(update.where.id, 'session-id')
  assert.ok(update.data.revokedAt instanceof Date)
})
