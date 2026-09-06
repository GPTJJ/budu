import crypto from 'node:crypto'
import express from 'express'
import { authenticateCustomerSession, bearerToken } from './customer-auth.js'
import { lockSweetCardAccount } from './sweet-card-account-lock.js'
import { prisma } from './pg.js'
import { validateWechatTestLoginConfig } from './wechat-test-login.js'

export const CLAIM_TOKEN_PREFIX = 'budu:claim:v1:'
export const CLAIM_PROOF_PREFIX = 'budu:claim-proof:v1:'
export const CLAIM_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const CLAIM_TOKEN_PATTERN = /^budu:claim:v1:[A-Za-z0-9_-]{43}$/
const CLAIM_PROOF_PATTERN = /^budu:claim-proof:v1:[A-Za-z0-9_-]{22}$/
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const CLAIMABLE_ACCOUNT_STATUSES = new Set(['CREATED', 'ACTIVE'])
const CLAIMABLE_CARRIERS = new Set(['PHYSICAL', 'ELECTRONIC'])
const BINDING_MODES = new Set(['NONE', 'OPTIONAL', 'REQUIRED'])
const IDENTITY_FIELDS = new Set(['userId', 'ownerUserId', 'openId', 'openid', 'unionId', 'unionid'])

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function deny(message = 'CLAIM_CREDENTIAL_DENIED', status = 404) {
  throw Object.assign(new Error(message), { status, publicSafe: true })
}

function maskedCardNo(value) {
  const cardNo = String(value || '')
  return cardNo.length > 4 ? `${'*'.repeat(Math.min(8, cardNo.length - 4))}${cardNo.slice(-4)}` : '****'
}

function rejectIdentityAuthority(body) {
  if (body && Object.keys(body).some(key => IDENTITY_FIELDS.has(key))) {
    deny('IDENTITY_AUTHORITY_SPOOF_REJECTED', 400)
  }
}

function validateCredential(rawToken, rawProof) {
  const token = String(rawToken || '').trim()
  const proof = String(rawProof || '').trim()
  if (!CLAIM_TOKEN_PATTERN.test(token) || !CLAIM_PROOF_PATTERN.test(proof)) {
    deny('CLAIM_CREDENTIAL_INVALID', 400)
  }
  return { token, proof }
}

function validateRequestKey(value) {
  const requestKey = String(value || '').trim()
  if (!REQUEST_KEY_PATTERN.test(requestKey)) deny('CLAIM_REQUEST_KEY_INVALID', 400)
  return requestKey
}

function assertClaimable(record, proof, now) {
  const account = record?.account
  if (!record || record.proofHash !== sha256(proof) || !account
      || account.batch?.businessPurpose !== 'ACCEPTANCE_TEST'
      || !CLAIMABLE_ACCOUNT_STATUSES.has(account.status)
      || !CLAIMABLE_CARRIERS.has(account.carrierType)
      || !BINDING_MODES.has(account.bindingMode)
      || (account.expiresAt && account.expiresAt <= now)) deny()
}

function claimDto({ account, claim, already = false }) {
  return {
    claimStatus: already ? 'ALREADY_CLAIMED_BY_SELF' : 'CLAIMED',
    bindingStatus: account.binding?.userId ? 'BOUND' : 'UNBOUND',
    walletRef: claim.id,
    maskedCardNo: maskedCardNo(account.publicCardNo),
    faceValueCents: String(account.initialAmountCents),
    balanceCents: String(account.balanceCents),
    validity: {
      type: account.validityType,
      validFrom: account.validFrom ? account.validFrom.toISOString() : null,
      expiresAt: account.expiresAt ? account.expiresAt.toISOString() : null,
    },
    carrierType: account.carrierType,
    bindingMode: account.bindingMode,
    recipient: {
      label: account.recipientLabel || '',
      note: account.recipientNote || '',
    },
    status: account.status,
    cardPresentationStatus: account.status === 'CREATED' ? 'PENDING_ACTIVATION' : account.status,
  }
}

