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

export const SWEET_CARD_STATUS_OPTIONS = Object.entries(SWEET_CARD_STATUS_LABELS)
export const SWEET_CARD_BINDING_MODE_OPTIONS = Object.entries(SWEET_CARD_BINDING_MODE_LABELS)
export const SWEET_CARD_CARRIER_TYPE_OPTIONS = Object.entries(SWEET_CARD_CARRIER_TYPE_LABELS)

const labelFor = (labels, value) => labels[value] || value || '—'

export const sweetCardStatusLabel = (value) => labelFor(SWEET_CARD_STATUS_LABELS, value)
export const sweetCardBindingModeLabel = (value) => labelFor(SWEET_CARD_BINDING_MODE_LABELS, value)
export const sweetCardCarrierTypeLabel = (value) => labelFor(SWEET_CARD_CARRIER_TYPE_LABELS, value)
