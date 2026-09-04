import crypto from 'node:crypto'
import { Router } from 'express'
import JSZip from 'jszip'
import QRCode from 'qrcode'
import { prisma, dbReady } from './pg.js'
import { httpError } from './pos-core.js'
import { settlementCoordinator } from './settlements/settlement-coordinator.js'
import {
  ACCOUNT_PERMISSION_KEYS,
  canManageAccounts,
  hasModuleAccess,
  hasSweetCardCapability,
  hasSweetCardProductionTestAccess,
  MODULE_KEYS,
  normalizeAccountPermissions,
  SWEET_CARD_CAPABILITIES,
} from '../shared/accountPermissions.js'
import {
  SWEET_CARD_PRESENTATION_CONTRACT,
  allocateCents,
  assertSweetCardEnabled,
  decryptToken,
  expiryFor,
  isSweetCardToken,
  newCredential,
  parseAmount,
  sweetCardEnabled,
  tokenHash,
} from './sweet-card-core.js'
import { renderMinimalSweetCard } from './sweet-card-presentation.js'
import { requireSweetCardProductionTestAccess } from './sweet-card-rollout.js'
import { mirrorUsersToKv } from './user-store.js'

export const sweetCardRouter = Router()
const wrap = (handler) => async (req, res) => {
  try { await handler(req, res) } catch (error) {
    const status = error.status || 500
    if (status >= 500 && error.reported !== true) console.error('[sweet-card]', error)
    res.status(status).json({ error: status >= 500 && error.publicSafe !== true ? '服务器暂时无法处理，请稍后重试' : error.message || '服务器错误' })
  }
}
const who = (user) => ({ id: String(user?.id || ''), name: String(user?.displayName || user?.username || '') })
const safeText = (value, max = 200) => String(value || '').trim().slice(0, max)
const requireDb = () => { if (!dbReady()) throw httpError('数据库未配置', 503) }
const requireAdmin = (req, capability = SWEET_CARD_CAPABILITIES.VIEW) => {
  if (!hasModuleAccess(req.user, MODULE_KEYS.SWEET_CARD) || !hasSweetCardCapability(req.user, capability)) throw httpError('无甜意卡权限', 403)
  requireSweetCardProductionTestAccess(req.user)
}
const requirePos = (req) => {
  if (!hasModuleAccess(req.user, MODULE_KEYS.STORE_POS)) throw httpError('无 POS 权限', 403)
}
const audit = (tx, actor, action, refs = {}, metadata = {}) => tx.sweetCardAuditLog.create({ data: {
  id: `sca-${crypto.randomUUID()}`, action, actorId: actor.id, actorName: actor.name,
  batchId: refs.batchId || null, accountId: refs.accountId || null, credentialId: refs.credentialId || null, metadata,
} })
const effectiveStatus = (row) => row.status === 'ACTIVE' && row.expiresAt && row.expiresAt <= new Date() ? 'EXPIRED' : row.status
const serializeCard = (row, detail = false) => ({
  id: row.id, publicCardNo: row.publicCardNo, batchId: row.batchId,
  initialAmountCents: row.initialAmountCents.toString(), balanceCents: row.balanceCents.toString(),
  validityType: row.validityType, validFrom: row.validFrom, expiresAt: row.expiresAt, status: effectiveStatus(row),
  carrierType: row.carrierType, bindingMode: row.bindingMode,
  recipientType: row.recipientType, recipientLabel: row.recipientLabel, recipientCompany: row.recipientCompany,
  recipientNote: row.recipientNote, giftingScenario: row.giftingScenario, issuedByName: row.issuedByName,
  issuedAt: row.issuedAt, activatedAt: row.activatedAt, createdAt: row.createdAt,
  binding: row.binding ? { memberId: row.binding.memberId, boundAt: row.binding.boundAt, verificationMethod: row.binding.verificationMethod } : null,
  credentials: (row.credentials || []).map((credential) => ({ id: credential.id, status: credential.status, carrierType: credential.carrierType, activatedAt: credential.activatedAt, revokedAt: credential.revokedAt })),
  ...(detail ? { ledger: (row.ledger || []).map((entry) => ({ ...entry, amountCents: entry.amountCents.toString(), balanceAfterCents: entry.balanceAfterCents.toString() })) } : {}),
})

async function accountByCredential(tx, token) {
  if (!isSweetCardToken(token) || token.length > 180) throw httpError('不是有效的 budu 甜意卡二维码')
  return tx.sweetCardCredential.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { account: { include: { binding: true } } },
  })
}

