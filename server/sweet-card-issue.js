import crypto from 'node:crypto'
import { httpError } from './pos-core.js'
import { expiryFor, newCredential, parseAmount, parseYuanAmount } from './sweet-card-core.js'

const ISSUE_REQUEST_KEY = /^[A-Za-z0-9:_-]{8,128}$/
const BATCH_PURPOSES = new Set(['ACCEPTANCE_TEST', 'COMMERCIAL'])
const VALIDITY_TYPES = new Set(['ONE_YEAR', 'THREE_YEARS', 'LONG_TERM'])
const CARRIER_TYPES = new Set(['PHYSICAL', 'ELECTRONIC'])
const BINDING_MODES = new Set(['NONE', 'OPTIONAL', 'REQUIRED'])
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const safeText = (value, max) => String(value || '').trim().slice(0, max)

export function normalizeSweetCardIssueRequestKey(value) {
  if (typeof value !== 'string' || !ISSUE_REQUEST_KEY.test(value)) throw httpError('发卡请求标识无效', 400)
  return value
}

export function createLegacySweetCardIssueRequestKey() {
  return `legacy:${crypto.randomUUID()}`
}

export function normalizeSweetCardIssuePayload(input = {}) {
  const cardCount = Number(input.cardCount)
  const faceValue = input.faceValueYuan !== undefined
    ? parseYuanAmount(input.faceValueYuan, '面额')
    : parseAmount(input.faceValueCents, '面额')
  if (!Number.isInteger(cardCount) || cardCount < 1 || cardCount > 500) throw httpError('制卡数量必须为 1–500')
  const validityType = String(input.validityType || '')
  const carrierType = String(input.carrierType || '')
  const bindingMode = String(input.bindingMode || '')
  const businessPurpose = String(input.businessPurpose || '').trim().toUpperCase()
  if (!VALIDITY_TYPES.has(validityType)) throw httpError('有效期不正确')
  if (!CARRIER_TYPES.has(carrierType)) throw httpError('载体不正确')
  if (!BINDING_MODES.has(bindingMode)) throw httpError('绑定模式不正确')
  if (!BATCH_PURPOSES.has(businessPurpose)) throw httpError('必须选择正式批次用途')
  return Object.freeze({
    name: safeText(input.name, 100) || '未命名批次',
    purpose: safeText(input.purpose, 300),
    businessPurpose,
    cardCount,
    faceValueCents: faceValue.toString(),
    validityType,
    carrierType,
    bindingMode,
    recipientType: safeText(input.recipientType, 60),
    recipientLabel: safeText(input.recipientLabel, 120),
    recipientCompany: safeText(input.recipientCompany, 120),
    recipientNote: safeText(input.recipientNote, 300),
    giftingScenario: safeText(input.giftingScenario, 120),
    presentationTemplateKey: safeText(input.presentationTemplateKey, 50) || 'minimal-v1',
    activateNow: carrierType === 'ELECTRONIC' && input.activateNow === true,
  })
}

export function sweetCardIssueFingerprint(payload) {
  return digest(payload)
}

function conflictError() {
  return Object.assign(httpError('发卡请求标识已用于不同内容', 409), {
    publicCode: 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD',
  })
}

function inProgressError() {
  return Object.assign(httpError('发卡请求仍在处理中，请使用同一请求标识重试', 409), {
    publicCode: 'ISSUE_REQUEST_IN_PROGRESS',
  })
}

const operationInclude = {
  batch: {
    include: {
      accounts: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, publicCardNo: true },
      },
    },
  },
}

const responseFromOperation = operation => ({
  ok: true,
  batchId: operation.batchId,
  cards: operation.batch.accounts.map(card => ({ accountId: card.id, publicCardNo: card.publicCardNo })),
  exportReady: true,
})

const safeObservation = (event, actorId, requestKey) => ({
  event,
  operation: 'SWEET_CARD_BATCH_ISSUE',
  principalHash: digest(['sweet-card-issue-principal', actorId]).slice(0, 16),
  requestKeyHash: digest(['sweet-card-issue-key', requestKey]).slice(0, 16),
})

export function logSweetCardIssueObservation(observation) {
  console.info('[sweet-card-issue-idempotency]', JSON.stringify(observation))
}

