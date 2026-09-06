import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { assertDeliveryActivationAllowed, parseYuanAmount } from '../server/sweet-card-core.js'
import {
  buildSweetCardDeliveryState,
  buildSweetCardPresentation,
  renderSweetCardPresentation,
} from '../server/sweet-card-presentation.js'
import {
  hasModuleAccess,
  hasSweetCardCapability,
  MODULE_KEYS,
  SWEET_CARD_CAPABILITIES,
} from '../shared/accountPermissions.js'

const root = new URL('../', import.meta.url)
const read = path => fs.readFileSync(new URL(path, root), 'utf8')
const future = new Date('2026-09-12T00:00:00Z')
const now = new Date('2026-09-07T00:00:00Z')
const baseCard = () => ({
  id: 'internal-card-id', publicCardNo: 'SC2026AABBCCDDEEFF', batchId: 'internal-batch-id',
  initialAmountCents: 50000n, balanceCents: 50000n, validityType: 'ONE_YEAR', status: 'CREATED',
  carrierType: 'ELECTRONIC', bindingMode: 'REQUIRED', binding: null, claim: null, claimTokens: [],
  activatedAt: null, recipientLabel: '林女士', recipientNote: '愿每一天都有一点甜。',
  batch: { name: 'A7.5-验收批次', presentationTemplateKey: 'minimal-v2' },
})

test('A7.5-01 delivery state keeps card, activation, claim, binding and presentation distinct', () => {
  assert.deepEqual(buildSweetCardDeliveryState(baseCard(), now), {
    cardStatus: 'CREATED', activationStatus: 'UNACTIVATED', presentationStatus: 'NOT_GENERATED',
    claimCredentialStatus: 'NONE', claimStatus: 'UNCLAIMED', bindingStatus: 'UNBOUND',
    deliveryStatus: 'NOT_PREPARED', claimedAt: null, claimCredentialExpiresAt: null,
  })
})

test('A7.5-02/06 generation state is derived without creating a second economic fact', () => {
  const card = baseCard()
  const before = { balance: card.balanceCents, initial: card.initialAmountCents }
  card.claimTokens = [{ expiresAt: future, revokedAt: null, consumedAt: null }]
  assert.equal(buildSweetCardDeliveryState(card, now).deliveryStatus, 'GENERATED')
  assert.deepEqual({ balance: card.balanceCents, initial: card.initialAmountCents }, before)
  assert.equal(buildSweetCardDeliveryState(card, now).deliveryStatus, 'GENERATED')
})

test('A7.5-03/10 Claim QR copy and POS QR source remain deliberately separate', () => {
  const source = read('server/sweet-card.js')
  assert.match(source, /pages\/sweet-card-claim\/sweet-card-claim\?claimToken=/)
  assert.match(source, /QRCode\.toString\(decryptToken\(credential\)/)
  assert.doesNotMatch(source.match(/const claimEntry =[^\n]+/)[0], /decryptToken|budu:sc:v1:/)
  const model = buildSweetCardPresentation(baseCard(), { claimAsset: { state: 'ACTIVE' } })
  assert.match(renderSweetCardPresentation(model, { claimQrDataUrl: 'data:image/svg+xml;base64,c2FmZQ==' }), /微信扫码领取甜意卡/)
})

test('A7.5-04/05/11 presentation update cannot write balance or Ledger', () => {
  const source = read('server/sweet-card.js')
  const route = source.match(/sweetCardRouter\.put\('\/sweet-cards\/cards\/:id\/presentation'[\s\S]+?\n\}\)\)/)?.[0] || ''
  assert.match(route, /recipientLabel/)
  assert.match(route, /recipientNote/)
  assert.doesNotMatch(route, /balanceCents|sweetCardLedger|REDEEM|REFUND|Payment|Order/)
  assert.match(route, /economicMutation: false/)
})