async function loadEligibility(tx, order) {
  const policy = await tx.sweetCardStorePolicy.findUnique({ where: { storeId: order.storeId } })
  if (!policy?.eligible) throw httpError('当前门店未开放甜意卡核销', 403)
  const blocked = new Set((await tx.sweetCardCategoryPolicy.findMany({ where: { blocked: true }, select: { categoryId: true } })).map((row) => row.categoryId))
  const lines = order.items.map((item) => {
    const categoryId = item.product?.productCategoryId || null
    const eligible = item.isGift !== true && !blocked.has(categoryId)
    return { id: item.id, item, categoryId, eligible, eligibleAmountCents: eligible ? BigInt(item.actualAmount) : 0n }
  })
  const eligibleSubtotal = lines.reduce((sum, line) => sum + line.eligibleAmountCents, 0n)
  return { lines, eligibleSubtotal, ineligibleSubtotal: BigInt(order.payableAmount) - eligibleSubtotal }
}

export async function inspectSweetCard({ orderId, token, actor }) {
  assertSweetCardEnabled()
  const [order, credential] = await Promise.all([
    prisma.order.findUnique({ where: { id: orderId }, include: { items: { include: { product: true } }, sweetCardRedemption: true } }),
    accountByCredential(prisma, token),
  ])
  if (!order) throw httpError('订单不存在', 404)
  if (!credential) throw httpError('甜意卡 credential 无效', 404)
  const account = credential.account
  const eligibility = await loadEligibility(prisma, order)
  const usable = credential.status === 'ACTIVE' && account.status === 'ACTIVE'
    && (!account.expiresAt || account.expiresAt > new Date())
    && (account.bindingMode !== 'REQUIRED' || Boolean(account.binding))
    && !order.sweetCardRedemption
  const maximum = usable ? [account.balanceCents, eligibility.eligibleSubtotal, BigInt(order.payableAmount)].reduce((a, b) => a < b ? a : b) : 0n
  return {
    publicCardNo: account.publicCardNo, status: account.status, credentialStatus: credential.status,
    balanceCents: account.balanceCents.toString(), expiresAt: account.expiresAt, bindingMode: account.bindingMode,
    bound: Boolean(account.binding), eligibleSubtotalCents: eligibility.eligibleSubtotal.toString(),
    ineligibleSubtotalCents: eligibility.ineligibleSubtotal.toString(), maximumRedeemableCents: maximum.toString(),
    remainingPayableCents: (BigInt(order.payableAmount) - maximum).toString(), usable,
  }
}

