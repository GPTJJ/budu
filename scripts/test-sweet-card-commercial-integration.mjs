import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import { sweetCardRouter } from '../server/sweet-card.js'
import { prisma } from '../server/pg.js'
import { createCustomerSession, resolveOrCreateCustomerIdentity } from '../server/customer-auth.js'
import { bindClaimedSweetCard, resetSweetCardClaimRateLimitsForTest, createSweetCardClaimRouter, issueSweetCardClaimCredential } from '../server/sweet-card-claim.js'
import {
  PRODUCTION_CLOUDBASE_ENV_ID,
  PRODUCTION_WECHAT_APP_ID,
  gatewayBodyHash,
  signProductionGatewayRequest,
} from '../server/production-cloudbase-gateway.js'

const expectedDatabase = 'budu_commercial_eligibility_scratch'
if (new URL(process.env.DATABASE_URL).hostname !== 'sc-commercial-scratch-pg' || new URL(process.env.DATABASE_URL).pathname !== '/'+expectedDatabase) throw new Error('SCRATCH_DATABASE_REQUIRED')

const run = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
const markerKey = 'a10-pg-customer-marker-key-0123456789'
const gatewaySecret = 'a10-pg-clone-gateway-secret-0123456789'
const ids = {
  admin: `a10pg-admin-${run}`,
  userA: `a10pg-user-a-${run}`,
  userB: `a10pg-user-b-${run}`,
  batch: `a10pg-batch-${run}`,
  account: `a10pg-account-${run}`,
}
let identityId = ''
let identityUserId = ''

async function snapshot() {
  const [accounts, balance, ledgerRows, ledger, redemptions, refunds, payments, claims, bindings] = await Promise.all([
    prisma.sweetCardAccount.count(),
    prisma.sweetCardAccount.aggregate({ _sum: { balanceCents: true } }),
    prisma.sweetCardLedger.count(),
    prisma.sweetCardLedger.aggregate({ _sum: { amountCents: true } }),
    prisma.sweetCardRedemption.count(), prisma.sweetCardRefund.count(), prisma.payment.count(),
    prisma.sweetCardClaim.count(), prisma.sweetCardBinding.count(),
  ])
  return {
    accounts, balance: String(balance._sum.balanceCents || 0), ledgerRows,
    ledger: String(ledger._sum.amountCents || 0), redemptions, refunds, payments, claims, bindings,
  }
}

function signedHeaders({ method, requestPath, body, session = '', nonce = crypto.randomBytes(24).toString('base64url') }) {
  const timestamp = String(Date.now())
  const fields = {
    timestamp, nonce, method, requestPath, bodyHash: gatewayBodyHash(body),
    environment: PRODUCTION_CLOUDBASE_ENV_ID, appId: PRODUCTION_WECHAT_APP_ID,
  }
  return {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(session ? { authorization: `Bearer ${session}` } : {}),
    'x-budu-gateway-timestamp': timestamp,
    'x-budu-gateway-nonce': nonce,
    'x-budu-gateway-environment': PRODUCTION_CLOUDBASE_ENV_ID,
    'x-budu-gateway-appid': PRODUCTION_WECHAT_APP_ID,
    'x-budu-gateway-signature': signProductionGatewayRequest(fields, gatewaySecret),
  }
}

