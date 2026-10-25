import crypto from 'node:crypto'
import { MODULE_KEYS, hasModuleAccess, isSuperUser } from '../shared/accountPermissions.js'
import { httpError } from './customer-request-core.js'
import { selectServiceTemplate } from './store-service-notifications.js'

export const sceneHash = scene => /^[a-f0-9]{32}$/.test(scene || '') ? crypto.createHash('sha256').update(scene).digest('hex') : ''
const uid = prefix => `${prefix}-${crypto.randomUUID()}`
export const ownsService = (r, c) => r && r.customerUserId === c.userId && r.customerAppId === c.appId && r.customerEnvId === c.envId
export function assertServiceStaff(user, r, { confirm = false } = {}) {
  const module = r.type === 'MAILING' ? MODULE_KEYS.STORE_MAILING : MODULE_KEYS.FINANCE_INVOICE
  if (!user || user.status === 'disabled' || (confirm && user.role !== 'developer') || !hasModuleAccess(user, module)
      || !(isSuperUser(user) || user.storeKeys?.includes(r.storeKey))) throw httpError('无权限', 403)
}
export function requestPresentation(r, storeName = '') {
  return { id: r.id, type: r.type, storeKey: r.storeKey, storeName, status: r.status, expiresAt: r.expiresAt,
    submittedAt: r.submittedAt, createdAt: r.createdAt, requestMetadata: r.requestMetadata,
    customerBound: Boolean(r.customerUserId), receiptConfirmedAt: r.receiptConfirmedAt,
    receiptConfirmedBy: r.receiptConfirmedBy, shipmentConfirmedAt: r.shipmentConfirmedAt,
    shipmentConfirmedBy: r.shipmentConfirmedBy, carrier: r.carrier, trackingNo: r.trackingNo, deliveryProof: r.deliveryProof }
}
export async function serviceDetail(db, requestId, customer, staff = null) {
  if (typeof requestId !== 'string' || requestId.length > 100) throw httpError('申请不存在', 404)
  const r = await db.customerServiceRequest.findUnique({ where: { id: requestId }, include: { store: true } })
  if (!r || (!staff && !ownsService(r, customer))) throw httpError('申请不存在', 404)
  if (staff) assertServiceStaff(staff, r)
  const unavailableRecord = () => Object.assign(httpError(r.type === 'INVOICE' ? '开票记录不可用' : '邮寄记录不可用', 409), { code: 'SERVICE_RECORD_UNAVAILABLE' })
  if (r.status === 'SUBMITTED' && !r.linkedBusinessRecordId) throw unavailableRecord()
  const deliveries = await db.storeServiceDelivery.findMany({ where: { requestId }, orderBy: { createdAt: 'desc' },
    select: { id: true, event: true, status: true, attempts: true, platformCode: true, acceptedAt: true, createdAt: true } })
  const request = requestPresentation(r, r.store.name)
  // Employee identifiers and internal notification diagnostics are staff-only.
  if (!staff) { delete request.receiptConfirmedBy; delete request.shipmentConfirmedBy; delete request.requestMetadata }
  let mailing = null, invoice = null
  if (r.linkedBusinessRecordId && r.type === 'MAILING') {
    const m = await db.mailingRecord.findUnique({ where: { id: r.linkedBusinessRecordId } })
    if (!m || m.deletedAt || m.storeKey !== r.storeKey) throw unavailableRecord()
    mailing = { recipient: m.recipient, phone: m.phone, address: m.address, remark: m.remark,
      method: m.method, postage: m.postage, carrier: r.carrier, trackingNo: r.trackingNo,
      deliveryProof: r.deliveryProof, confirmedAt: r.shipmentConfirmedAt, status: m.status, logisticsStatus: 'NOT_CONNECTED' }
  } else if (r.linkedBusinessRecordId && r.type === 'INVOICE') {
    const i = await db.invoice.findUnique({ where: { id: r.linkedBusinessRecordId } })
    if (!i || i.deletedAt || i.storeKey !== r.storeKey) throw unavailableRecord()
    invoice = { invoiceTitle: i.companyName, titleType: i.titleType, taxNo: i.taxNo, email: i.email,
      amountCents: String(i.amountCents), category: i.category, note: i.note, status: i.status, receivedAt: r.receiptConfirmedAt }
  }
  if (staff) request.notifications = deliveries
  return { request, mailing, invoice, notification: deliveries[0] ? { status: deliveries[0].status } : { status: 'NOT_CREATED' } }
}
export async function recordServiceVisit(db, r, customer, event) {
  // Analytics is deliberately best effort and can never fail a service operation.
  try {
    await db.storeServiceVisit.upsert({ where: { requestId_userId_event: { requestId: r.id, userId: customer.userId, event } },
      update: {}, create: { id: uid('ssv'), requestId: r.id, userId: customer.userId, event } })
  } catch { /* aggregate health, never customer data */ }
}
function publicMetadata(metadata = {}) {
  const result = {}
  for (const key of ['method', 'postage', 'shippingTier', 'shippingAmountCents', 'shippingPaymentMode', 'amountCents', 'category']) {
    if (metadata[key] !== undefined) result[key] = metadata[key]
  }
  return result
}
export async function resolveServiceScene(db, scene, customer, now = new Date()) {
  const hash = sceneHash(scene)
  if (!hash) throw httpError('二维码无效', 404)
  const t = await db.customerServiceRequestToken.findUnique({ where: { miniSceneHash: hash }, include: { request: { include: { store: true } } } })
  if (!t) throw httpError('二维码无效', 404)
  const r = t.request
  if (r.status === 'SUBMITTED') {
    if (!ownsService(r, customer)) throw httpError('二维码已使用', 409)
    return { submittedRequestId: r.id, request: { id: r.id, type: r.type, storeName: r.store.name, status: r.status, submittedAt: r.submittedAt } }
  }
  if (t.status !== 'ACTIVE' || r.status !== 'WAITING_CUSTOMER' || t.expiresAt <= now || r.expiresAt <= now) throw httpError('二维码已失效', 410)
  await recordServiceVisit(db, r, customer, 'SCAN')
  return { request: { id: r.id, type: r.type, storeKey: r.storeKey, storeName: r.store.name, status: r.status,
    expiresAt: r.expiresAt, requestMetadata: publicMetadata(r.requestMetadata) } }
}
export async function listCustomerServices(db, customer, { type, cursor } = {}) {
  if (type && !['MAILING', 'INVOICE'].includes(type)) throw httpError('服务类型无效', 400)
  const where = { customerUserId: customer.userId, customerAppId: customer.appId, customerEnvId: customer.envId, status: 'SUBMITTED', ...(type ? { type } : {}) }
  if (cursor) {
    const previous = await db.customerServiceRequest.findFirst({ where: { ...where, id: String(cursor).slice(0, 100) } })
    if (!previous) throw httpError('翻页位置无效', 400)
    where.OR = [{ submittedAt: { lt: previous.submittedAt } }, { submittedAt: previous.submittedAt, id: { lt: previous.id } }]
  }
  const rows = await db.customerServiceRequest.findMany({ where, orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }], take: 21, include: { store: true } })
  const invoiceIds = rows.filter(r => r.type === 'INVOICE' && r.linkedBusinessRecordId).map(r => r.linkedBusinessRecordId)
  const invoices = invoiceIds.length ? await db.invoice.findMany({ where: { id: { in: invoiceIds }, deletedAt: null }, select: { id: true, status: true } }) : []
  const invoiceStatus = new Map(invoices.map(i => [i.id, i.status]))
  return { rows: rows.slice(0, 20).map(r => {
    const p = requestPresentation(r, r.store.name)
    if (r.type === 'INVOICE') p.invoiceStatus = invoiceStatus.get(r.linkedBusinessRecordId) || null
    delete p.requestMetadata; delete p.receiptConfirmedBy; delete p.shipmentConfirmedBy
    return p
  }), nextCursor: rows.length > 20 ? rows[19].id : null }
}
function shipmentInput(input, method) {
  const carrier = String(input.carrier || '').trim(), trackingNo = String(input.trackingNo || '').trim(), deliveryProof = String(input.deliveryProof || '').trim()
  if (carrier.length > 30 || trackingNo.length > 80 || deliveryProof.length > 200) throw httpError('配送资料过长', 400)
  if (method === '同城闪送') {
    if (!deliveryProof) throw httpError('请填写顾客可用的闪送配送凭证或查询说明', 400)
    return { carrier: carrier || '同城闪送', trackingNo: trackingNo || null, deliveryProof }
  }
  if (!carrier || !/^[A-Za-z0-9-]{6,80}$/.test(trackingNo)) throw httpError('请填写快递公司与可查件的运单号', 400)
  return { carrier, trackingNo, deliveryProof: deliveryProof || null }
}
export async function confirmService(db, { requestId, user, action, input = {}, templates = {}, now = new Date() }) {
  if (!['receipt', 'shipment', 'correct-shipment'].includes(action)) throw httpError('操作无效', 400)
  return db.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT id FROM customer_service_requests WHERE id = $1 FOR UPDATE', requestId)
    const r = await tx.customerServiceRequest.findUnique({ where: { id: requestId } })
    if (!r) throw httpError('申请不存在', 404)
    assertServiceStaff(user, r, { confirm: true })
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR SHARE', user.id)
    const actor = await tx.user.findUnique({ where: { id: user.id } })
    assertServiceStaff(actor, r, { confirm: true })
    if (r.status !== 'SUBMITTED' || !r.customerUserId) throw httpError('该申请未绑定小程序顾客', 409)
    const receipt = action === 'receipt', correction = action === 'correct-shipment'
    if ((receipt && r.type !== 'INVOICE') || (!receipt && r.type !== 'MAILING')) throw httpError('申请类型不符', 400)
    if (!r.linkedBusinessRecordId) throw httpError('关联业务记录不可用', 409)
    if (receipt) {
      await tx.$queryRawUnsafe('SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE', r.linkedBusinessRecordId)
      const invoice = await tx.invoice.findUnique({ where: { id: r.linkedBusinessRecordId } })
      if (!invoice || invoice.deletedAt || invoice.storeKey !== r.storeKey) throw httpError('开票记录不可用', 409)
      // An existing done fact remains done; reception does not mutate Invoice.status.
      if (r.receiptConfirmedAt) return { ok: true, alreadyConfirmed: true }
    }
    let data, deliveryMethod, previous = {}, reason = ''
    if (receipt) data = { receiptConfirmedAt: now, receiptConfirmedBy: actor.username }
    else {
      await tx.$queryRawUnsafe('SELECT id FROM "MailingRecord" WHERE id = $1 FOR UPDATE', r.linkedBusinessRecordId)
      const mailing = await tx.mailingRecord.findUnique({ where: { id: r.linkedBusinessRecordId } })
      if (!mailing || mailing.deletedAt || mailing.storeKey !== r.storeKey) throw httpError('邮寄记录不可用', 409)
      if (!correction && r.shipmentConfirmedAt) return { ok: true, alreadyConfirmed: true }
      deliveryMethod = mailing.method
      if (correction && !r.shipmentConfirmedAt) throw httpError('请先确认发货', 409)
      if (correction) {
        reason = String(input.reason || '').trim()
        if (!reason || reason.length > 200) throw httpError('请填写更正原因', 400)
      }
      previous = { carrier: r.carrier, trackingNo: r.trackingNo, deliveryProof: r.deliveryProof }
      data = { ...shipmentInput(input, mailing.method), shipmentVersion: r.shipmentVersion + 1,
        ...(!correction ? { shipmentConfirmedAt: now, shipmentConfirmedBy: actor.username } : {}) }
      await tx.mailingRecord.update({ where: { id: mailing.id }, data: { status: 'shipped', shippedAt: mailing.shippedAt || now } })
    }
    await tx.customerServiceRequest.update({ where: { id: r.id }, data })
    await tx.storeServiceAudit.create({ data: { id: uid('ssa'), requestId: r.id, actorId: user.id,
      action, reason, detail: { before: previous, after: data }, createdAt: now } })
    if (!correction) {
      const template = selectServiceTemplate(templates, r, { saved: true,
        ...(!receipt ? { method: deliveryMethod } : {}) })
      const accepted = r.subscriptionChoice === 'accept' && r.subscriptionTemplateId === template?.id
      const platformCode = !template ? (!receipt && deliveryMethod !== r.requestMetadata?.method
        ? 'DELIVERY_METHOD_CHANGED' : r.subscriptionTemplateId ? 'SUBSCRIPTION_TEMPLATE_MISMATCH' : 'TEMPLATE_NOT_CONFIGURED')
        : accepted ? null : 'NO_SUBSCRIPTION_PERMISSION'
      await tx.storeServiceDelivery.create({ data: { id: uid('ssd'), requestId: r.id,
        event: receipt ? 'INVOICE_RECEIVED' : 'SHIPMENT_CONFIRMED', version: 1, userId: r.customerUserId,
        appId: r.customerAppId, envId: r.customerEnvId, openId: r.customerOpenId,
        templateId: r.subscriptionTemplateId || null, platformCode,
        status: !template?.id ? 'BLOCKED_CONFIG' : accepted ? 'PENDING' : 'NO_PERMISSION', nextAttemptAt: now } })
    }
    return { ok: true, alreadyConfirmed: false, correction, message: correction ? '详情已更正，未额外发送提醒' : '业务已确认，消息状态请查看发送结果' }
  })
}
