// 审批引擎核心纯函数单测：node scripts/test-approval-engine.mjs
import {
  APPROVAL_TRANSITIONS,
  canTransition,
  canViewRequest,
  canSubmit,
  canWithdraw,
  canDecide,
  canArchive,
  canDelete,
  canEdit,
  isApproverFor,
  moneyToCents,
  centsToYuan,
  validateFormData,
  resolveCcUsers,
  genRequestNo,
  scopeFilter,
} from '../server/approvals-core.js'

let pass = 0
let fail = 0
const ok = (label, cond) => {
  if (cond) {
    pass += 1
    console.log(`  [PASS] ${label}`)
  } else {
    fail += 1
    console.log(`  [FAIL] ${label}`)
  }
}

// ---------- 1. 状态机 ----------
console.log('== 状态机 ==')
ok('draft→pending', canTransition('draft', 'pending'))
ok('pending→approved', canTransition('pending', 'approved'))
ok('pending→rejected', canTransition('pending', 'rejected'))
ok('pending→withdrawn', canTransition('pending', 'withdrawn'))
ok('approved→archived', canTransition('approved', 'archived'))
ok('rejected→archived', canTransition('rejected', 'archived'))
ok('rejected→pending（驳回重提）', canTransition('rejected', 'pending'))
ok('draft 不可撤回', !canTransition('draft', 'withdrawn'))
ok('withdrawn 终态', canTransition('withdrawn', 'archived') === false)
ok('archived 终态', canTransition('archived', 'pending') === false)
ok('approved 不可直接撤回', !canTransition('approved', 'withdrawn'))
ok('未知状态拒绝', !canTransition('nope', 'pending'))

// ---------- 2. 权限矩阵 ----------
console.log('== 权限矩阵 ==')
const dev = { username: 'budu', role: 'developer' }
const staff = { username: 'lifeyan', role: 'staff' }
const manager = { username: 'manager1', role: 'manager' }
const finance = { username: 'caiwu', role: 'finance' }
const publicU = { username: 'guest', role: 'public' }
const cashier = { username: 'cashier1', role: 'cashier' }
const template = { approverRule: { type: 'role', role: 'developer' } }
const reqPending = { id: 'r1', status: 'pending', submitterUsername: 'lifeyan' }
const reqApproved = { id: 'r2', status: 'approved', submitterUsername: 'lifeyan' }
const reqDraft = { id: 'r3', status: 'draft', submitterUsername: 'lifeyan' }
const reqRejected = { id: 'r4', status: 'rejected', submitterUsername: 'lifeyan' }
const reqWithdrawn = { id: 'r5', status: 'withdrawn', submitterUsername: 'lifeyan' }
const ccList = [{ ccUsername: 'caiwu' }]

ok('审批人识别：developer 是审批人', isApproverFor(dev, reqPending, template))
ok('审批人识别：finance 与开发者一致可审批', isApproverFor(finance, reqPending, template))
ok('审批人识别：staff 不是审批人', !isApproverFor(staff, reqPending, template))
ok('提交人可见', canViewRequest(staff, reqPending, { template }))
ok('审批人可见', canViewRequest(dev, reqPending, { template }))
ok('开发者可见任何状态', canViewRequest(dev, reqWithdrawn, { template }))
ok('财务可见待审批（与开发者一致）', canViewRequest(finance, reqPending, { template }))
ok('财务可见已通过', canViewRequest(finance, reqApproved, { template }))
ok('财务可见已驳回（与开发者一致）', canViewRequest(finance, reqRejected, { template }))
ok('财务可见已撤回（与开发者一致）', canViewRequest(finance, reqWithdrawn, { template }))
ok('抄送人可见（含已通过）', canViewRequest(finance, reqApproved, { template, ccList }))
ok('无关店员不可见', !canViewRequest(manager, reqPending, { template }))
ok('public 不可见', !canViewRequest(publicU, reqPending, { template }))
ok('cashier 不可见', !canViewRequest(cashier, reqPending, { template }))
ok('提交人可撤回待审批', canWithdraw(staff, reqPending))
ok('提交人不可撤回他人单据', !canWithdraw(manager, reqPending))
ok('提交人可提交草稿', canSubmit(staff, reqDraft))
ok('提交人可驳回重提', canSubmit(staff, reqRejected))
ok('已通过不可再提交', !canSubmit(staff, reqApproved))
ok('审批人可审批', canDecide(dev, reqPending, template))
ok('财务可审批（与开发者一致）', canDecide(finance, reqPending, template))
ok('员工不可审批', !canDecide(staff, reqPending, template))
ok('开发者可归档已通过', canArchive(dev, reqApproved))
ok('开发者可归档已驳回', canArchive(dev, reqRejected))
ok('财务可归档（与开发者一致）', canArchive(finance, reqApproved))
ok('开发者不可归档待审批', !canArchive(dev, reqPending))
ok('创建人可删草稿', canDelete(staff, reqDraft))
ok('财务不可删他人草稿', !canDelete(finance, { id: 'x', status: 'draft', submitterUsername: 'other' }))
ok('开发者可删他人草稿', canDelete(dev, { id: 'x', status: 'draft', submitterUsername: 'other' }))
ok('不可删已提交单据', !canDelete(staff, reqPending))
ok('驳回后提交人可编辑', canEdit(staff, reqRejected))
ok('草稿可编辑', canEdit(staff, reqDraft))
ok('待审批不可编辑', !canEdit(staff, reqPending))

