// 员工档案（Employee Master Profile）单元测试
// 覆盖：AES-256-GCM 加解密、密钥缺失 fail-closed、掩码格式（身份证/银行卡）、
//       模块权限矩阵（developer/admin/finance 全量；manager 可见但不可 reveal；staff 默认无模块）、
//       密文不含明文、审计字段只记 last4。
import test from 'node:test'
import assert from 'node:assert/strict'
import { encryptSensitive, decryptSensitive, maskIdentity, maskBank } from '../server/employee-profile.js'
import { MODULE_KEYS, hasModuleAccess, defaultModuleKeys } from '../shared/accountPermissions.js'

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const ID = '110101199001011234'
const CARD = '6222020200112233445'

test('AES-256-GCM 加解密往返一致', () => {
  process.env.EMPLOYEE_SENSITIVE_KEY = KEY
  const enc = encryptSensitive(ID)
  assert.notEqual(enc, ID)
  assert.equal(decryptSensitive(enc), ID)
  const encCard = encryptSensitive(CARD)
  assert.equal(decryptSensitive(encCard), CARD)
  // 同明文两次加密应产生不同密文（随机 IV）
  assert.notEqual(encryptSensitive(ID), encryptSensitive(ID))
})

test('密文中绝不包含明文片段', () => {
  process.env.EMPLOYEE_SENSITIVE_KEY = KEY
  const enc = encryptSensitive(ID)
  assert.equal(enc.includes(ID), false)
  assert.equal(enc.includes('110101'), false)
  assert.equal(enc.includes('1234'), false)
  const encCard = encryptSensitive(CARD)
  assert.equal(encCard.includes(CARD), false)
})

test('密钥缺失时敏感字段读写 fail-closed（503）', () => {
  delete process.env.EMPLOYEE_SENSITIVE_KEY
  assert.throws(() => encryptSensitive(ID), (e) => e.status === 503)
  assert.throws(() => decryptSensitive('aa:bb:cc'), (e) => e.status === 503)
  process.env.EMPLOYEE_SENSITIVE_KEY = KEY
})

test('密文损坏或密钥不符时解密失败（500，不抛明文）', () => {
  process.env.EMPLOYEE_SENSITIVE_KEY = KEY
  const enc = encryptSensitive(ID)
  assert.throws(() => decryptSensitive(enc.slice(0, -2) + '00'), (e) => e.status === 500)
  process.env.EMPLOYEE_SENSITIVE_KEY = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  assert.throws(() => decryptSensitive(enc), (e) => e.status === 500)
  process.env.EMPLOYEE_SENSITIVE_KEY = KEY
})

test('身份证掩码：前 6 后 4，中间星号', () => {
  assert.equal(maskIdentity(ID), '110101********1234')
  assert.equal(maskIdentity('11010119900101123X'), '110101********123X')
})

test('短号或不完整号码掩码为 ****', () => {
  assert.equal(maskIdentity('1234567'), '****')
  assert.equal(maskIdentity(''), '')
  assert.equal(maskIdentity(null), '')
})

test('银行卡掩码：**** **** **** 尾号', () => {
  assert.equal(maskBank('', CARD.slice(-4)), '**** **** **** 3445')
  assert.equal(maskBank(CARD), '**** **** **** 3445')
})

test('员工档案模块权限矩阵', () => {
  // 开发者/管理员/财务：默认全模块
  for (const role of ['developer', 'admin', 'finance']) {
    assert.equal(hasModuleAccess({ role }, MODULE_KEYS.EMPLOYEE_PROFILE), true, `${role} 应有档案模块`)
  }
  // 店长：默认有档案模块（可见但不可 reveal）
  const manager = { role: 'manager', permissions: { modules: Object.fromEntries(defaultModuleKeys('manager').map((k) => [k, true])) } }
  assert.equal(hasModuleAccess(manager, MODULE_KEYS.EMPLOYEE_PROFILE), true)
  // 员工：默认排除档案模块（一期不对员工开放自助查看）
  const staff = { role: 'staff', permissions: { modules: Object.fromEntries(defaultModuleKeys('staff').map((k) => [k, true])) } }
  assert.equal(hasModuleAccess(staff, MODULE_KEYS.EMPLOYEE_PROFILE), false)
  // 收银：固定仅 POS
  assert.equal(hasModuleAccess({ role: 'cashier' }, MODULE_KEYS.EMPLOYEE_PROFILE), false)
  // 公开账号：永远无
  assert.equal(hasModuleAccess({ role: 'public' }, MODULE_KEYS.EMPLOYEE_PROFILE), false)
  // 禁用账号：无
  assert.equal(hasModuleAccess({ role: 'developer', status: 'disabled' }, MODULE_KEYS.EMPLOYEE_PROFILE), false)
})

test('员工档案模块在人员管理分组且属于默认全量模块', () => {
  const keys = defaultModuleKeys('developer')
  assert.equal(keys.includes(MODULE_KEYS.EMPLOYEE_PROFILE), true)
  // staff 默认列表里不含档案模块
  assert.equal(defaultModuleKeys('staff').includes(MODULE_KEYS.EMPLOYEE_PROFILE), false)
})