export async function redeemSweetCard({ orderId, token, amountCents, requestKey, actor }) {
  assertSweetCardEnabled()
  if (String(requestKey || '').length < 8 || String(requestKey || '').length > 160) throw httpError('核销幂等键不正确')
  const replay = await prisma.sweetCardRedemption.findUnique({ where: { requestKey: String(requestKey) } })
  if (replay) {
    if (replay.orderId !== orderId) throw httpError('核销幂等键已用于其他订单', 409)
    return { reused: true, redemption: replay, order: await prisma.order.findUnique({ where: { id: orderId } }) }
  }
  return prisma.$transaction(async (tx) => {
    await settlementCoordinator.lockOrder(tx, orderId)
    const credential = await accountByCredential(tx, token)
    if (!credential) throw httpError('甜意卡 credential 无效', 404)
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS locked', credential.accountId)
    const account = await tx.sweetCardAccount.findUnique({ where: { id: credential.accountId }, include: { binding: true } })
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: { include: { product: true } }, sweetCardRedemption: true } })
    if (!order) throw httpError('订单不存在', 404)
    if (order.status !== 'pending_payment' || !['unpaid', 'failed'].includes(order.paymentStatus)) throw httpError('当前订单不可核销甜意卡', 409)
    if (order.sweetCardRedemption || order.sweetCardAmount > 0n) throw httpError('一笔订单最多使用一张甜意卡', 409)
    if (credential.status !== 'ACTIVE' || account.status !== 'ACTIVE') throw httpError('甜意卡未激活或不可用', 409)
    if (account.expiresAt && account.expiresAt <= new Date()) throw httpError('甜意卡已过期', 409)
    if (account.bindingMode === 'REQUIRED' && !account.binding) throw httpError('该甜意卡需先完成身份绑定', 409)
    const eligibility = await loadEligibility(tx, order)
    const maximum = [account.balanceCents, eligibility.eligibleSubtotal, BigInt(order.payableAmount)].reduce((a, b) => a < b ? a : b)
    if (maximum <= 0n) throw httpError('当前订单没有甜意卡可用商品', 409)
    const amount = amountCents == null ? maximum : parseAmount(amountCents, '核销金额')
    if (amount > maximum) throw httpError('核销金额超过本单可用额度', 409)
    const allocated = allocateCents(amount, eligibility.lines)
    const redemptionId = `scr-${crypto.randomUUID()}`
    const redemptionNo = `SCR${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(5).toString('hex').toUpperCase()}`
    const balanceAfter = account.balanceCents - amount
    const redemption = await tx.sweetCardRedemption.create({ data: {
      id: redemptionId, redemptionNo, orderId, accountId: account.id, credentialId: credential.id,
      amountCents: amount, eligibleSubtotalCents: eligibility.eligibleSubtotal, ineligibleSubtotalCents: eligibility.ineligibleSubtotal,
      requestKey: String(requestKey), storeIdSnapshot: order.storeId, redeemedById: actor.id, redeemedByName: actor.name,
      items: { create: allocated.map((line) => ({
        id: `sri-${crypto.randomUUID()}`, orderItemId: line.item.id, productId: line.item.productId,
        categoryIdSnapshot: line.categoryId, eligibleSnapshot: line.eligible,
        eligibleAmountCents: line.eligibleAmountCents, redeemedAmountCents: line.redeemedAmountCents,
      })) },
    } })
    for (const line of allocated) await tx.orderItem.update({ where: { id: line.item.id }, data: {
      sweetCardEligibleSnapshot: line.eligible, sweetCardCategoryIdSnapshot: line.categoryId,
      sweetCardRedeemedAmount: line.redeemedAmountCents,
    } })
    await tx.sweetCardLedger.create({ data: {
      id: `scl-${crypto.randomUUID()}`, accountId: account.id, type: 'REDEEM', amountCents: -amount,
      balanceAfterCents: balanceAfter, orderId, redemptionId, requestKey: `redeem:${requestKey}`,
      actorId: actor.id, actorName: actor.name, metadata: { storeId: order.storeId },
    } })
    await tx.sweetCardAccount.update({ where: { id: account.id }, data: {
      balanceCents: balanceAfter, status: balanceAfter === 0n ? 'EXHAUSTED' : 'ACTIVE', version: { increment: 1 },
    } })
    await tx.order.update({ where: { id: order.id }, data: { sweetCardAmount: amount, ...(amount === order.payableAmount ? { paymentStatus: 'pending' } : {}), version: { increment: 1 } } })
    await audit(tx, actor, 'sweet_card.redeemed', { accountId: account.id, credentialId: credential.id }, { orderId, amountCents: amount.toString(), storeId: order.storeId })
    let settledOrder = await tx.order.findUnique({ where: { id: order.id } })
    if (amount === order.payableAmount) settledOrder = await settlementCoordinator.settleSweetCard(tx, { orderId: order.id })
    return { reused: false, redemption, order: settledOrder }
  }, { isolationLevel: 'Serializable' })
}

sweetCardRouter.get('/sweet-cards/config', wrap(async (req, res) => {
  const productionTestAllowed = hasSweetCardProductionTestAccess(req.user)
  res.json({ enabled: sweetCardEnabled() && productionTestAllowed, productionTestAllowed, presentation: SWEET_CARD_PRESENTATION_CONTRACT })
}))

const requireAllowlistAdmin = (req) => {
  if (!canManageAccounts(req.user)) throw httpError('仅开发者可管理生产测试名单', 403)
}

sweetCardRouter.get('/sweet-cards/production-test-allowlist', wrap(async (req, res) => {
  requireDb(); requireAllowlistAdmin(req)
  const users = await prisma.user.findMany({ where: { status: { not: 'disabled' } }, orderBy: { createdAt: 'asc' } })
  res.json({ principals: users.filter(hasSweetCardProductionTestAccess).map((user) => ({ id: user.id, role: user.role })) })
}))

sweetCardRouter.put('/sweet-cards/production-test-allowlist/:principalId', wrap(async (req, res) => {
  requireDb(); requireAllowlistAdmin(req)
  if (typeof req.body?.enabled !== 'boolean') throw httpError('enabled 必须为布尔值')
  const actor = who(req.user)
  const target = await prisma.user.findUnique({ where: { id: req.params.principalId } })
  if (!target || target.status === 'disabled' || target.role === 'public') throw httpError('测试账号不存在或不可用', 404)
  if (req.body.enabled && !hasModuleAccess(target, MODULE_KEYS.STORE_POS)) throw httpError('测试账号缺少 POS 原始权限', 409)
  const before = hasSweetCardProductionTestAccess(target)
  const permissions = {
    ...normalizeAccountPermissions(target.permissions, target.role, target.assetCenter === true),
    [ACCOUNT_PERMISSION_KEYS.SWEET_CARD_PRODUCTION_TEST]: req.body.enabled,
  }
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: target.id }, data: {
      permissions,
      permissionsUpdatedAt: new Date(),
      permissionsUpdatedBy: req.user.username,
    } })
    await audit(tx, actor, req.body.enabled ? 'sweet_card.production_test_allowlist_enabled' : 'sweet_card.production_test_allowlist_disabled', {}, {
      targetPrincipalId: target.id,
      before,
      after: req.body.enabled,
      change: req.body.enabled ? 'ADD' : 'REMOVE',
    })
  })
  await mirrorUsersToKv()
  res.json({ ok: true, principal: { id: target.id, role: target.role, enabled: req.body.enabled } })
}))