function customerCardDto(account, claim) {
  return {
    walletRef: claim.id,
    claimedAt: claim.claimedAt.toISOString(),
    maskedCardNo: maskedCardNo(account.publicCardNo),
    faceValueCents: String(account.initialAmountCents),
    balanceCents: String(account.balanceCents),
    status: account.status,
    validity: {
      type: account.validityType,
      validFrom: account.validFrom ? account.validFrom.toISOString() : null,
      expiresAt: account.expiresAt ? account.expiresAt.toISOString() : null,
    },
    recipient: {
      label: account.recipientLabel || '',
      note: account.recipientNote || '',
    },
    carrierType: account.carrierType,
    bindingMode: account.bindingMode,
    bindingStatus: account.binding?.userId === claim.userId ? 'BOUND' : 'UNBOUND',
  }
}

function previewDto(account, state = 'AVAILABLE') {
  return {
    state,
    claimable: state === 'AVAILABLE',
    maskedCardNo: maskedCardNo(account.publicCardNo),
    faceValueCents: String(account.initialAmountCents),
    validity: {
      type: account.validityType,
      validFrom: account.validFrom ? account.validFrom.toISOString() : null,
      expiresAt: account.expiresAt ? account.expiresAt.toISOString() : null,
    },
    recipient: {
      label: account.recipientLabel || '',
      note: account.recipientNote || '',
    },
    carrierType: account.carrierType,
    bindingMode: account.bindingMode,
    status: account.status,
    activationState: account.status === 'CREATED' ? 'PENDING_ACTIVATION' : 'ACTIVE',
  }
}

function bindingData(accountId, userId, now) {
  return {
    id: `scbind-${crypto.randomUUID()}`,
    accountId,
    memberId: null,
    userId,
    channel: 'MINIPROGRAM',
    verificationMethod: 'WECHAT_CUSTOMER_SESSION',
    boundById: userId,
    boundByName: '',
    boundAt: now,
  }
}

async function a3Audit(tx, userId, action, account, metadata, now) {
  return tx.sweetCardAuditLog.create({ data: {
    id: `sca-${crypto.randomUUID()}`,
    accountId: account.id,
    batchId: account.batchId,
    action,
    actorId: userId,
    actorName: '',
    metadata: { channel: 'MINIPROGRAM', actorIdentitySource: 'AUTHENTICATED_CUSTOMER_SESSION', ...metadata },
    createdAt: now,
  } })
}

export async function issueSweetCardClaimCredential({
  accountId,
  createdById,
  db = prisma,
  now = new Date(),
  ttlMs = CLAIM_TOKEN_TTL_MS,
}) {
  if (!accountId || !createdById) deny('CLAIM_CREDENTIAL_ISSUE_INVALID', 400)
  const work = async tx => {
    await lockSweetCardAccount(tx, accountId)
    const account = await tx.sweetCardAccount.findUnique({ where: { id: accountId }, include: { batch: true } })
    if (!account || account.batch?.businessPurpose !== 'ACCEPTANCE_TEST') deny()
    await tx.sweetCardClaimToken.updateMany({
      where: { accountId, revokedAt: null, consumedAt: null }, data: { revokedAt: now },
    })
    const rawToken = `${CLAIM_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`
    const rawProof = `${CLAIM_PROOF_PREFIX}${crypto.randomBytes(16).toString('base64url')}`
    const expiresAt = new Date(now.getTime() + ttlMs)
    const record = await tx.sweetCardClaimToken.create({ data: {
      id: crypto.randomUUID(), accountId, tokenHash: sha256(rawToken), proofHash: sha256(rawProof),
      expiresAt, createdById,
    } })
    return { id: record.id, rawToken, rawProof, expiresAt }
  }
  return typeof db.$transaction === 'function' ? db.$transaction(work) : work(db)
}