const [identityCheck] = await prisma.$queryRawUnsafe('SELECT current_database() AS name')
assert.equal(identityCheck.name, expectedDatabase)
const before = await snapshot()
const previousEnv = {
  APP_ENV: process.env.APP_ENV,
  enabled: process.env.SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED,
  allowlist: process.env.SWEET_CARD_MINIPROGRAM_CLAIM_USER_IDS,
  allowlistOnly: process.env.SWEET_CARD_MINIPROGRAM_CLAIM_ALLOWLIST_ONLY,
}
let server
try {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`
  assert.equal(database.name, expectedDatabase)
  process.env.APP_ENV = 'prod'
  process.env.SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED = '1'
  process.env.SWEET_CARD_MINIPROGRAM_CLAIM_ALLOWLIST_ONLY = '1'
  process.env.SWEET_CARD_MINIPROGRAM_CLAIM_USER_IDS = ids.userA

  await prisma.user.createMany({ data: [
    { id: ids.admin, username: `a10pg_admin_${run}`, passwordHash: 'isolated-clone-only', role: 'developer', storeKeys: [], permissions: {} },
    { id: ids.userA, username: `a10pg_user_a_${run}`, passwordHash: 'isolated-clone-only', role: 'customer', storeKeys: [], permissions: {} },
    { id: ids.userB, username: `a10pg_user_b_${run}`, passwordHash: 'isolated-clone-only', role: 'customer', storeKeys: [], permissions: {} },
  ] })
  const identity = await resolveOrCreateCustomerIdentity({
    appId: PRODUCTION_WECHAT_APP_ID, openId: `a10pg-synthetic-openid-${run}`, db: prisma,
  })
  const identityAgain = await resolveOrCreateCustomerIdentity({
    appId: PRODUCTION_WECHAT_APP_ID, openId: `a10pg-synthetic-openid-${run}`, db: prisma,
  })
  assert.equal(identityAgain.userId, identity.userId)
  identityUserId = identity.userId
  const identityRow = await prisma.weChatAuthIdentity.findFirstOrThrow({ where: { userId: identityUserId } })
  identityId = identityRow.id

  await prisma.sweetCardBatch.create({ data: {
    id: ids.batch, name: 'A10-PG isolated clone acceptance', purpose: 'TEST_ONLY',
    businessPurpose: 'COMMERCIAL', faceValueCents: 5000n, cardCount: 1,
    totalInitialAmountCents: 5000n, validityType: 'LONG_TERM', carrierType: 'ELECTRONIC',
    bindingMode: 'REQUIRED', createdById: ids.admin,
  } })
  await prisma.sweetCardAccount.create({ data: {
    id: ids.account, publicCardNo: `A10PG-${run}`.toUpperCase(), batchId: ids.batch,
    initialAmountCents: 5000n, balanceCents: 5000n, validityType: 'LONG_TERM',
    status: 'ACTIVE', carrierType: 'ELECTRONIC', bindingMode: 'REQUIRED',
  } })
  await prisma.sweetCardLedger.create({ data: { id: 'issue-'+run, accountId: ids.account, type: 'ISSUE', amountCents: 5000n, balanceAfterCents: 5000n, requestKey: 'issue-'+run } })
  const credential = await issueSweetCardClaimCredential({ accountId: ids.account, createdById: ids.admin, db: prisma })
  await assert.rejects(issueSweetCardClaimCredential({accountId: ids.account, createdById: ids.admin, db: prisma}), /REISSUE_CONFIRMATION_REQUIRED/)
  assert.equal(await prisma.sweetCardClaimToken.count({where:{accountId:ids.account, revokedAt:null, consumedAt:null}}),1)
  const sessionA = await createCustomerSession({ userId: ids.userA, markerKey, db: prisma })
  const sessionB = await createCustomerSession({ userId: ids.userB, markerKey, db: prisma })

  const config = {
    enabled: true, mode: 'production', appId: PRODUCTION_WECHAT_APP_ID,
    cloudBaseEnvId: PRODUCTION_CLOUDBASE_ENV_ID, database: expectedDatabase,
    appSecret: 'clone-appsecret-not-used', gatewaySecret, markerKey,
  }
  const app = express()
  app.use(express.json())
  // Test-only authenticated-principal injection; production permission middleware is unchanged.
  app.use('/api', (req,res,next) => {
    req.user = req.get('x-test-principal') === 'admin'
      ? {id:ids.admin,role:'admin',username:'admin'}
      : {id:ids.userB,role:req.get('x-test-principal') === 'pos' ? 'staff' : 'customer',permissions:{'store-pos':true}}
    next()
  }, sweetCardRouter)
  app.use('/api/v2/customer/sweet-card', createSweetCardClaimRouter({ db: prisma, configLoader: () => config }))
  server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const call = async ({ method = 'POST', path, body, session, signed = true }) => {
    const requestPath = `/api/v2/customer/sweet-card${path}`
    const response = await fetch(`${origin}${requestPath}`, {
      method,
      headers: signed ? signedHeaders({ method, requestPath, body, session }) : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }

  const claimBody = {
    claimToken: credential.rawToken, claimProof: credential.rawProof,
    requestKey: `a10pg_${run}_request`, bindIntent: true,
  }
  const unsigned = await call({ path: '/claim', body: claimBody, session: sessionA.rawToken, signed: false })
  assert.equal(unsigned.status, 401)
  const denied = await call({ path: '/claim', body: claimBody, session: sessionB.rawToken })
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error, 'CLAIM_ACCESS_DENIED')
  process.env.SWEET_CARD_MINIPROGRAM_CLAIM_ALLOWLIST_ONLY = '0'
  process.env.SWEET_CARD_MINIPROGRAM_CLAIM_USER_IDS = 'old-unrelated-allowlisted-user'
  for (const status of ['FROZEN', 'EXPIRED', 'LOST']) {
    await prisma.sweetCardAccount.update({where:{id:ids.account},data:{status}})
    resetSweetCardClaimRateLimitsForTest()
    const denied = await call({path:'/claim',body:claimBody,session:sessionA.rawToken})
    assert.equal(denied.status,404)
  }
  await prisma.sweetCardAccount.update({where:{id:ids.account},data:{status:'ACTIVE',expiresAt:new Date(0)}})
  assert.equal((await call({path:'/claim',body:claimBody,session:sessionA.rawToken})).status,404)
  await prisma.sweetCardAccount.update({where:{id:ids.account},data:{expiresAt:null}})
  resetSweetCardClaimRateLimitsForTest()
  const economicsBeforeAll = await snapshot()
  process.env.SWEET_CARD_ENABLED = '1'
  process.env.SWEET_CARD_PRODUCTION_GATEWAY_ENABLED = '1'
  const extraIds = ['generation','concurrent','optional'].map(x=>x+'-'+run)
  for (const id of extraIds) await prisma.sweetCardAccount.create({data:{
    id,publicCardNo:id,batchId:ids.batch,initialAmountCents:0n,balanceCents:0n,
    validityType:'LONG_TERM',status:'CREATED',carrierType:'ELECTRONIC',bindingMode:id.startsWith('optional')?'OPTIONAL':'REQUIRED'
  }})
  const gen = async principal => {
    const r=await fetch(origin+'/api/sweet-cards/cards/'+extraIds[0]+'/claim-presentation',{
      method:'POST',headers:{'content-type':'application/json','x-test-principal':principal},
      body:JSON.stringify({holderVerificationConfirmed:true,separateProofDelivery:true})})
    return {status:r.status,body:await r.json()}
  }
  assert.equal((await gen('pos')).status,403)
  assert.equal((await gen('customer')).status,403)
  const genResults=await Promise.all([gen('admin'),gen('admin')])
  assert.deepEqual(genResults.map(r=>r.status).sort(),[201,409])
  assert.equal(genResults.find(r=>r.status===201).body.claimAsset.purpose,'MINIPROGRAM_CLAIM')
  assert.equal(await prisma.sweetCardClaimToken.count({where:{accountId:extraIds[0],revokedAt:null,consumedAt:null}}),1)
  const concurrent=await issueSweetCardClaimCredential({accountId:extraIds[1],createdById:ids.admin})
  const claimDirect = async (userId, requestKey) => {
    const {claimSweetCard}=await import('../server/sweet-card-claim.js')
    return claimSweetCard({userId,requestKey,rawToken:concurrent.rawToken,rawProof:concurrent.rawProof})
  }
  const race=await Promise.allSettled([claimDirect(ids.userA,'concurrent-A-'+run),claimDirect(ids.userB,'concurrent-B-'+run)])
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(await prisma.sweetCardClaim.count({where:{accountId:extraIds[1]}}),1)
  const optional=await issueSweetCardClaimCredential({accountId:extraIds[2],createdById:ids.admin})
  const {claimSweetCard}=await import('../server/sweet-card-claim.js')
  const optionalClaim=await claimSweetCard({userId:ids.userA,requestKey:'optional-'+run,rawToken:optional.rawToken,rawProof:optional.rawProof})
  assert.equal(optionalClaim.bindingStatus,'UNBOUND')
  const bound=await bindClaimedSweetCard({userId:ids.userA,walletRef:optionalClaim.walletRef})
  assert.equal(bound.bindingStatus,'BOUND')
  await assert.rejects(bindClaimedSweetCard({userId:ids.userB,walletRef:optionalClaim.walletRef}),/CLAIM_NOT_FOUND/)
  for (const model of ['sweetCardAuditLog','sweetCardBinding','sweetCardClaim','sweetCardClaimToken']) await prisma[model].deleteMany({where:{accountId:{in:extraIds}}})
  await prisma.sweetCardAccount.deleteMany({where:{id:{in:extraIds}}})
  const economicBeforeClaim = await snapshot()
  const claimed = await call({ path: '/claim', body: claimBody, session: sessionA.rawToken })
  assert.equal(claimed.status, 201)
  assert.equal(claimed.body.claimStatus, 'CLAIMED')
  assert.equal(claimed.body.bindingStatus, 'BOUND')
  const retry = await call({ path: '/claim', body: claimBody, session: sessionA.rawToken })
  assert.equal(retry.status, 200)
  assert.equal(retry.body.claimStatus, 'ALREADY_CLAIMED_BY_SELF')
  const wallet = await call({ method: 'GET', path: '/wallet', session: sessionA.rawToken })
  assert.equal(wallet.status, 200)
  assert.equal(wallet.body.cards.length, 1)
  assert.equal(wallet.body.cards[0].balanceCents, '5000')
  const spoof = await call({ path: '/claim', body: { ...claimBody, userId: ids.userB, openid: 'spoof' }, session: sessionA.rawToken })
  assert.equal(spoof.status, 400)
  assert.equal(spoof.body.error, 'IDENTITY_AUTHORITY_SPOOF_REJECTED')

  const crossUser = await call({ path: '/claim', body: { ...claimBody, requestKey: `a10pg_${run}_other` }, session: sessionB.rawToken })
  assert.equal(crossUser.status, 409)

  const detail = await call({method:'GET',path:'/wallet/'+claimed.body.walletRef,session:sessionA.rawToken})
  assert.equal(detail.status,200)
  assert.equal((await call({method:'GET',path:'/wallet/'+claimed.body.walletRef,session:sessionB.rawToken})).status,404)
  const { newCredential, isSweetCardToken } = await import('../server/sweet-card-core.js')
  const pos = newCredential()
  await prisma.sweetCardCredential.create({ data: {
    id:'pos-'+run, accountId:ids.account, publicTokenId:'pos-public-'+run,
    tokenHash:pos.tokenHash, tokenCiphertext:pos.ciphertext,tokenIv:pos.iv,tokenTag:pos.tag,
    status:'ACTIVE',carrierType:'ELECTRONIC'
  }})
  const storeId='commercial-store-'+run
  await prisma.store.create({data:{key:storeId,name:'Isolated store',active:true,operationType:'DIRECT',sweetCardPolicy:{create:{eligible:true}}}})
  const presentation = await call({path:'/wallet/'+claimed.body.walletRef+'/pos-presentation',body:{},session:sessionA.rawToken})
  assert.equal(presentation.status,200)
  assert.match(presentation.body.presentation.qrImageDataUrl,/^data:image\/png;base64,/)
  assert.equal(isSweetCardToken(credential.rawToken),false)
  const confused = await call({path:'/claim/entry',body:{claimToken:pos.token}})
  assert.equal(confused.status,400)
  for (const status of ['FROZEN','EXPIRED','LOST']) {
    await prisma.sweetCardAccount.update({where:{id:ids.account},data:{status}})
    assert.equal((await call({path:'/wallet/'+claimed.body.walletRef+'/pos-presentation',body:{},session:sessionA.rawToken})).status,409)
  }
  await prisma.sweetCardAccount.update({where:{id:ids.account},data:{status:'ACTIVE'}})
  await prisma.sweetCardStorePolicy.delete({where:{storeId}})
  await prisma.store.delete({where:{key:storeId}})
  const economicAfterClaim = await snapshot()
  for (const key of ['balance','ledger','ledgerRows','redemptions','refunds','payments']) assert.equal(economicAfterClaim[key],economicsBeforeAll[key])
  assert.equal(BigInt(economicAfterClaim.ledger)-BigInt(economicAfterClaim.balance),0n)
  assert.equal(economicAfterClaim.balance, economicBeforeClaim.balance)
  assert.equal(economicAfterClaim.ledgerRows, economicBeforeClaim.ledgerRows)
  assert.equal(economicAfterClaim.ledger, economicBeforeClaim.ledger)
  assert.equal(economicAfterClaim.redemptions, economicBeforeClaim.redemptions)
  assert.equal(economicAfterClaim.refunds, economicBeforeClaim.refunds)
  assert.equal(economicAfterClaim.payments, economicBeforeClaim.payments)
  process.env.SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED = '0'
  const flagOff = await call({ path: '/claim/entry', body: { claimToken: credential.rawToken } })
  assert.equal(flagOff.status, 404)
  console.log(JSON.stringify({
    status: 'COMMERCIAL_SIGNED_HTTP_INTEGRATION_PASS', database: database.name,
    identityBridgeStableUserId: true, signedGateway: true, unsignedDenied: true,
    allowlistDenied: true, nonAllowlistedCommercialClaim: true, posPresentation: true, adminGeneration:true, posOnlyAndCustomerDenied:true, concurrentGeneration:true, concurrentClaim:true, optionalBinding:true, ledgerDelta:'0', binding: true, wallet: true,
    sameUserIdempotent: true, crossUserDenied: true, spoofDenied: true,
    claimFlagOffDenied: true, economicMutation: 'NONE', ledgerDeltaPreserved: true,
  }))
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  await prisma.sweetCardAuditLog.deleteMany({ where: { accountId: ids.account } })
  await prisma.sweetCardBinding.deleteMany({ where: { accountId: ids.account } })
  await prisma.sweetCardClaim.deleteMany({ where: { accountId: ids.account } })
  await prisma.sweetCardClaimToken.deleteMany({ where: { accountId: ids.account } })
  await prisma.customerSession.deleteMany({ where: { userId: { in: [ids.userA, ids.userB, identityUserId].filter(Boolean) } } })
  await prisma.sweetCardCredential.deleteMany({ where: { accountId: ids.account } })
  await prisma.sweetCardLedger.deleteMany({ where: { accountId: ids.account } })
  await prisma.sweetCardAccount.deleteMany({ where: { id: ids.account } })
  await prisma.sweetCardBatch.deleteMany({ where: { id: ids.batch } })
  if (identityId) await prisma.weChatAuthIdentity.deleteMany({ where: { id: identityId } })
  await prisma.user.deleteMany({ where: { id: { in: [ids.userA, ids.userB, ids.admin, identityUserId].filter(Boolean) } } })
  if (previousEnv.APP_ENV === undefined) delete process.env.APP_ENV
  else process.env.APP_ENV = previousEnv.APP_ENV
  if (previousEnv.enabled === undefined) delete process.env.SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED
  else process.env.SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED = previousEnv.enabled
  if (previousEnv.allowlist === undefined) delete process.env.SWEET_CARD_MINIPROGRAM_CLAIM_USER_IDS
  else process.env.SWEET_CARD_MINIPROGRAM_CLAIM_USER_IDS = previousEnv.allowlist
  if (previousEnv.allowlistOnly === undefined) delete process.env.SWEET_CARD_MINIPROGRAM_CLAIM_ALLOWLIST_ONLY
  else process.env.SWEET_CARD_MINIPROGRAM_CLAIM_ALLOWLIST_ONLY = previousEnv.allowlistOnly
  assert.deepEqual(await snapshot(), before)
  await prisma.$disconnect()
}