export async function issueSweetCardBatch({
  db,
  actor,
  requestKey: rawRequestKey,
  input,
  observe = () => {},
  credentialFactory = newCredential,
  clock = () => new Date(),
}) {
  const actorId = String(actor?.id || '').trim()
  if (!actorId || actorId.length > 160) throw httpError('发卡操作人身份无效', 401)
  const actorName = safeText(actor?.name, 160)
  const requestKey = normalizeSweetCardIssueRequestKey(rawRequestKey)
  const payload = normalizeSweetCardIssuePayload(input)
  const requestFingerprint = sweetCardIssueFingerprint(payload)
  const operationId = `sci-${digest([actorId, requestKey])}`
  try {
    const result = await db.$transaction(async (tx) => {
      const lockRows = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended(${`sweet-card-issue:${operationId}`}, 0)) AS acquired`
      const waited = lockRows[0]?.acquired !== true
      if (waited) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sweet-card-issue:${operationId}`}, 0))`

      const prior = await tx.sweetCardIssueOperation.findUnique({
        where: { actorId_requestKey: { actorId, requestKey } },
        include: operationInclude,
      })
      if (prior) {
        if (prior.requestFingerprint !== requestFingerprint) throw conflictError()
        return {
          event: waited ? 'IDEMPOTENT_REPLAY_AFTER_IN_PROGRESS' : 'IDEMPOTENT_REPLAY',
          response: responseFromOperation(prior),
        }
      }

      const batchId = `scb-${crypto.randomUUID()}`
      const now = clock()
      const faceValue = BigInt(payload.faceValueCents)
      await tx.sweetCardBatch.create({ data: {
        id: batchId,
        name: payload.name,
        purpose: payload.purpose,
        businessPurpose: payload.businessPurpose,
        faceValueCents: faceValue,
        cardCount: payload.cardCount,
        totalInitialAmountCents: faceValue * BigInt(payload.cardCount),
        validityType: payload.validityType,
        carrierType: payload.carrierType,
        bindingMode: payload.bindingMode,
        giftingScenario: payload.giftingScenario,
        presentationTemplateKey: payload.presentationTemplateKey,
        createdById: actorId,
        createdByName: actorName,
      } })
      for (let index = 0; index < payload.cardCount; index += 1) {
        const accountId = `scv-${crypto.randomUUID()}`
        const credentialId = `scc-${crypto.randomUUID()}`
        const generated = credentialFactory()
        const publicCardNo = `SC${now.getUTCFullYear()}${crypto.randomBytes(6).toString('hex').toUpperCase()}`
        const validFrom = payload.activateNow ? now : null
        const expiresAt = payload.activateNow ? expiryFor(payload.validityType, now) : null
        await tx.sweetCardAccount.create({ data: {
          id: accountId,
          publicCardNo,
          batchId,
          initialAmountCents: faceValue,
          balanceCents: faceValue,
          validityType: payload.validityType,
          validFrom,
          expiresAt,
          status: payload.activateNow ? 'ACTIVE' : 'CREATED',
          carrierType: payload.carrierType,
          bindingMode: payload.bindingMode,
          recipientType: payload.recipientType,
          recipientLabel: payload.recipientLabel,
          recipientCompany: payload.recipientCompany,
          recipientNote: payload.recipientNote,
          giftingScenario: payload.giftingScenario,
          issuedById: actorId,
          issuedByName: actorName,
          issuedAt: now,
          activatedById: payload.activateNow ? actorId : '',
          activatedAt: payload.activateNow ? now : null,
          credentials: { create: {
            id: credentialId,
            publicTokenId: generated.publicTokenId,
            tokenHash: generated.tokenHash,
            tokenCiphertext: generated.ciphertext,
            tokenIv: generated.iv,
            tokenTag: generated.tag,
            status: payload.activateNow ? 'ACTIVE' : 'UNACTIVATED',
            carrierType: payload.carrierType,
            activatedAt: payload.activateNow ? now : null,
          } },
          ledger: { create: {
            id: `scl-${crypto.randomUUID()}`,
            type: 'ISSUE',
            amountCents: faceValue,
            balanceAfterCents: faceValue,
            requestKey: `issue:${batchId}:${index}`,
            actorId,
            actorName,
            metadata: { batchId },
          } },
        } })
      }
      await tx.sweetCardAuditLog.create({ data: {
        id: `sca-${crypto.randomUUID()}`,
        action: 'sweet_card.batch_created',
        actorId,
        actorName,
        batchId,
        metadata: {
          cardCount: payload.cardCount,
          faceValueCents: payload.faceValueCents,
          carrierType: payload.carrierType,
          bindingMode: payload.bindingMode,
          businessPurpose: payload.businessPurpose,
        },
      } })
      const operation = await tx.sweetCardIssueOperation.create({
        data: { id: operationId, actorId, requestKey, requestFingerprint, batchId },
        include: operationInclude,
      })
      return { event: 'NEW_REQUEST', response: responseFromOperation(operation) }
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 60000 })
    observe(safeObservation(result.event, actorId, requestKey))
    return result
  } catch (error) {
    if (error?.publicCode === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD') {
      observe(safeObservation('PAYLOAD_CONFLICT', actorId, requestKey))
      throw error
    }
    if (error?.code === 'P2028') {
      observe(safeObservation('IN_PROGRESS_RETRY', actorId, requestKey))
      throw inProgressError()
    }
    throw error
  }
}