test('A7.5-07/08 live state reflects authoritative Claim and Binding rows', () => {
  const card = baseCard()
  card.claimTokens = [{ expiresAt: future, revokedAt: null, consumedAt: future }]
  card.claim = { claimedAt: now }
  card.binding = { boundAt: now }
  const state = buildSweetCardDeliveryState(card, now)
  assert.equal(state.claimStatus, 'CLAIMED')
  assert.equal(state.bindingStatus, 'BOUND')
  assert.equal(state.claimCredentialStatus, 'CONSUMED')
  assert.equal(state.deliveryStatus, 'CLAIMED')
})

test('A7.5-09 revoked credential makes delivery fail closed', () => {
  const card = baseCard()
  card.claimTokens = [{ expiresAt: future, revokedAt: now, consumedAt: null }]
  const state = buildSweetCardDeliveryState(card, now)
  assert.equal(state.claimCredentialStatus, 'REVOKED')
  assert.equal(state.presentationStatus, 'REVOKED')
  assert.equal(state.deliveryStatus, 'REVOKED')
})

test('A7.5-12 template swap changes presentation only', () => {
  const card = baseCard()
  const one = buildSweetCardPresentation(card, { designVersion: 'minimal-v2' })
  const two = buildSweetCardPresentation(card, { designVersion: 'campaign-v1' })
  assert.equal(one.faceValueDisplay, two.faceValueDisplay)
  assert.equal(one.currentBalanceDisplay, two.currentBalanceDisplay)
  assert.notEqual(one.designVersion, two.designVersion)
})

test('A7.5-13 exported image contains no raw identifiers or secret text', () => {
  const model = buildSweetCardPresentation(baseCard(), { claimAsset: { state: 'ACTIVE' } })
  const svg = renderSweetCardPresentation(model, { claimQrDataUrl: 'data:image/svg+xml;base64,c2FmZQ==' })
  assert.doesNotMatch(svg, /internal-card-id|internal-batch-id|openid|AppSecret|session_key|rawProof|budu:sc:v1:/i)
  assert.match(svg, /\*+EEFF/)
})

test('A7.5-14 ordinary POS operator cannot enter Sweet Card issuance management', () => {
  const cashier = { id: 'cashier', role: 'cashier', status: 'active', storeKeys: ['xidan'], permissions: {} }
  assert.equal(hasModuleAccess(cashier, MODULE_KEYS.STORE_POS), true)
  assert.equal(hasModuleAccess(cashier, MODULE_KEYS.SWEET_CARD), false)
  assert.equal(hasSweetCardCapability(cashier, SWEET_CARD_CAPABILITIES.ISSUE), false)
})

test('A7.5-15 yuan input converts exactly to integer cents without floating point', () => {
  assert.equal(parseYuanAmount('500.00'), 50000n)
  assert.equal(parseYuanAmount('0.01'), 1n)
  assert.equal(parseYuanAmount('99999.99'), 9999999n)
  assert.throws(() => parseYuanAmount('0.001'), /不正确/)
  assert.throws(() => parseYuanAmount('100000.01'), /安全范围/)
})

test('A7.5-16/17/18 Chinese labels, manufacturer export and A1-A7 contracts remain wired', () => {
  const labels = read('src/utils/sweetCardLabels.js')
  const source = read('server/sweet-card.js')
  assert.match(labels, /UNACTIVATED: '未激活'/)
  assert.match(labels, /ACTIVE: '有效'/)
  assert.match(labels, /ISSUE: '发卡'/)
  assert.match(source, /\['cardNo', 'faceValueCents', 'validityType', 'carrierType', 'qrFile'\]/)
  assert.match(source, /holderVerificationConfirmed !== true/)
  assert.match(source, /reissueConfirmed !== true/)
  assert.equal(assertDeliveryActivationAllowed({ carrierType: 'ELECTRONIC', claimTokens: [{ expiresAt: future, revokedAt: null, consumedAt: null }] }, now), true)
  assert.throws(() => assertDeliveryActivationAllowed({ carrierType: 'ELECTRONIC', claimTokens: [] }, now), /请先生成有效的微信领取凭证/)
  assert.throws(() => assertDeliveryActivationAllowed({ carrierType: 'PHYSICAL', claimTokens: [{ expiresAt: future }] }, now), /仅电子卡/)
})
