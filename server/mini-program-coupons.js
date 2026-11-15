/**
 * 小程序券模板：校验与视图。
 *
 * 业务口径（对齐《budu小卖部小程序产品开发报告》4.1.1 与附录 A）：
 *  - 金额一律用「分」整数传输，前端展示时再除 100；
 *  - 面额不得大于门槛（无门槛券门槛为 0，不受此限）；
 *  - 已发出的券在领取时已快照面额/门槛/有效期，因此**模板可以随时改**，
 *    改动只影响之后领到的券 —— 这正是运营需要的能力，不需要额外「发布」动作；
 *  - issuedQty 是运行态计数，由云函数条件自增维护，管理台只读不可写。
 */
import crypto from 'node:crypto'
import { httpError } from './pos-core.js'

export const COUPON_SOURCES = ['newcomer', 'repurchase', 'share', 'manual', 'repurchase-code']

export const COUPON_SOURCE_LABELS = {
  newcomer: '新人券',
  repurchase: '首单复购券',
  share: '分享券',
  'repurchase-code': '复购码券',
  manual: '后台手动发放'
}

const MAX_YUAN_CENT = 100000 // 单张券面额上限 1000 元
const MAX_THRESHOLD_CENT = 1000000
const MAX_VALID_DAYS = 365
const MAX_PER_USER = 10

function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : NaN
}

function requireText(value, field, max = 20) {
  const text = String(value ?? '').trim()
  if (!text) throw httpError(`请填写${field}`, 400)
  if (text.length > max) throw httpError(`${field}最多 ${max} 个字符`, 400)
  return text
}

/**
 * 归一化并校验一次保存请求。
 * @param {object} input 前端提交（金额单位：分）
 * @param {object|null} existing 库中已有模板（新建时为 null）
 * @returns 可直接写入的文档字段（不含 _id / issuedQty）
 */
export function normalizeCouponTemplate(input, existing = null) {
  const body = input && typeof input === 'object' ? input : {}

  const name = requireText(body.name, '券名称', 20)
  const faceCent = intOrNull(body.faceCent)
  if (!Number.isSafeInteger(faceCent) || faceCent <= 0) throw httpError('面额必须是大于 0 的金额', 400)
  if (faceCent > MAX_YUAN_CENT) throw httpError('单张券面额不能超过 1000 元', 400)

  const thresholdCent = intOrNull(body.thresholdCent) ?? 0
  if (!Number.isSafeInteger(thresholdCent) || thresholdCent < 0) throw httpError('使用门槛无效', 400)
  if (thresholdCent > MAX_THRESHOLD_CENT) throw httpError('使用门槛不能超过 10000 元', 400)
  if (thresholdCent > 0 && faceCent > thresholdCent) throw httpError('面额不能大于使用门槛', 400)

  const validDays = intOrNull(body.validDays)
  if (!Number.isSafeInteger(validDays) || validDays < 1 || validDays > MAX_VALID_DAYS) {
    throw httpError(`有效天数需在 1–${MAX_VALID_DAYS} 天之间`, 400)
  }

  const perUserLimit = intOrNull(body.perUserLimit) ?? 1
  if (!Number.isSafeInteger(perUserLimit) || perUserLimit < 1 || perUserLimit > MAX_PER_USER) {
    throw httpError(`每人限领需在 1–${MAX_PER_USER} 张之间`, 400)
  }

  // null = 不限量；一旦发过券，总量不能低于已发出数量。
  const issuedQty = Number(existing?.issuedQty || 0)
  const totalQtyRaw = intOrNull(body.totalQty)
  let totalQty = totalQtyRaw
  if (totalQtyRaw !== null) {
    if (!Number.isSafeInteger(totalQtyRaw) || totalQtyRaw < 1) throw httpError('发放总量需为正整数，或留空表示不限量', 400)
    if (totalQtyRaw < issuedQty) throw httpError(`发放总量不能小于已发出的 ${issuedQty} 张`, 400)
  }

  const source = COUPON_SOURCES.includes(String(body.source)) ? String(body.source) : 'manual'
  const status = String(body.status) === 'off' ? 'off' : 'on'

  return {
    name,
    faceCent,
    thresholdCent,
    validType: 'days',
    validDays,
    totalQty,
    perUserLimit,
    status,
    source,
    remark: String(body.remark ?? existing?.remark ?? '').slice(0, 120)
  }
}

/** 新模板 id：业务可读 + 唯一。已发出的券按 templateId 关联，所以 id 一旦生成不再变。 */
export function newCouponTemplateId() {
  return `tpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
}

/** 客户端视图：补来源标签，金额保持分。 */
export function serializeCouponTemplate(doc) {
  if (!doc) return null
  return {
    id: String(doc._id || doc.id || ''),
    name: String(doc.name || ''),
    faceCent: Number(doc.faceCent) || 0,
    thresholdCent: Number(doc.thresholdCent) || 0,
    validType: doc.validType === 'fixed' ? 'fixed' : 'days',
    validDays: Number(doc.validDays) || 0,
    totalQty: doc.totalQty === null || doc.totalQty === undefined ? null : Number(doc.totalQty),
    issuedQty: Number(doc.issuedQty) || 0,
    perUserLimit: Number(doc.perUserLimit) || 1,
    status: doc.status === 'off' ? 'off' : 'on',
    source: String(doc.source || 'manual'),
    sourceLabel: COUPON_SOURCE_LABELS[String(doc.source || 'manual')] || '后台手动发放',
    remark: String(doc.remark || '')
  }
}
