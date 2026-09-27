export { OPERATIONAL_IDENTITY_TYPES, PAYROLL_PARTICIPANT_TYPES } from '../shared/payrollParticipantAuthority.js'
import { OPERATIONAL_IDENTITY_TYPES, PAYROLL_PARTICIPANT_TYPES } from '../shared/payrollParticipantAuthority.js'

const cleanId = (value) => String(value == null ? '' : value).trim()

/**
 * Server-side participant classification. The client submits one stable target ID;
 * participantType, snapshot name and compatibility staffId are always derived here.
 */
export function classifyDailyStaffTargets(items, employees, users, options = {}) {
  const employeeById = new Map((Array.isArray(employees) ? employees : []).map((row) => [row.id, row]))
  const userById = new Map((Array.isArray(users) ? users : []).map((row) => [row.id, row]))
  const seen = new Set()

  return (Array.isArray(items) ? items : []).map((item) => {
    if (Object.prototype.hasOwnProperty.call(item || {}, 'participantType')) {
      throw new Error('参与者类型由服务器判定，客户端不可指定')
    }
    const employeeId = cleanId(item?.employeeId)
    const participantUserId = cleanId(item?.participantUserId)
    if (Boolean(employeeId) === Boolean(participantUserId)) {
      throw new Error('值班参与者必须且只能指定一个稳定身份')
    }

    if (employeeId) {
      const employee = employeeById.get(employeeId)
      if (!employee) throw new Error('员工不存在')
      if (employee.status === 'RESIGNED') throw new Error('离职员工不能作为值班参与者')
      const identityKey = `employee:${employeeId}`
      if (seen.has(identityKey)) throw new Error('同一员工被重复提交')
      seen.add(identityKey)
      return {
        ...item,
        employeeId,
        participantUserId: null,
        participantType: PAYROLL_PARTICIPANT_TYPES.EMPLOYEE,
        staffId: identityKey,
        staffName: String(employee.name || '').trim().slice(0, 50),
      }
    }

    const user = userById.get(participantUserId)
    if (!user || user.status !== 'active' || user.operationalIdentityType !== OPERATIONAL_IDENTITY_TYPES.NON_EMPLOYEE_OPERATIONAL_SUBSTITUTE) {
      throw new Error('非员工运营替代账号无效')
    }
    if (options.storeKey && !Array.isArray(user.storeKeys)) throw new Error('运营替代账号未配置门店权限')
    if (options.storeKey && !user.storeKeys.includes(options.storeKey)) throw new Error('运营替代账号无该门店权限')
    const identityKey = `user:${participantUserId}`
    if (seen.has(identityKey)) throw new Error('同一运营替代账号被重复提交')
    seen.add(identityKey)
    return {
      ...item,
      employeeId: null,
      participantUserId,
      participantType: PAYROLL_PARTICIPANT_TYPES.NON_EMPLOYEE_SUBSTITUTE,
      staffId: identityKey,
      staffName: String(user.displayName || user.username || '').trim().slice(0, 50),
    }
  })
}