export async function resolveSweetCardClaimCredential({ rawToken, rawProof, db = prisma, now = new Date() }) {
  const { token, proof } = validateCredential(rawToken, rawProof)
  const record = await db.sweetCardClaimToken.findUnique({
    where: { tokenHash: sha256(token) },
    include: { account: { include: { batch: true, binding: true, claim: true } } },
  })
  assertClaimable(record, proof, now)
  if (record.revokedAt || record.consumedAt || record.expiresAt <= now
      || record.account.binding || record.account.claim) deny()
  const account = record.account
  return {
    claimable: true,
    maskedCardNo: maskedCardNo(account.publicCardNo),
    faceValueCents: String(account.initialAmountCents),
    validity: {
      type: account.validityType,
      validFrom: account.validFrom ? account.validFrom.toISOString() : null,
      expiresAt: account.expiresAt ? account.expiresAt.toISOString() : null,
    },
    carrierType: account.carrierType,
    bindingMode: account.bindingMode,
  }
}

export async function resolveSweetCardClaimExperience({ rawToken, rawProof, userId = null, db = prisma, now = new Date() }) {
  const { token, proof } = validateCredential(rawToken, rawProof)
  const record = await db.sweetCardClaimToken.findUnique({
    where: { tokenHash: sha256(token) },
    include: { account: { include: { batch: true, binding: true, claim: true } } },
  })
  if (!record || record.proofHash !== sha256(proof) || record.account?.batch?.businessPurpose !== 'ACCEPTANCE_TEST') {
    deny('CLAIM_CREDENTIAL_INVALID', 404)
  }
  const account = record.account
  if (record.revokedAt) deny('CLAIM_CREDENTIAL_REVOKED', 409)
  if (record.expiresAt <= now) deny('CLAIM_CREDENTIAL_EXPIRED', 410)
  if (account.status === 'LOST') deny('CARD_LOST', 409)
  if (account.status === 'VOID') deny('CARD_VOID', 409)
  if (account.status === 'EXPIRED' || (account.expiresAt && account.expiresAt <= now)) deny('CARD_EXPIRED', 409)
  if (!CLAIMABLE_ACCOUNT_STATUSES.has(account.status)) deny('CARD_UNAVAILABLE', 409)
  if (!CLAIMABLE_CARRIERS.has(account.carrierType) || !BINDING_MODES.has(account.bindingMode)) deny()
  if (account.claim) {
    return previewDto(account, userId && account.claim.userId === userId ? 'ALREADY_CLAIMED_BY_SELF' : 'ALREADY_CLAIMED')
  }
  if (account.binding) deny('CARD_UNAVAILABLE', 409)
  if (record.consumedAt) deny('CLAIM_CREDENTIAL_USED', 409)
  return previewDto(account)
}

export async function listCustomerSweetCards({ userId, db = prisma }) {
  if (!userId) deny('CUSTOMER_SESSION_DENIED', 401)
  const claims = await db.sweetCardClaim.findMany({
    where: { userId, account: { batch: { businessPurpose: 'ACCEPTANCE_TEST' } } },
    include: { account: { include: { binding: true } } },
    orderBy: { claimedAt: 'desc' },
  })
  return claims.map(claim => customerCardDto(claim.account, claim))
}

