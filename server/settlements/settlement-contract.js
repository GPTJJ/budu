import crypto from 'node:crypto'
import { httpError } from '../pos-core.js'

export const ORDER_SOURCES = Object.freeze(['STORE_POS', 'MEITUAN', 'TAOBAO_FLASH', 'JD_INSTANT', 'OTHER'])
export const EXTERNAL_ORDER_SOURCES = Object.freeze(['MEITUAN', 'TAOBAO_FLASH', 'JD_INSTANT', 'OTHER'])
export const ENTRY_MODES = Object.freeze(['POS_CHECKOUT', 'MANUAL_POS'])
export const SETTLEMENT_AUTHORITIES = Object.freeze(['PAYMENT', 'EXTERNAL'])
export const EXTERNAL_SETTLEMENT_TYPES = Object.freeze(['PLATFORM', 'CUSTOM'])
export const EXTERNAL_SETTLEMENT_STATUSES = Object.freeze(['PENDING', 'CONFIRMED', 'VOIDED'])

const PLATFORM_SOURCES = new Set(['MEITUAN', 'TAOBAO_FLASH', 'JD_INSTANT'])
const CLIENT_CONTROLLED_SETTLEMENT_FIELDS = Object.freeze([
  'status',
  'paymentStatus',
  'completedAt',
  'paymentMethod',
  'paymentMode',
  'entryMode',
  'settlementAuthority',
  'settlementType',
])

export function externalOrderDimensions(orderSource) {
  const source = String(orderSource || '').trim().toUpperCase()
  if (!EXTERNAL_ORDER_SOURCES.includes(source)) throw httpError('外部订单来源不正确')
  return {
    orderSource: source,
    entryMode: 'MANUAL_POS',
    settlementAuthority: 'EXTERNAL',
    settlementType: PLATFORM_SOURCES.has(source) ? 'PLATFORM' : 'CUSTOM',
  }
}

export function assertNoClientSettlementState(body = {}) {
  for (const field of CLIENT_CONTROLLED_SETTLEMENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      throw httpError(`字段 ${field} 只能由服务端结算状态机决定`)
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sourceOrderRef')) {
    throw httpError('V1 不接受外部订单号')
  }
}

export function normalizeExternalRequestKey(value) {
  const requestKey = String(value || '').trim()
  if (requestKey.length < 8 || requestKey.length > 160 || /[\u0000-\u001f\u007f]/.test(requestKey)) {
    throw httpError('外部结算请求幂等键不正确')
  }
  return requestKey
}

export function externalCheckoutKey(requestKey) {
  return `external:${crypto.createHash('sha256').update(requestKey).digest('hex')}`
}

export function newExternalSettlementNo() {
  return `EXT${Date.now().toString(36).toUpperCase()}${crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`
}

export function serializeExternalSettlement(settlement) {
  if (!settlement) return null
  return {
    id: settlement.id,
    settlementNo: settlement.settlementNo,
    orderId: settlement.orderId,
    settlementType: settlement.settlementType,
    amountCents: settlement.amountCents.toString(),
    currency: settlement.currency,
    status: settlement.status,
    requestKey: settlement.requestKey,
    note: settlement.note || '',
    recordedBy: settlement.recordedBy,
    recordedAt: settlement.recordedAt,
    confirmedBy: settlement.confirmedBy || '',
    confirmedAt: settlement.confirmedAt,
    voidedBy: settlement.voidedBy || '',
    voidedAt: settlement.voidedAt,
    voidReason: settlement.voidReason || '',
    createdAt: settlement.createdAt,
    updatedAt: settlement.updatedAt,
  }
}
