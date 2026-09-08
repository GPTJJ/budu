import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { createOfficialClaimCode, CLAIM_MINIPROGRAM_PAGE } from '../server/sweet-card-wechat-code.js'
import { claimSceneReference, claimCredentialLookup, resolveSweetCardClaimEntry, resolveSweetCardClaimCredential } from '../server/sweet-card-claim.js'

const id = '37aa9513-7bd4-4975-8878-52644da5712a'
test('scene is a random record reference, not a raw claim or POS secret', () => {
  const scene = claimSceneReference(id)
  assert.equal(scene.length, 32)
  assert.deepEqual(claimCredentialLookup(scene), { id })
  assert.equal(resolveSweetCardClaimEntry(scene).state, 'PROOF_REQUIRED')
  assert.throws(() => claimCredentialLookup('budu:sc:v1:bad'))
  assert.throws(() => claimSceneReference('employee-123'))
})
test('official release code uses actual page and only short scene', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    if (calls.length === 1) return new Response(JSON.stringify({ access_token: 'mock', expires_in: 7200 }))
    return new Response(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(200)]))
  }
  const result = await createOfficialClaimCode({ credentialId: id, config: { enabled: true, mode: 'production', appId: 'unit-official', appSecret: 'unit-only' }, fetchImpl })
  assert.match(result, /^data:image\/png;base64,/)
  assert.match(calls[1].url, /^https:\/\/api.weixin.qq.com\/wxa\/getwxacodeunlimit\?access_token=/)
  assert.deepEqual(calls[1].body, { scene: claimSceneReference(id), page: CLAIM_MINIPROGRAM_PAGE, check_path: true, env_version: 'release', width: 1000, auto_color: false, is_hyaline: false })
})
test('HTTP 200 provider JSON failure is sanitized and never becomes QR image', async () => {
  await assert.rejects(createOfficialClaimCode({ credentialId: id, config: { enabled: true, mode: 'production', appId: 'unit-official', appSecret: 'unit-only' }, fetchImpl: async () => new Response(JSON.stringify({ errcode: 40001, errmsg: 'secret provider payload' })) }), e => e.status === 503 && !e.message.includes('secret provider'))
})
test('official preparation precedes credential reissue and no internal-path QR remains', () => {
  const source = fs.readFileSync(new URL('../server/sweet-card.js', import.meta.url), 'utf8')
  const section = source.slice(source.indexOf('async function generateClaimPresentation'), source.indexOf("sweetCardRouter.post", source.indexOf('async function generateClaimPresentation')))
  assert.ok(section.indexOf('await createOfficialClaimCode') < section.indexOf('await issueSweetCardClaimCredential'))
  assert.ok(!section.includes('QRCode.toDataURL(claimEntry'))
  assert.ok(!section.includes('?claimToken='))
})

test('short reference resolves only with separate proof and rejects revoked/expired assets', async () => {
  const proof = 'budu:claim-proof:v1:' + 'a'.repeat(22)
  const now = new Date()
  const record = { id, proofHash: crypto.createHash('sha256').update(proof).digest('hex'),
    expiresAt: new Date(now.getTime()+60000), revokedAt: null, consumedAt: null,
    account: { publicCardNo: 'SCUNIT1234', initialAmountCents: 10n, batch: { businessPurpose: 'COMMERCIAL' },
      status: 'ACTIVE', carrierType: 'ELECTRONIC', bindingMode: 'REQUIRED', validityType: 'ONE_YEAR' } }
  const db = { sweetCardClaimToken: { findUnique: async ({where}) => { assert.deepEqual(where,{id}); return record } } }
  const input = {rawToken:claimSceneReference(id),rawProof:proof,db,now}
  assert.equal((await resolveSweetCardClaimCredential(input)).faceValueCents,'10')
  await assert.rejects(resolveSweetCardClaimCredential({...input,rawProof:'budu:claim-proof:v1:'+'b'.repeat(22)}))
  record.revokedAt=now
  await assert.rejects(resolveSweetCardClaimCredential(input))
  record.revokedAt=null; record.expiresAt=new Date(0)
  await assert.rejects(resolveSweetCardClaimCredential(input))
})
