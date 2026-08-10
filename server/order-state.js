import { httpError } from './pos-core.js'

export const ORDER_STATUSES = Object.freeze([
  'draft',
  'pending_payment',
  'paid',
  'completed',
  'cancelled',
  'partially_refunded',
  'refunded',
])

export const ORDER_PAYMENT_STATUSES = Object.freeze([
  'unpaid',
  'pending',
  'paid',
  'failed',
  'partially_refunded',
  'refunded',
])

const ORDER_TRANSITIONS = new Map([
  ['draft', new Set(['pending_payment', 'cancelled'])],
  ['pending_payment', new Set(['paid', 'cancelled'])],
  ['paid', new Set(['completed', 'partially_refunded', 'refunded'])],
  ['completed', new Set(['partially_refunded', 'refunded'])],
  ['partially_refunded', new Set(['refunded'])],
  ['cancelled', new Set()],
  ['refunded', new Set()],
])

const PAYMENT_STATUS_TRANSITIONS = new Map([
  ['unpaid', new Set(['pending', 'failed'])],
  ['pending', new Set(['unpaid', 'paid', 'failed'])],
  ['failed', new Set(['unpaid', 'pending', 'paid'])],
  ['paid', new Set(['partially_refunded', 'refunded'])],
  ['partially_refunded', new Set(['refunded'])],
  ['refunded', new Set()],
])

export function canTransitionOrder(from, to) {
  return from === to || Boolean(ORDER_TRANSITIONS.get(from)?.has(to))
}

export function canTransitionOrderPayment(from, to) {
  return from === to || Boolean(PAYMENT_STATUS_TRANSITIONS.get(from)?.has(to))
}

export function assertOrderTransition(from, to) {
  if (!ORDER_STATUSES.includes(from) || !ORDER_STATUSES.includes(to) || !canTransitionOrder(from, to)) {
    throw httpError(`订单状态不可从 ${from} 变更为 ${to}`, 409)
  }
}

export function assertOrderPaymentTransition(from, to) {
  if (!ORDER_PAYMENT_STATUSES.includes(from) || !ORDER_PAYMENT_STATUSES.includes(to) || !canTransitionOrderPayment(from, to)) {
    throw httpError(`支付状态不可从 ${from} 变更为 ${to}`, 409)
  }
}
