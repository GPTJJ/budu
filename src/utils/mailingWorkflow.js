export const MAILING_METHOD = Object.freeze({ SF: '顺丰邮寄', FLASH: '同城闪送' })
export const MAILING_TIER = Object.freeze({ STANDARD: 'STANDARD', FRESH: 'FRESH' })

export function shippingAmountCents(tier) {
  if (tier === MAILING_TIER.STANDARD) return 1800
  if (tier === MAILING_TIER.FRESH) return 3500
  return null
}

export function requiresPaymentConfirmation({ method, postage }) {
  return method === MAILING_METHOD.SF && postage === '不包邮'
}

export function canGenerateCustomerQr(config) {
  if (!config?.storeKey || !Object.values(MAILING_METHOD).includes(config.method)) return false
  if (!['包邮', '不包邮'].includes(config.postage)) return false
  if (config.method === MAILING_METHOD.SF && !Object.values(MAILING_TIER).includes(config.shippingTier)) return false
  if (!requiresPaymentConfirmation(config)) return true
  return Object.values(MAILING_TIER).includes(config.shippingTier) && config.paymentConfirmed === true
}

export function shippingPresentation(record) {
  const method = record?.method === MAILING_METHOD.FLASH ? MAILING_METHOD.FLASH : MAILING_METHOD.SF
  const postage = record?.postage === '不包邮' ? '不包邮' : '包邮'
  const tierLabel = method === MAILING_METHOD.SF
    ? (record?.shippingTier === MAILING_TIER.FRESH ? '生鲜'
      : record?.shippingTier === MAILING_TIER.STANDARD ? '标准'
        : postage === '不包邮' && String(record?.fee || '').includes('生鲜') ? '生鲜'
          : postage === '不包邮' && String(record?.fee || '').includes('标准') ? '标准' : '未记录')
    : ''
  if (postage === '包邮') return { method, postage, detail: '包邮', tierLabel }
  if (method === MAILING_METHOD.FLASH || record?.shippingPaymentMode === 'WECHAT_COMMUNICATION' || record?.fee === '微信沟通') {
    return { method, postage, detail: '不包邮 · 微信沟通', tierLabel: '' }
  }
  const isFresh = record?.shippingTier === MAILING_TIER.FRESH || String(record?.fee || '').includes('生鲜')
  const amount = Number(record?.shippingAmountCents) || (isFresh ? 3500 : 1800)
  return {
    method,
    postage,
    detail: `不包邮 · ¥${(amount / 100).toFixed(0)}`,
    tierLabel,
  }
}

export function buildMailingCopyText(record) {
  const view = shippingPresentation(record)
  const lines = [record?.recipient, record?.phone, record?.address]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  lines.push(`配送：${view.method}${view.tierLabel ? ` · ${view.tierLabel}` : ''}`)
  lines.push(`运费：${view.detail}`)
  const remark = String(record?.remark || '').trim()
  if (remark) lines.push(`备注：${remark}`)
  return lines.join('\n')
}

// Display-only ordering; never mutate API rows or their business timestamps.
export function sortShippedRecords(records) {
  const time = (record) => Date.parse(record.shippedAt || '') || Date.parse(record.createdAt || '') || 0
  return [...records].sort((a, b) => time(b) - time(a) || String(a.id).localeCompare(String(b.id)))
}