export async function getCustomerSweetCard({ userId, walletRef, db = prisma }) {
  if (!userId) deny('CUSTOMER_SESSION_DENIED', 401)
  const claimRef = String(walletRef || '').trim()
  if (!/^[A-Za-z0-9-]{16,100}$/.test(claimRef)) deny('SWEET_CARD_NOT_FOUND', 404)
  const claim = await db.sweetCardClaim.findFirst({
    where: { id: claimRef, userId, account: { batch: { businessPurpose: 'ACCEPTANCE_TEST' } } },
    include: {
      account: {
        include: {
          binding: true,
          ledger: {
            orderBy: { createdAt: 'desc' },
            take: 30,
            include: { redemption: { select: { storeIdSnapshot: true } } },
          },
        },
      },
    },
  })
  if (!claim) deny('SWEET_CARD_NOT_FOUND', 404)
  const storeIds = [...new Set(claim.account.ledger.map(row => row.redemption?.storeIdSnapshot || row.metadata?.storeId).filter(Boolean))]
  const stores = storeIds.length ? await db.store.findMany({ where: { key: { in: storeIds } }, select: { key: true, name: true } }) : []
  const storeNames = new Map(stores.map(store => [store.key, store.name]))
  return {
    ...customerCardDto(claim.account, claim),
    history: claim.account.ledger.map(row => {
      const storeId = row.redemption?.storeIdSnapshot || row.metadata?.storeId || null
      return {
        type: row.type,
        amountCents: String(row.amountCents),
        occurredAt: row.createdAt.toISOString(),
        storeName: storeId ? storeNames.get(storeId) || '' : '',
        source: storeId ? 'budu 门店 POS' : 'budu 甜意卡',
      }
    }),
  }
}

export async function listCustomerSweetCardStores({ db = prisma } = {}) {
  const stores = await db.store.findMany({
    where: { active: true, operationType: 'DIRECT', sweetCardPolicy: { eligible: true } },
    orderBy: { key: 'asc' },
    select: { key: true, name: true },
  })
  return stores.map(store => ({ storeRef: store.key, name: store.name }))
}

export async function claimSweetCard({
  userId, rawToken, rawProof, requestKey, bindIntent = false,
  db = prisma, now = new Date(), faultInjector = null,
}) {
  if (!userId) deny('CUSTOMER_SESSION_DENIED', 401)
  const { token, proof } = validateCredential(rawToken, rawProof)
  const keyHash = sha256(validateRequestKey(requestKey))
  if (typeof bindIntent !== 'boolean') deny('BIND_INTENT_INVALID', 400)
  const candidate = await db.sweetCardClaimToken.findUnique({
    where: { tokenHash: sha256(token) }, select: { accountId: true },
  })
  if (!candidate) deny()

  const work = async tx => {
    await lockSweetCardAccount(tx, candidate.accountId)
    const record = await tx.sweetCardClaimToken.findUnique({
      where: { tokenHash: sha256(token) },
      include: { account: { include: { batch: true, binding: true, claim: true } } },
    })
    if (!record || record.proofHash !== sha256(proof)) deny()
    const account = record.account
    const keyedClaim = await tx.sweetCardClaim.findUnique({
      where: { userId_requestKeyHash: { userId, requestKeyHash: keyHash } },
    })
    if (keyedClaim && (keyedClaim.accountId !== account.id || keyedClaim.tokenId !== record.id)) {
      deny('CLAIM_IDEMPOTENCY_CONFLICT', 409)
    }
    if (account.claim) {
      if (account.claim.userId !== userId) deny('ALREADY_CLAIMED', 409)
      const current = await tx.sweetCardAccount.findUniqueOrThrow({
        where: { id: account.id }, include: { binding: true },
      })
      return claimDto({ account: current, claim: account.claim, already: true })
    }
    if (keyedClaim) deny('CLAIM_STATE_CONFLICT', 409)
    if (record.revokedAt || record.consumedAt || record.expiresAt <= now) deny()
    assertClaimable(record, proof, now)
    if (account.binding) {
      if (account.binding.userId === userId) deny('CLAIM_STATE_CONFLICT', 409)
      deny('ALREADY_BOUND', 409)
    }
    if (account.bindingMode === 'NONE' && bindIntent) deny('BINDING_NOT_ALLOWED', 409)

    const claim = await tx.sweetCardClaim.create({ data: {
      id: crypto.randomUUID(), accountId: account.id, userId, tokenId: record.id,
      claimedAt: now, channel: 'MINIPROGRAM', sourceCarrier: account.carrierType,
      requestKeyHash: keyHash,
    } })
    if (faultInjector) await faultInjector('AFTER_CLAIM_WRITE')
    const shouldBind = account.bindingMode === 'REQUIRED'
      || (account.bindingMode === 'OPTIONAL' && bindIntent)
    if (shouldBind) await tx.sweetCardBinding.create({ data: bindingData(account.id, userId, now) })
    if (faultInjector) await faultInjector('AFTER_BINDING_STAGE')
    await tx.sweetCardClaimToken.update({ where: { id: record.id }, data: { consumedAt: now } })
    await a3Audit(tx, userId, 'sweet_card.miniprogram_claimed', account, {
      claimRef: claim.id, bindingMode: account.bindingMode, bindingCreated: shouldBind,
      claimedAt: now.toISOString(), ...(shouldBind ? { boundAt: now.toISOString() } : {}),
    }, now)
    const current = await tx.sweetCardAccount.findUniqueOrThrow({
      where: { id: account.id }, include: { binding: true },
    })
    return claimDto({ account: current, claim })
  }
  try {
    return await db.$transaction(work)
  } catch (error) {
    if (error?.code === 'P2002') deny('CLAIM_CONFLICT', 409)
    throw error
  }
}