sweetCardRouter.get('/sweet-cards/overview', wrap(async (req, res) => {
  requireDb(); requireAdmin(req); assertSweetCardEnabled()
  const [groups, sums, expired, issued] = await Promise.all([
    prisma.sweetCardAccount.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.sweetCardAccount.aggregate({ _count: { _all: true }, _sum: { initialAmountCents: true, balanceCents: true } }),
    prisma.sweetCardAccount.count({ where: { status: 'ACTIVE', expiresAt: { lte: new Date() } } }),
    prisma.sweetCardAccount.count({ where: { issuedAt: { not: null } } }),
  ])
  const statusCounts = Object.fromEntries(groups.map((row) => [row.status, row._count._all]))
  statusCounts.ACTIVE = Math.max(0, (statusCounts.ACTIVE || 0) - expired); statusCounts.EXPIRED = (statusCounts.EXPIRED || 0) + expired
  res.json({ statusCounts, count: sums._count._all, issued,
    initialAmountCents: String(sums._sum.initialAmountCents || 0), balanceCents: String(sums._sum.balanceCents || 0) })
}))

sweetCardRouter.get('/sweet-cards/cards', wrap(async (req, res) => {
  requireDb(); requireAdmin(req); assertSweetCardEnabled()
  const where = {}
  if (req.query.status) where.status = String(req.query.status)
  if (req.query.batchId) where.batchId = String(req.query.batchId)
  const cards = await prisma.sweetCardAccount.findMany({ where, orderBy: { createdAt: 'desc' }, take: 300, include: { binding: true, credentials: true } })
  res.json({ cards: cards.map((row) => serializeCard(row)) })
}))

sweetCardRouter.get('/sweet-cards/cards/:id', wrap(async (req, res) => {
  requireDb(); requireAdmin(req); assertSweetCardEnabled()
  const card = await prisma.sweetCardAccount.findUnique({ where: { id: req.params.id }, include: { binding: true, credentials: true, ledger: { orderBy: { createdAt: 'desc' } } } })
  if (!card) throw httpError('甜意卡不存在', 404)
  res.json({ card: serializeCard(card, true) })
}))

sweetCardRouter.get('/sweet-cards/usage', wrap(async (req, res) => {
  requireDb(); requireAdmin(req); assertSweetCardEnabled()
  const redemptions = await prisma.sweetCardRedemption.findMany({
    orderBy: { createdAt: 'desc' }, take: 300,
    include: { account: { select: { publicCardNo: true } }, order: { select: { orderNo: true } } },
  })
  res.json({ redemptions: redemptions.map((row) => ({
    id: row.id, redemptionNo: row.redemptionNo, orderId: row.orderId, orderNo: row.order.orderNo,
    publicCardNo: row.account.publicCardNo, storeId: row.storeIdSnapshot,
    amountCents: row.amountCents.toString(), eligibleSubtotalCents: row.eligibleSubtotalCents.toString(),
    ineligibleSubtotalCents: row.ineligibleSubtotalCents.toString(), redeemedByName: row.redeemedByName, createdAt: row.createdAt,
  })) })
}))

sweetCardRouter.get('/sweet-cards/batches', wrap(async (req, res) => {
  requireDb(); requireAdmin(req); assertSweetCardEnabled()
  const batches = await prisma.sweetCardBatch.findMany({ orderBy: { createdAt: 'desc' }, include: { accounts: { select: { status: true, balanceCents: true, initialAmountCents: true, issuedAt: true } } } })
  res.json({ batches: batches.map(({ accounts, ...batch }) => ({ ...batch, faceValueCents: batch.faceValueCents.toString(), totalInitialAmountCents: batch.totalInitialAmountCents.toString(), metrics: {
    issued: accounts.filter((a) => a.issuedAt).length, activated: accounts.filter((a) => ['ACTIVE', 'EXHAUSTED'].includes(a.status)).length,
    consumedCents: accounts.reduce((sum, a) => sum + a.initialAmountCents - a.balanceCents, 0n).toString(),
    balanceCents: accounts.reduce((sum, a) => sum + a.balanceCents, 0n).toString(),
  } })) })
}))

