import test from 'node:test'
import assert from 'node:assert/strict'
import { buildClaimAssetEligibility } from '../server/sweet-card-presentation.js'
import { sweetCardClaimPresentationEnabled } from '../server/sweet-card.js'
import { supportsSweetCardClaim } from '../server/sweet-card-claim-eligibility.js'
import { hasSweetCardCapability, SWEET_CARD_CAPABILITIES } from '../shared/accountPermissions.js'
const base = { status: 'ACTIVE', batch: { businessPurpose: 'COMMERCIAL' } }
test('generation allows both canonical purposes and denies missing or unknown purpose', () => {
  for (const purpose of ['ACCEPTANCE_TEST', 'COMMERCIAL']) {
    assert.equal(supportsSweetCardClaim(purpose), true)
    assert.equal(buildClaimAssetEligibility({ ...base, batch: { businessPurpose: purpose } }, { claimPresentationEnabled: true, canIssue: true }).claimAssetEligible, true)
  }
  for (const purpose of [null, undefined, 'commercial', 'TEST', '']) assert.equal(supportsSweetCardClaim(purpose), false)
})
test('generation still requires management capability, status, expiry and no ownership', () => {
  for (const role of ['customer', 'staff']) {
    const user = { role, permissions: { 'store-pos': true }, storeKeys: ['xidan'] }
    assert.equal(hasSweetCardCapability(user, SWEET_CARD_CAPABILITIES.ISSUE), false)
  }
  assert.equal(hasSweetCardCapability({ role: 'admin' }, SWEET_CARD_CAPABILITIES.ISSUE), true)
  for (const card of [{ ...base, status: 'FROZEN' }, { ...base, status: 'LOST' }, { ...base, status: 'EXPIRED' }, { ...base, expiresAt: new Date(0) }, { ...base, claim: {} }, { ...base, binding: {} }]) {
    assert.equal(buildClaimAssetEligibility(card, { claimPresentationEnabled: true, canIssue: true }).claimAssetEligible, false)
  }
  assert.equal(buildClaimAssetEligibility(base, { claimPresentationEnabled: true, canIssue: false }).claimAssetEligible, false)
  assert.equal(buildClaimAssetEligibility(base, { canIssue: true }).claimAssetEligible, false)
})
test('public generation needs enabled signed gateway and explicit public flag; controlled mode remains available', () => {
  const env = { APP_ENV: 'prod', SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED: '1', SWEET_CARD_PRODUCTION_GATEWAY_ENABLED: '1', SWEET_CARD_MINIPROGRAM_CLAIM_ALLOWLIST_ONLY: '0' }
  assert.equal(sweetCardClaimPresentationEnabled(env), true)
  assert.equal(sweetCardClaimPresentationEnabled({ ...env, SWEET_CARD_PRODUCTION_GATEWAY_ENABLED: '0' }), false)
  assert.equal(sweetCardClaimPresentationEnabled({ ...env, SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED: '0' }), false)
  for (const flag of ['1', '', 'false', 'typo', undefined]) assert.equal(sweetCardClaimPresentationEnabled({ ...env, SWEET_CARD_MINIPROGRAM_CLAIM_ALLOWLIST_ONLY: flag }), false)
  assert.equal(sweetCardClaimPresentationEnabled({ ...env, SWEET_CARD_MINIPROGRAM_CLAIM_ALLOWLIST_ONLY: '1', SWEET_CARD_MINIPROGRAM_CLAIM_USER_IDS: 'operator' }), true)
})