export async function bindClaimedSweetCard({
  userId, walletRef, db = prisma, now = new Date(), faultInjector = null,
}) {
  if (!userId) deny('CUSTOMER_SESSION_DENIED', 401)
  const claimRef = String(walletRef || '').trim()
  if (!/^[A-Za-z0-9-]{16,100}$/.test(claimRef)) deny('CLAIM_REFERENCE_INVALID', 400)
  const candidate = await db.sweetCardClaim.findUnique({ where: { id: claimRef }, select: { accountId: true } })
  if (!candidate) deny('CLAIM_NOT_FOUND', 404)
  const work = async tx => {
    await lockSweetCardAccount(tx, candidate.accountId)
    const claim = await tx.sweetCardClaim.findUnique({
      where: { id: claimRef }, include: { account: { include: { batch: true, binding: true } } },
    })
    if (!claim || claim.userId !== userId || claim.account.batch?.businessPurpose !== 'ACCEPTANCE_TEST') {
      deny('CLAIM_NOT_FOUND', 404)
    }
    const account = claim.account
    if (account.bindingMode !== 'OPTIONAL') deny('BINDING_MODE_DENIED', 409)
    if (account.binding) {
      if (account.binding.userId !== userId) deny('ALREADY_BOUND', 409)
      return claimDto({ account, claim, already: true })
    }
    await tx.sweetCardBinding.create({ data: bindingData(account.id, userId, now) })
    if (faultInjector) await faultInjector('AFTER_BINDING_WRITE')
    await a3Audit(tx, userId, 'sweet_card.miniprogram_bound', account, {
      claimRef: claim.id, bindingMode: account.bindingMode, boundAt: now.toISOString(),
    }, now)
    const current = await tx.sweetCardAccount.findUniqueOrThrow({
      where: { id: account.id }, include: { binding: true },
    })
    return claimDto({ account: current, claim, already: true })
  }
  try {
    return await db.$transaction(work)
  } catch (error) {
    if (error?.code === 'P2002') deny('BINDING_CONFLICT', 409)
    throw error
  }
}

function claimEnabled(env) {
  return String(env.SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED || '') === '1'
}

function claimantAllowed(userId, env) {
  if (String(env.SWEET_CARD_MINIPROGRAM_CLAIM_ALLOWLIST_ONLY ?? '1') !== '1') return true
  const allowlist = new Set(String(env.SWEET_CARD_MINIPROGRAM_CLAIM_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean))
  return allowlist.has(userId)
}

function testOnlyRequest(req) {
  return String(process.env.APP_ENV || '').trim().toLowerCase() === 'test'
    && req.get('x-budu-test-gateway') === '1' && claimEnabled(process.env)
}