sweetCardRouter.post('/sweet-cards/batches', wrap(async (req, res) => {
  requireDb(); requireAdmin(req, SWEET_CARD_CAPABILITIES.ISSUE); assertSweetCardEnabled()
  const actor = who(req.user)
  const count = Number(req.body?.cardCount)
  const faceValue = parseAmount(req.body?.faceValueCents, '面额')
  if (!Number.isInteger(count) || count < 1 || count > 500) throw httpError('制卡数量必须为 1–500')
  const validityType = String(req.body?.validityType || '')
  const carrierType = String(req.body?.carrierType || '')
  const bindingMode = String(req.body?.bindingMode || '')
  if (!['ONE_YEAR', 'THREE_YEARS', 'LONG_TERM'].includes(validityType)) throw httpError('有效期不正确')
  if (!['PHYSICAL', 'ELECTRONIC'].includes(carrierType)) throw httpError('载体不正确')
  if (!['NONE', 'OPTIONAL', 'REQUIRED'].includes(bindingMode)) throw httpError('绑定模式不正确')
  const activateNow = carrierType === 'ELECTRONIC' && req.body?.activateNow === true
  const batchId = `scb-${crypto.randomUUID()}`
  const now = new Date()
  const cards = await prisma.$transaction(async (tx) => {
    await tx.sweetCardBatch.create({ data: {
      id: batchId, name: safeText(req.body?.name, 100) || '未命名批次', purpose: safeText(req.body?.purpose, 300),
      faceValueCents: faceValue, cardCount: count, totalInitialAmountCents: faceValue * BigInt(count), validityType,
      carrierType, bindingMode, giftingScenario: safeText(req.body?.giftingScenario, 120),
      presentationTemplateKey: safeText(req.body?.presentationTemplateKey, 50) || 'minimal-v1', createdById: actor.id, createdByName: actor.name,
    } })
    const result = []
    for (let index = 0; index < count; index += 1) {
      const accountId = `scv-${crypto.randomUUID()}`
      const credentialId = `scc-${crypto.randomUUID()}`
      const generated = newCredential()
      const publicCardNo = `SC${now.getUTCFullYear()}${crypto.randomBytes(6).toString('hex').toUpperCase()}`
      const active = activateNow
      const validFrom = active ? now : null
      const expiresAt = active ? expiryFor(validityType, now) : null
      await tx.sweetCardAccount.create({ data: {
        id: accountId, publicCardNo, batchId, initialAmountCents: faceValue, balanceCents: faceValue,
        validityType, validFrom, expiresAt, status: active ? 'ACTIVE' : 'CREATED', carrierType, bindingMode,
        recipientType: safeText(req.body?.recipientType, 60), recipientLabel: safeText(req.body?.recipientLabel, 120),
        recipientCompany: safeText(req.body?.recipientCompany, 120), recipientNote: safeText(req.body?.recipientNote, 300),
        giftingScenario: safeText(req.body?.giftingScenario, 120), issuedById: actor.id, issuedByName: actor.name, issuedAt: now,
        activatedById: active ? actor.id : '', activatedAt: active ? now : null,
        credentials: { create: { id: credentialId, publicTokenId: generated.publicTokenId, tokenHash: generated.tokenHash,
          tokenCiphertext: generated.ciphertext, tokenIv: generated.iv, tokenTag: generated.tag, status: active ? 'ACTIVE' : 'UNACTIVATED', carrierType, activatedAt: active ? now : null } },
        ledger: { create: { id: `scl-${crypto.randomUUID()}`, type: 'ISSUE', amountCents: faceValue, balanceAfterCents: faceValue,
          requestKey: `issue:${batchId}:${index}`, actorId: actor.id, actorName: actor.name, metadata: { batchId } } },
      } })
      result.push({ accountId, publicCardNo })
    }
    await audit(tx, actor, 'sweet_card.batch_created', { batchId }, { cardCount: count, faceValueCents: faceValue.toString(), carrierType, bindingMode })
    return result
  })
  res.status(201).json({ ok: true, batchId, cards, exportReady: true })
}))

