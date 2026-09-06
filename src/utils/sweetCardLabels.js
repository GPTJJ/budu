export const SWEET_CARD_STATUS_LABELS = Object.freeze({
  CREATED: '已创建',
  ACTIVE: '已激活',
  FROZEN: '已冻结',
  LOST: '已挂失',
  EXHAUSTED: '已用尽',
  EXPIRED: '已过期',
  VOID: '已作废',
})

export const SWEET_CARD_BINDING_MODE_LABELS = Object.freeze({
  NONE: '不绑定',
  OPTIONAL: '可选绑定',
  REQUIRED: '必须绑定',
})

export const SWEET_CARD_CARRIER_TYPE_LABELS = Object.freeze({
  PHYSICAL: '实体卡',
  ELECTRONIC: '电子卡',
})

export const SWEET_CARD_BATCH_PURPOSE_LABELS = Object.freeze({
  COMMERCIAL: '商业运营',
  ACCEPTANCE_TEST: '测试/验收',
})

export const SWEET_CARD_CREDENTIAL_STATUS_LABELS = Object.freeze({
  UNACTIVATED: '未激活',
  ACTIVE: '有效',
  REVOKED: '已撤销',
})

export const SWEET_CARD_ACTIVATION_STATUS_LABELS = Object.freeze({ UNACTIVATED: '未激活', ACTIVATED: '已激活' })
export const SWEET_CARD_PRESENTATION_STATUS_LABELS = Object.freeze({ NOT_GENERATED: '未生成', GENERATED: '已生成', REVOKED: '已撤销' })
export const SWEET_CARD_CLAIM_STATUS_LABELS = Object.freeze({ UNCLAIMED: '未领取', CLAIMED: '已领取' })
export const SWEET_CARD_BINDING_STATUS_LABELS = Object.freeze({ NOT_REQUIRED: '无需绑定', UNBOUND: '未绑定', BOUND: '已绑定' })
export const SWEET_CARD_DELIVERY_STATUS_LABELS = Object.freeze({ NOT_PREPARED: '未准备', GENERATED: '已生成待激活', READY: '已准备发放', CLAIMED: '已领取', REVOKED: '已撤销' })
export const SWEET_CARD_CLAIM_CREDENTIAL_STATUS_LABELS = Object.freeze({ NONE: '未生成', ACTIVE: '有效', CONSUMED: '已使用', EXPIRED: '已过期', REVOKED: '已撤销' })
export const SWEET_CARD_LEDGER_TYPE_LABELS = Object.freeze({ ISSUE: '发卡', REDEEM: '消费', REFUND: '退款', REVERSAL: '冲正' })

export const SWEET_CARD_STATUS_OPTIONS = Object.entries(SWEET_CARD_STATUS_LABELS)
export const SWEET_CARD_BINDING_MODE_OPTIONS = Object.entries(SWEET_CARD_BINDING_MODE_LABELS)
export const SWEET_CARD_CARRIER_TYPE_OPTIONS = Object.entries(SWEET_CARD_CARRIER_TYPE_LABELS)

const labelFor = (labels, value) => labels[value] || value || '—'

export const sweetCardStatusLabel = (value) => labelFor(SWEET_CARD_STATUS_LABELS, value)
export const sweetCardBindingModeLabel = (value) => labelFor(SWEET_CARD_BINDING_MODE_LABELS, value)
export const sweetCardCarrierTypeLabel = (value) => labelFor(SWEET_CARD_CARRIER_TYPE_LABELS, value)
export const sweetCardBatchPurposeLabel = (value) => labelFor(SWEET_CARD_BATCH_PURPOSE_LABELS, value)
export const sweetCardCredentialStatusLabel = (value) => labelFor(SWEET_CARD_CREDENTIAL_STATUS_LABELS, value)
export const sweetCardActivationStatusLabel = (value) => labelFor(SWEET_CARD_ACTIVATION_STATUS_LABELS, value)
export const sweetCardPresentationStatusLabel = (value) => labelFor(SWEET_CARD_PRESENTATION_STATUS_LABELS, value)
export const sweetCardClaimStatusLabel = (value) => labelFor(SWEET_CARD_CLAIM_STATUS_LABELS, value)
export const sweetCardBindingStatusLabel = (value) => labelFor(SWEET_CARD_BINDING_STATUS_LABELS, value)
export const sweetCardDeliveryStatusLabel = (value) => labelFor(SWEET_CARD_DELIVERY_STATUS_LABELS, value)
export const sweetCardClaimCredentialStatusLabel = (value) => labelFor(SWEET_CARD_CLAIM_CREDENTIAL_STATUS_LABELS, value)
export const sweetCardLedgerTypeLabel = (value) => labelFor(SWEET_CARD_LEDGER_TYPE_LABELS, value)

const SWEET_CARD_STORE_TYPE_LABELS = Object.freeze({ DIRECT: '直营店', NON_DIRECT: '非直营店', UNKNOWN: '经营类型待确认' })
export const sweetCardStoreTypeLabel = value => SWEET_CARD_STORE_TYPE_LABELS[value] || '经营类型待确认'