export function createSweetCardClaimRouter({ db = prisma, configLoader = validateWechatTestLoginConfig } = {}) {
  const router = express.Router()
  const withPublic = handler => async (req, res) => {
    if (!testOnlyRequest(req)) return res.status(404).json({ error: 'NOT_FOUND' })
    try {
      const config = configLoader(process.env)
      if (!config.enabled) return res.status(404).json({ error: 'NOT_FOUND' })
      res.setHeader('Cache-Control', 'no-store')
      return await handler(req, res)
    } catch (error) {
      return res.status(Number(error?.status) || 503).json({ error: error?.publicSafe ? error.message : 'CLAIM_SERVICE_UNAVAILABLE' })
    }
  }
  const withCustomer = handler => async (req, res) => {
    if (!testOnlyRequest(req)) return res.status(404).json({ error: 'NOT_FOUND' })
    try {
      const config = configLoader(process.env)
      if (!config.enabled) return res.status(404).json({ error: 'NOT_FOUND' })
      const customer = await authenticateCustomerSession({
        rawToken: bearerToken(req.get('authorization')), markerKey: config.markerKey, db,
      })
      if (!claimantAllowed(customer.userId, process.env)) return res.status(403).json({ error: 'CLAIM_ACCESS_DENIED' })
      res.setHeader('Cache-Control', 'no-store')
      return await handler(req, res, customer)
    } catch (error) {
      return res.status(Number(error?.status) || 503).json({ error: error?.message || 'CLAIM_SERVICE_UNAVAILABLE' })
    }
  }
  router.post('/claim/preview', withPublic(async (req, res) => {
    rejectIdentityAuthority(req.body)
    const result = await resolveSweetCardClaimExperience({
      rawToken: req.body?.claimToken, rawProof: req.body?.claimProof, db,
    })
    return res.json({ ok: true, ...result })
  }))
  router.post('/claim/resolve', withCustomer(async (req, res) => {
    rejectIdentityAuthority(req.body)
    const result = await resolveSweetCardClaimCredential({
      rawToken: req.body?.claimToken, rawProof: req.body?.claimProof, db,
    })
    return res.json({ ok: true, ...result })
  }))
  router.post('/claim', withCustomer(async (req, res, customer) => {
    rejectIdentityAuthority(req.body)
    const result = await claimSweetCard({
      userId: customer.userId, rawToken: req.body?.claimToken, rawProof: req.body?.claimProof,
      requestKey: req.body?.requestKey, bindIntent: req.body?.bindIntent ?? false, db,
    })
    return res.status(result.claimStatus === 'CLAIMED' ? 201 : 200).json({ ok: true, ...result })
  }))
  router.post('/:walletRef/bind', withCustomer(async (req, res, customer) => {
    rejectIdentityAuthority(req.body)
    const result = await bindClaimedSweetCard({ userId: customer.userId, walletRef: req.params.walletRef, db })
    return res.json({ ok: true, ...result })
  }))
  router.get('/wallet', withCustomer(async (req, res, customer) => {
    rejectIdentityAuthority(req.query)
    return res.json({ ok: true, cards: await listCustomerSweetCards({ userId: customer.userId, db }) })
  }))
  router.get('/wallet/stores', withCustomer(async (req, res) => {
    rejectIdentityAuthority(req.query)
    return res.json({ ok: true, stores: await listCustomerSweetCardStores({ db }) })
  }))
  router.get('/wallet/:walletRef', withCustomer(async (req, res, customer) => {
    rejectIdentityAuthority(req.query)
    return res.json({ ok: true, card: await getCustomerSweetCard({ userId: customer.userId, walletRef: req.params.walletRef, db }) })
  }))
  return router
}

export const sweetCardClaimRouter = createSweetCardClaimRouter()
export const sweetCardClaimInternals = {
  sha256, maskedCardNo, CLAIM_TOKEN_PATTERN, CLAIM_PROOF_PATTERN, REQUEST_KEY_PATTERN,
  rejectIdentityAuthority,
}
