export const PARTNER_STATUSES = Object.freeze({
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  TERMINATED: 'TERMINATED',
})

export const PARTNER_STORE_STATUSES = Object.freeze({
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
})

export const PARTNER_USER_STATUSES = Object.freeze({
  ACTIVE: 'active',
  DISABLED: 'disabled',
})

function bad(message, status = 400, code = 'PARTNER_DOMAIN_INVALID') {
  return Object.assign(new Error(message), { status, code })
}

export function boundedText(value, { label, max, required = false }) {
  const result = String(value ?? '').trim()
  if (required && !result) throw bad(`${label}不能为空`)
  if (result.length > max) throw bad(`${label}不能超过 ${max} 个字符`)
  return result
}

export function validateDiscountBps(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) throw bad('合作折扣必须是整数基点')
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 1 || result > 10000) {
    throw bad('合作折扣必须在 1-10000 基点之间')
  }
  return result
}

export function validatePartnerStatus(value) {
  const status = String(value || '').toUpperCase()
  if (!Object.values(PARTNER_STATUSES).includes(status)) throw bad('合作商状态不正确')
  return status
}

// Partner.status is canonical; isActive is only the legacy read projection.
export function partnerLifecycleFields(value) {
  const status = validatePartnerStatus(value)
  return { status, isActive: status === PARTNER_STATUSES.ACTIVE }
}

export function legacyPartnerLifecycleFields(body, current = null) {
  if (body?.isActive !== undefined && typeof body.isActive !== 'boolean') throw bad('合作商启停状态不正确')
  if (!current) return partnerLifecycleFields(body?.isActive === false ? PARTNER_STATUSES.PAUSED : PARTNER_STATUSES.ACTIVE)
  const currentFields = partnerLifecycleFields(current.status)
  if (body?.isActive === undefined || body.isActive === currentFields.isActive) return currentFields
  if (currentFields.status === PARTNER_STATUSES.TERMINATED) {
    throw bad('合作商已停止合作，请通过合作商管理明确变更生命周期', 409, 'PARTNER_LEGACY_STATUS_CONFLICT')
  }
  return partnerLifecycleFields(body.isActive ? PARTNER_STATUSES.ACTIVE : PARTNER_STATUSES.PAUSED)
}

export function validatePartnerStoreStatus(value) {
  const status = String(value || '').toUpperCase()
  if (!Object.values(PARTNER_STORE_STATUSES).includes(status)) throw bad('合作门店状态不正确')
  return status
}

export function validatePartnerUserStatus(value) {
  const status = String(value || '').toLowerCase()
  if (!Object.values(PARTNER_USER_STATUSES).includes(status)) throw bad('合作商账号状态不正确')
  return status
}

export function validateDateOnly(value, label = '合作开始日期') {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw bad(`${label}格式不正确`)
  const date = new Date(`${raw}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) throw bad(`${label}格式不正确`)
  return date
}

export function assertPartnerCanCreateBusiness(partner) {
  const status = validatePartnerStatus(partner?.status)
  if (status !== PARTNER_STATUSES.ACTIVE) {
    throw bad(status === PARTNER_STATUSES.PAUSED ? '合作商已暂停补货' : '合作商已停止合作', 409, 'PARTNER_NEW_BUSINESS_DENIED')
  }
  return partner
}

export function assertPartnerStoreCanCreateBusiness(store) {
  const status = validatePartnerStoreStatus(store?.status)
  if (status !== PARTNER_STORE_STATUSES.ACTIVE) {
    throw bad('合作门店已停用，不能用于新业务', 409, 'PARTNER_STORE_NEW_BUSINESS_DENIED')
  }
  return store
}

export function partnerPublicDto(partner) {
  return {
    id: partner.id,
    name: partner.name,
    companyName: partner.companyName || '',
    contactName: partner.contactName || '',
    contactPhone: partner.contactPhone || '',
    cooperationStartDate: partner.cooperationStartDate ? new Date(partner.cooperationStartDate).toISOString().slice(0, 10) : '',
    status: partner.status,
    defaultDiscountBps: partner.defaultDiscountBps,
    invoiceTitle: partner.invoiceTitle || '',
    taxpayerId: partner.taxpayerId || '',
    contractReference: partner.contractReference || '',
    version: partner.version,
    createdAt: partner.createdAt ? new Date(partner.createdAt).toISOString() : '',
    updatedAt: partner.updatedAt ? new Date(partner.updatedAt).toISOString() : '',
  }
}

export function partnerStorePublicDto(store) {
  return {
    id: store.id,
    name: store.name,
    contactName: store.contactName || '',
    phone: store.phone || '',
    province: store.province || '',
    city: store.city || '',
    district: store.district || '',
    addressLine: store.addressLine || '',
    status: store.status,
    version: store.version,
    createdAt: store.createdAt ? new Date(store.createdAt).toISOString() : '',
    updatedAt: store.updatedAt ? new Date(store.updatedAt).toISOString() : '',
  }
}
