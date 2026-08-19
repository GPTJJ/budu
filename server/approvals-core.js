// 审批引擎核心纯函数（无副作用，可独立单测）：
// 状态机、权限矩阵、抄送规则解析、表单校验、金额转换、单号生成
import { isSuperUser } from '../shared/accountPermissions.js'

export const APPROVAL_STATUSES = ['draft', 'pending', 'approved', 'rejected', 'withdrawn', 'archived']

/** 状态机：key = 当前状态，value = 允许转移到的状态 */
export const APPROVAL_TRANSITIONS = {
  draft: ['pending'],
  pending: ['approved', 'rejected', 'withdrawn'],
  approved: ['archived'],
  rejected: ['pending', 'archived'], // pending = 驳回后重新提交
  withdrawn: [],
  archived: [],
}

export function canTransition(from, to) {
  return Array.isArray(APPROVAL_TRANSITIONS[from]) && APPROVAL_TRANSITIONS[from].includes(to)
}

export function isStatus(value) {
  return APPROVAL_STATUSES.includes(value)
}

/** 是否为该单据的审批人：模板规则 role=admin → 管理员（超管亦可）；role=developer → 超管；username → 指定账号 */
export function isApproverFor(user, request, template) {
  if (!user || !request || !template) return false
  if (request.status === 'withdrawn' || request.status === 'draft') return false
  const rule = template.approverRule || {}
  if (rule.type === 'username') return user.username === rule.username
  if (rule.type === 'role') {
    if (user.role === rule.role) return true
    // 超管（开发者/管理员/财务）权限一致：任意超管角色都可审批
    if (rule.role === 'admin' && isSuperUser(user)) return true
    if (rule.role === 'developer' && isSuperUser(user)) return true
  }
  return false
}

/** 提交人 */
export function isSubmitter(user, request) {
  return Boolean(user && request && user.username === request.submitterUsername)
}

/** 抄送人 */
export function isCcOf(user, request, ccList = []) {
  return Boolean(user && Array.isArray(ccList) && ccList.some((c) => c.ccUsername === user.username))
}

/** 单据可见性：提交人/审批人/抄送人/超管（开发者+财务全量）；店员/店长仅本人相关 */
export function canViewRequest(user, request, ctx = {}) {
  if (!user || !request) return false
  if (user.role === 'public' || user.role === 'cashier') return false
  if (isSuperUser(user)) return true
  if (isSubmitter(user, request)) return true
  if (isApproverFor(user, request, ctx.template)) return true
  if (isCcOf(user, request, ctx.ccList)) return true
  return false
}

/** 提交/保存草稿：非 public/cashier 均可 */
export function canCreate(user) {
  return Boolean(user && user.role !== 'public' && user.role !== 'cashier')
}

/** 编辑：草稿（创建人）或驳回后重新提交（提交人） */
export function canEdit(user, request) {
  if (!canCreate(user)) return false
  if (!isSubmitter(user, request)) return false
  return request.status === 'draft' || request.status === 'rejected'
}

/** 提交：草稿/驳回重提，仅提交人 */
export function canSubmit(user, request) {
  return canCreate(user) && isSubmitter(user, request) && canTransition(request.status, 'pending')
}

/** 撤回：待审批，仅提交人 */
export function canWithdraw(user, request) {
  return canCreate(user) && isSubmitter(user, request) && canTransition(request.status, 'withdrawn')
}

/** 审批（通过/驳回）：待审批，仅审批人 */
export function canDecide(user, request, template) {
  return canCreate(user) && isApproverFor(user, request, template) && canTransition(request.status, 'approved')
}

/** 归档：已通过/已驳回，仅超管（开发者/财务） */
export function canArchive(user, request) {
  return isSuperUser(user) && (request.status === 'approved' || request.status === 'rejected')
}

/** 删除：仅草稿，创建人或超管（开发者/财务） */
export function canDelete(user, request) {
  if (!canCreate(user) || request.status !== 'draft') return false
  return isSuperUser(user) || isSubmitter(user, request)
}