async function cardTransition(req, action) {
  const actor = who(req.user)
  const capability = action === 'VOID' ? SWEET_CARD_CAPABILITIES.VOID : action === 'FROZEN' || action === 'UNFREEZE' ? SWEET_CARD_CAPABILITIES.FREEZE : SWEET_CARD_CAPABILITIES.ACTIVATE
  requireAdmin(req, capability); assertSweetCardEnabled()
  return prisma.$transaction(async (tx) => {
    const card = await tx.sweetCardAccount.findUnique({ where: { id: req.params.id }, include: { credentials: { where: { status: { not: 'REVOKED' } } } } })
    if (!card) throw httpError('甜意卡不存在', 404)
    const now = new Date()
    let status = action === 'UNFREEZE' ? 'ACTIVE' : action
    if (action === 'ACTIVE') {
      if (!['CREATED', 'FROZEN'].includes(card.status)) throw httpError('当前状态不可激活', 409)
      status = card.balanceCents === 0n ? 'EXHAUSTED' : 'ACTIVE'
      await tx.sweetCardCredential.updateMany({ where: { accountId: card.id, status: 'UNACTIVATED' }, data: { status: 'ACTIVE', activatedAt: now } })
    } else if (action === 'FROZEN' && card.status !== 'ACTIVE') throw httpError('仅 ACTIVE 卡可冻结', 409)
    else if (action === 'UNFREEZE' && card.status !== 'FROZEN') throw httpError('仅 FROZEN 卡可解冻', 409)
    else if (action === 'VOID' && ['EXHAUSTED', 'VOID'].includes(card.status)) throw httpError('当前状态不可作废', 409)
    const data = { status, version: { increment: 1 } }
    if (action === 'ACTIVE') Object.assign(data, { validFrom: card.validFrom || now, expiresAt: card.expiresAt || expiryFor(card.validityType, card.validFrom || now), activatedById: actor.id, activatedAt: card.activatedAt || now })
    await tx.sweetCardAccount.update({ where: { id: card.id }, data })
    if (action === 'VOID') await tx.sweetCardCredential.updateMany({ where: { accountId: card.id, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', revokedAt: now, revokeReason: 'CARD_VOID' } })
    await audit(tx, actor, `sweet_card.${action.toLowerCase()}`, { accountId: card.id }, { before: card.status, after: status })
    return tx.sweetCardAccount.findUnique({ where: { id: card.id }, include: { binding: true, credentials: true } })
  })
}

for (const [path, action] of [['activate', 'ACTIVE'], ['freeze', 'FROZEN'], ['unfreeze', 'UNFREEZE'], ['void', 'VOID']]) {
  sweetCardRouter.post(`/sweet-cards/cards/:id/${path}`, wrap(async (req, res) => { requireDb(); res.json({ card: serializeCard(await cardTransition(req, action)) }) }))
}

sweetCardRouter.post('/sweet-cards/cards/:id/bind', wrap(async (req, res) => {
  requireDb(); requireAdmin(req, SWEET_CARD_CAPABILITIES.MANAGE); assertSweetCardEnabled()
  const actor = who(req.user); const memberId = safeText(req.body?.memberId, 100)
  const card = await prisma.sweetCardAccount.findUnique({ where: { id: req.params.id }, include: { binding: true } })
  if (!card) throw httpError('甜意卡不存在', 404)
  if (card.bindingMode === 'NONE') throw httpError('该卡不允许绑定', 409)
  if (card.binding) throw httpError('甜意卡已绑定', 409)
  if (!await prisma.member.findUnique({ where: { id: memberId } })) throw httpError('客户身份不存在', 404)
  const binding = await prisma.sweetCardBinding.create({ data: { id: `scbind-${crypto.randomUUID()}`, accountId: card.id, memberId, boundById: actor.id, boundByName: actor.name } })
  await audit(prisma, actor, 'sweet_card.bound', { accountId: card.id }, { memberId })
  res.status(201).json({ binding })
}))

sweetCardRouter.post('/sweet-cards/cards/:id/lost', wrap(async (req, res) => {
  requireDb(); requireAdmin(req, SWEET_CARD_CAPABILITIES.FREEZE); assertSweetCardEnabled()
  const actor = who(req.user); const now = new Date()
  const card = await prisma.$transaction(async (tx) => {
    const current = await tx.sweetCardAccount.findUnique({ where: { id: req.params.id }, include: { binding: true } })
    if (!current) throw httpError('甜意卡不存在', 404)
    if (!current.binding) throw httpError('只有已合法绑定的卡可挂失', 409)
    if (!['ACTIVE', 'FROZEN'].includes(current.status)) throw httpError('当前状态不可挂失', 409)
    await tx.sweetCardCredential.updateMany({ where: { accountId: current.id, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', revokedAt: now, revokeReason: 'LOST' } })
    await tx.sweetCardAccount.update({ where: { id: current.id }, data: { status: 'LOST', version: { increment: 1 } } })
    await audit(tx, actor, 'sweet_card.lost', { accountId: current.id }, { before: current.status, after: 'LOST' })
    return tx.sweetCardAccount.findUnique({ where: { id: current.id }, include: { binding: true, credentials: true } })
  })
  res.json({ card: serializeCard(card) })
}))

sweetCardRouter.post('/sweet-cards/cards/:id/replace', wrap(async (req, res) => {
  requireDb(); requireAdmin(req, SWEET_CARD_CAPABILITIES.MANAGE); assertSweetCardEnabled()
  const actor = who(req.user)
  const result = await prisma.$transaction(async (tx) => {
    const card = await tx.sweetCardAccount.findUnique({ where: { id: req.params.id }, include: { binding: true, credentials: { where: { status: 'REVOKED', revokeReason: 'LOST' }, orderBy: { revokedAt: 'desc' }, take: 1 } } })
    if (!card) throw httpError('甜意卡不存在', 404)
    if (!card.binding || card.status !== 'LOST') throw httpError('仅已绑定且已挂失的卡可补发', 409)
    const generated = newCredential(); const credentialId = `scc-${crypto.randomUUID()}`; const now = new Date()
    await tx.sweetCardCredential.create({ data: { id: credentialId, accountId: card.id, publicTokenId: generated.publicTokenId,
      tokenHash: generated.tokenHash, tokenCiphertext: generated.ciphertext, tokenIv: generated.iv, tokenTag: generated.tag,
      status: 'ACTIVE', carrierType: card.carrierType, activatedAt: now } })
    if (card.credentials[0]) await tx.sweetCardCredential.update({ where: { id: card.credentials[0].id }, data: { replacedByCredentialId: credentialId } })
    await tx.sweetCardAccount.update({ where: { id: card.id }, data: { status: card.balanceCents === 0n ? 'EXHAUSTED' : 'ACTIVE', version: { increment: 1 } } })
    await audit(tx, actor, 'sweet_card.credential_replaced', { accountId: card.id, credentialId }, { valueAccountUnchanged: true })
    return { accountId: card.id, credentialId }
  })
  res.status(201).json({ ok: true, ...result, exportRequired: true })
}))

sweetCardRouter.get('/sweet-cards/batches/:id/export', wrap(async (req, res) => {
  requireDb(); requireAdmin(req, SWEET_CARD_CAPABILITIES.ISSUE); assertSweetCardEnabled()
  const actor = who(req.user)
  const batch = await prisma.sweetCardBatch.findUnique({ where: { id: req.params.id }, include: { accounts: { include: { credentials: { where: { status: { not: 'REVOKED' } }, take: 1 } } } } })
  if (!batch) throw httpError('批次不存在', 404)
  const zip = new JSZip(); const manifest = [['cardNo', 'faceValueCents', 'validityType', 'carrierType', 'qrFile'].join(',')]
  for (const card of batch.accounts) {
    const credential = card.credentials[0]; if (!credential) continue
    const svg = await QRCode.toString(decryptToken(credential), { type: 'svg', errorCorrectionLevel: 'H', margin: 4, width: 1200 })
    const name = `${card.publicCardNo}.svg`; zip.file(name, svg)
    manifest.push([card.publicCardNo, card.initialAmountCents.toString(), card.validityType, card.carrierType, name].join(','))
  }
  zip.file('manifest.csv', `\uFEFF${manifest.join('\n')}`)
  const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  await audit(prisma, actor, 'sweet_card.qr_exported', { batchId: batch.id }, { cardCount: batch.accounts.length })
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/zip'); res.setHeader('Content-Disposition', `attachment; filename="${batch.id}.zip"`); res.send(output)
}))

sweetCardRouter.get('/sweet-cards/cards/:id/presentation', wrap(async (req, res) => {
  requireDb(); requireAdmin(req, SWEET_CARD_CAPABILITIES.ISSUE); assertSweetCardEnabled()
  const card = await prisma.sweetCardAccount.findUnique({ where: { id: req.params.id }, include: { credentials: { where: { status: { not: 'REVOKED' } }, take: 1 } } })
  if (!card?.credentials[0]) throw httpError('卡片或 credential 不存在', 404)
  const qrDataUrl = await QRCode.toDataURL(decryptToken(card.credentials[0]), { errorCorrectionLevel: 'H', margin: 4, width: 800 })
  const svg = renderMinimalSweetCard({ publicCardNo: card.publicCardNo, faceValueText: `¥${(Number(card.initialAmountCents) / 100).toFixed(2)}`,
    expiryCopy: card.expiresAt ? `有效期至 ${card.expiresAt.toISOString().slice(0, 10)}` : card.validityType === 'LONG_TERM' ? '长期有效' : '激活后生效',
    recipient: card.recipientLabel ? `赠予 ${card.recipientLabel}` : '', qrDataUrl })
  await audit(prisma, who(req.user), 'sweet_card.presentation_exported', { accountId: card.id, credentialId: card.credentials[0].id }, { templateKey: 'minimal-v1' })
  res.setHeader('Cache-Control', 'no-store'); res.type('image/svg+xml').send(svg)
}))

sweetCardRouter.get('/sweet-cards/rules', wrap(async (req, res) => {
  requireDb(); requireAdmin(req); assertSweetCardEnabled()
  const [stores, categories] = await Promise.all([
    prisma.store.findMany({ orderBy: { name: 'asc' }, include: { sweetCardPolicy: true } }),
    prisma.productCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: { sweetCardPolicy: true } }),
  ])
  res.json({ stores: stores.map((s) => ({ id: s.key, name: s.name, eligible: s.sweetCardPolicy?.eligible === true })), categories: categories.map((c) => ({ id: c.id, name: c.name, blocked: c.sweetCardPolicy?.blocked === true })) })
}))

sweetCardRouter.put('/sweet-cards/rules', wrap(async (req, res) => {
  requireDb(); requireAdmin(req, SWEET_CARD_CAPABILITIES.MANAGE); assertSweetCardEnabled()
  const actor = who(req.user); const eligibleStoreIds = new Set((req.body?.eligibleStoreIds || []).map(String)); const blockedCategoryIds = new Set((req.body?.blockedCategoryIds || []).map(String))
  const [stores, categories] = await Promise.all([prisma.store.findMany({ select: { key: true } }), prisma.productCategory.findMany({ select: { id: true } })])
  if ([...eligibleStoreIds].some((id) => !stores.some((s) => s.key === id)) || [...blockedCategoryIds].some((id) => !categories.some((c) => c.id === id))) throw httpError('规则包含无效权威 ID')
  await prisma.$transaction(async (tx) => {
    for (const store of stores) await tx.sweetCardStorePolicy.upsert({ where: { storeId: store.key }, create: { storeId: store.key, eligible: eligibleStoreIds.has(store.key), updatedById: actor.id, updatedByName: actor.name }, update: { eligible: eligibleStoreIds.has(store.key), updatedById: actor.id, updatedByName: actor.name } })
    for (const category of categories) {
      if (blockedCategoryIds.has(category.id)) await tx.sweetCardCategoryPolicy.upsert({ where: { categoryId: category.id }, create: { categoryId: category.id, blocked: true, updatedById: actor.id, updatedByName: actor.name }, update: { blocked: true, updatedById: actor.id, updatedByName: actor.name } })
      else await tx.sweetCardCategoryPolicy.deleteMany({ where: { categoryId: category.id } })
    }
    await audit(tx, actor, 'sweet_card.rules_updated', {}, { eligibleStoreIds: [...eligibleStoreIds], blockedCategoryIds: [...blockedCategoryIds] })
  })
  res.json({ ok: true })
}))

sweetCardRouter.get('/sweet-cards/audit', wrap(async (req, res) => {
  requireDb(); requireAdmin(req, SWEET_CARD_CAPABILITIES.AUDIT); assertSweetCardEnabled()
  res.json({ events: await prisma.sweetCardAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 500 }) })
}))

sweetCardRouter.post('/pos/orders/:id/sweet-card/inspect', wrap(async (req, res) => {
  requireDb(); requirePos(req); requireSweetCardProductionTestAccess(req.user); assertSweetCardEnabled()
  const order = await prisma.order.findUnique({ where: { id: req.params.id } }); if (!order) throw httpError('订单不存在', 404)
  if (!(req.user.role === 'developer' || req.user.role === 'admin' || req.user.role === 'finance' || (req.user.storeKeys || []).includes(order.storeId))) throw httpError('无权操作该门店订单', 403)
  res.json({ card: await inspectSweetCard({ orderId: order.id, token: req.body?.token, actor: who(req.user) }) })
}))

sweetCardRouter.post('/pos/orders/:id/sweet-card/redeem', wrap(async (req, res) => {
  requireDb(); requirePos(req); requireSweetCardProductionTestAccess(req.user); assertSweetCardEnabled()
  const order = await prisma.order.findUnique({ where: { id: req.params.id } }); if (!order) throw httpError('订单不存在', 404)
  if (!(req.user.role === 'developer' || req.user.role === 'admin' || req.user.role === 'finance' || (req.user.storeKeys || []).includes(order.storeId))) throw httpError('无权操作该门店订单', 403)
  const result = await redeemSweetCard({ orderId: order.id, token: req.body?.token, amountCents: req.body?.amountCents, requestKey: req.body?.requestKey, actor: who(req.user) })
  res.status(result.reused ? 200 : 201).json({ ok: true, reused: result.reused, redemption: { ...result.redemption, amountCents: result.redemption.amountCents.toString() }, order: { ...result.order, payableAmount: result.order.payableAmount.toString(), sweetCardAmount: result.order.sweetCardAmount.toString() } })
}))
