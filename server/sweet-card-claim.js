import crypto from 'node:crypto'
import express from 'express'
import { authenticateCustomerSession, bearerToken } from './customer-auth.js'
import { prisma } from './pg.js'
import { validateWechatTestLoginConfig } from './wechat-test-login.js'

export const CLAIM_TOKEN_PREFIX = 'budu:claim:v1:'
export const CLAIM_PROOF_PREFIX = 'budu:claim-proof:v1:'
export const CLAIM_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const CLAIM_TOKEN_PATTERN = /^budu:claim:v1:[A-Za-z0-9_-]{43}$/
const CLAIM_PROOF_PATTERN = /^budu:claim-proof:v1:[A-Za-z0-9_-]{22}$/
const CLAIMABLE_ACCOUNT_STATUSES = new Set(['CREATED', 'ACTIVE'])

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function deny(message = 'CLAIM_CREDENTIAL_DENIED', status = 404) {
  throw Object.assign(new Error(message), { status })
}

function maskedCardNo(value) {
  const cardNo = String(value || '')
  return cardNo.length > 4 ? `${'*'.repeat(Math.min(8, cardNo.length - 4))}${cardNo.slice(-4)}` : '****'
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
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${String(accountId)}, 0))`
    const account = await tx.sweetCardAccount.findUnique({
      where: { id: accountId }, include: { batch: true },
    })
    if (!account || account.batch?.businessPurpose !== 'ACCEPTANCE_TEST') deny()
    await tx.sweetCardClaimToken.updateMany({
      where: { accountId, revokedAt: null, consumedAt: null }, data: { revokedAt: now },
    })
    const rawToken = `${CLAIM_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`
    const rawProof = `${CLAIM_PROOF_PREFIX}${crypto.randomBytes(16).toString('base64url')}`
    const expiresAt = new Date(now.getTime() + ttlMs)
    const record = await tx.sweetCardClaimToken.create({
      data: {
        id: crypto.randomUUID(), accountId, tokenHash: sha256(rawToken), proofHash: sha256(rawProof),
        expiresAt, createdById,
      },
    })
    return { id: record.id, rawToken, rawProof, expiresAt }
  }
  return typeof db.$transaction === 'function' ? db.$transaction(work) : work(db)
}

export async function resolveSweetCardClaimCredential({ rawToken, rawProof, db = prisma, now = new Date() }) {
  const token = String(rawToken || '').trim()
  const proof = String(rawProof || '').trim()
  if (!CLAIM_TOKEN_PATTERN.test(token) || !CLAIM_PROOF_PATTERN.test(proof)) {
    deny('CLAIM_CREDENTIAL_INVALID', 400)
  }
  const record = await db.sweetCardClaimToken.findUnique({
    where: { tokenHash: sha256(token) },
    include: { account: { include: { batch: true, binding: true } } },
  })
  if (!record || record.proofHash !== sha256(proof) || record.revokedAt || record.consumedAt
      || record.expiresAt <= now || record.account.binding
      || record.account.batch?.businessPurpose !== 'ACCEPTANCE_TEST'
      || !CLAIMABLE_ACCOUNT_STATUSES.has(record.account.status)
      || (record.account.expiresAt && record.account.expiresAt <= now)) deny()
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

function claimEnabled(env) {
  return String(env.SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED || '') === '1'
}

function claimantAllowed(userId, env) {
  if (String(env.SWEET_CARD_MINIPROGRAM_CLAIM_ALLOWLIST_ONLY ?? '1') !== '1') return true
  const allowlist = new Set(String(env.SWEET_CARD_MINIPROGRAM_CLAIM_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean))
  return allowlist.has(userId)
}

export function createSweetCardClaimRouter({ db = prisma, configLoader = validateWechatTestLoginConfig } = {}) {
  const router = express.Router()
  router.post('/claim/resolve', async (req, res) => {
    if (String(process.env.APP_ENV || '').trim().toLowerCase() !== 'test'
        || req.get('x-budu-test-gateway') !== '1' || !claimEnabled(process.env)) {
      return res.status(404).json({ error: 'NOT_FOUND' })
    }
    try {
      const config = configLoader(process.env)
      if (!config.enabled) return res.status(404).json({ error: 'NOT_FOUND' })
      const customer = await authenticateCustomerSession({
        rawToken: bearerToken(req.get('authorization')), markerKey: config.markerKey, db,
      })
      if (!claimantAllowed(customer.userId, process.env)) return res.status(403).json({ error: 'CLAIM_ACCESS_DENIED' })
      const result = await resolveSweetCardClaimCredential({
        rawToken: req.body?.claimToken, rawProof: req.body?.claimProof, db,
      })
      return res.json({ ok: true, ...result })
    } catch (error) {
      return res.status(Number(error?.status) || 503).json({ error: error?.message || 'CLAIM_RESOLVE_UNAVAILABLE' })
    }
  })
  return router
}

export const sweetCardClaimRouter = createSweetCardClaimRouter()
export const sweetCardClaimInternals = { sha256, maskedCardNo, CLAIM_TOKEN_PATTERN, CLAIM_PROOF_PATTERN }