/** 金额（元，字符串/数字）→ 分（Number，安全整数范围内） */
export function moneyToCents(value, label = '金额') {
  if (value === undefined || value === null || value === '') throw new Error(`${label}不能为空`)
  const text = String(value).trim()
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error(`${label}格式不正确（最多两位小数）`)
  const [intPart, decPart = ''] = text.split('.')
  const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 99999999999) throw new Error(`${label}超出允许范围`)
  return cents
}

/** 分 → 元字符串（两位小数） */
export function centsToYuan(cents) {
  const value = Number(cents || 0)
  return (value / 100).toFixed(2)
}

/** 校验表单数据：按模板 schema；money 字段转为分（Number） */
export function validateFormData(schema, formData) {
  const errors = []
  const normalized = {}
  const raw = formData && typeof formData === 'object' && !Array.isArray(formData) ? formData : {}
  for (const field of schema || []) {
    const key = field.key
    const value = raw[key]
    const label = field.label || key
    const isEmpty = value === undefined || value === null || String(value).trim() === ''
    if (field.required && isEmpty) {
      errors.push(`${label}不能为空`)
      continue
    }
    if (isEmpty) {
      normalized[key] = field.type === 'money' ? 0 : ''
      continue
    }
    const text = String(value).trim()
    switch (field.type) {
      case 'money': {
        try {
          normalized[key] = moneyToCents(text, label)
        } catch (e) {
          errors.push(e.message)
        }
        break
      }
      case 'month':
        if (!/^\d{4}-\d{2}$/.test(text)) errors.push(`${label}格式不正确`)
        else normalized[key] = text
        break
      case 'date':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) errors.push(`${label}格式不正确`)
        else normalized[key] = text
        break
      case 'employee':
        // 存 'storeKey::员工名'，展示时拆分
        if (!text.includes('::')) errors.push(`${label}格式不正确`)
        else normalized[key] = text
        break
      default:
        normalized[key] = text.slice(0, (field.maxLength || 200))
    }
  }
  return { errors, normalized }
}

/** 抄送规则解析 → 抄送用户列表 [{username, name}] */
export function resolveCcUsers(ccRule, ctx = {}) {
  const result = []
  const seen = new Set()
  const push = (username, name) => {
    if (!username || seen.has(username)) return
    seen.add(username)
    result.push({ username, name: name || username })
  }
  for (const rule of Array.isArray(ccRule) ? ccRule : []) {
    if (!rule || typeof rule !== 'object') continue
    if (rule.type === 'role') {
      for (const u of ctx.roleUsers?.[rule.role] || []) push(u.username, u.name)
    } else if (rule.type === 'submitter') {
      push(ctx.submitter?.username, ctx.submitter?.name)
    } else if (rule.type === 'staffField') {
      // formData[field] = 'storeKey::员工名' → 按员工绑定账号匹配
      const staffKey = String(ctx.formData?.[rule.field] || '')
      const bound = ctx.staffKeyMap?.[staffKey]
      if (bound) push(bound.username, bound.name || bound.username)
    }
  }
  return result
}

/** 单据号：AP-YYYYMMDD-XXXX（seq 为当日序号，1 起） */
export function genRequestNo(now = new Date(), seq = 1) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `AP-${y}${m}${d}-${String(seq).padStart(4, '0')}`
}

/** 列表 scope 过滤（服务端查询条件生成 + 兜底过滤） */
export function scopeFilter(scope, user, ctx = {}) {
  if (scope === 'my') return { submitterUsername: user.username }
  if (scope === 'todo') return { status: 'pending' } // 审批人限定由节点查询/后端过滤
  if (scope === 'cc') return {} // 抄送我的：由 cc 关联过滤
  if (scope === 'all') return isSuperUser(user) ? {} : {} // 超管（开发者/财务）全量
  return {}
}