// ---------- 3. 金额转换 ----------
console.log('== 金额 ==')
ok('123 → 12300 分', moneyToCents('123') === 12300)
ok('123.45 → 12345 分', moneyToCents('123.45') === 12345)
ok('0.01 → 1 分', moneyToCents('0.01') === 1)
ok('三位小数拒绝', (() => { try { moneyToCents('1.234'); return false } catch { return true } })())
ok('负数拒绝', (() => { try { moneyToCents('-5'); return false } catch { return true } })())
ok('空拒绝', (() => { try { moneyToCents(''); return false } catch { return true } })())
ok('分→元', centsToYuan(12345) === '123.45')
ok('0 分→元', centsToYuan(0) === '0.00')

// ---------- 4. 表单校验 ----------
console.log('== 表单校验 ==')
const expenseSchema = [
  { key: 'expenseType', label: '报销类型', type: 'select', required: true },
  { key: 'amount', label: '金额', type: 'money', required: true, amount: true },
  { key: 'occurredDate', label: '发生日期', type: 'date', required: true },
  { key: 'remark', label: '备注', type: 'textarea' },
]
const f1 = validateFormData(expenseSchema, { expenseType: '餐饮', amount: '88.5', occurredDate: '2026-08-18', remark: '团建' })
ok('合法表单无错误', f1.errors.length === 0)
ok('金额转分', f1.normalized.amount === 8850)
ok('备注保留', f1.normalized.remark === '团建')
const f2 = validateFormData(expenseSchema, { expenseType: '', amount: 'abc', occurredDate: '2026/08/18' })
ok('必填缺失报错', f2.errors.some((e) => e.includes('报销类型')))
ok('金额格式报错', f2.errors.some((e) => e.includes('金额')))
ok('日期格式报错', f2.errors.some((e) => e.includes('发生日期')))

const payrollSchema = [
  { key: 'salaryMonth', label: '工资月份', type: 'month', required: true },
  { key: 'store', label: '门店', type: 'store', required: true },
  { key: 'employee', label: '员工', type: 'employee', required: true },
  { key: 'grossPay', label: '应发', type: 'money', required: true },
  { key: 'netPay', label: '实发', type: 'money', required: true, amount: true },
]
const f3 = validateFormData(payrollSchema, { salaryMonth: '2026-08', store: 'tongying', employee: 'tongying::李飞燕', grossPay: '5000', netPay: '4321.56' })
ok('工资表单合法', f3.errors.length === 0)
ok('employee 保留 storeKey::name', f3.normalized.employee === 'tongying::李飞燕')
ok('月份格式', f3.normalized.salaryMonth === '2026-08')

// ---------- 5. 抄送规则 ----------
console.log('== 抄送规则 ==')
const ctx = {
  roleUsers: {
    finance: [{ username: 'caiwu', name: '财务小张' }],
  },
  submitter: { username: 'lifeyan', name: '李飞燕' },
  formData: { employee: 'tongying::李飞燕' },
  staffKeyMap: { 'tongying::李飞燕': { username: 'lifeyan', name: '李飞燕' } },
}
const cc1 = resolveCcUsers([{ type: 'role', role: 'finance' }], ctx)
ok('角色抄送：财务', cc1.length === 1 && cc1[0].username === 'caiwu')
const cc2 = resolveCcUsers([{ type: 'role', role: 'finance' }, { type: 'submitter' }], ctx)
ok('报销抄送：财务+提交人', cc2.length === 2 && cc2.some((c) => c.username === 'lifeyan'))
const cc3 = resolveCcUsers([{ type: 'role', role: 'finance' }, { type: 'staffField', field: 'employee' }], ctx)
ok('工资抄送：财务+该员工', cc3.length === 2 && cc3.some((c) => c.username === 'lifeyan'))
const ctxNoBind = { ...ctx, staffKeyMap: {} }
const cc4 = resolveCcUsers([{ type: 'staffField', field: 'employee' }], ctxNoBind)
ok('员工未绑定账号则跳过', cc4.length === 0)
const cc5 = resolveCcUsers([{ type: 'role', role: 'finance' }, { type: 'role', role: 'finance' }], ctx)
ok('重复抄送去重', cc5.length === 1)

// ---------- 6. 单号 ----------
console.log('== 单号 ==')
ok('单号格式 AP-YYYYMMDD-0001', genRequestNo(new Date(2026, 7, 19), 1) === 'AP-20260819-0001')
ok('序号补零', genRequestNo(new Date(2026, 7, 19), 42) === 'AP-20260819-0042')

// ---------- 7. scope ----------
console.log('== scope ==')
ok('my 按提交人', scopeFilter('my', staff).submitterUsername === 'lifeyan')
ok('all+finance 全量（与开发者一致）', Object.keys(scopeFilter('all', finance)).length === 0)
ok('all+developer 全量', Object.keys(scopeFilter('all', dev)).length === 0)

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
