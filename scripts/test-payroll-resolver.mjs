// Gate 23：统一 payroll 计算 resolver（纯函数，PURE RESOLVER ONLY，零 live 消费）
// A 全稳定→EMPLOYEE_ID / B 同店同名 2 行 / C-E stable authority 不因 legacy 问题整月降级
// H 月隔离 / I legacy-vs-stable parity / J 零部分稳定 / K 空月确定性
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { resolvePayrollCalculation } = await import(path.join(root, 'src/utils/payrollResolver.js').replaceAll('\\', '/'))
const { monthlyPayrollFromEntries } = await import(path.join(root, 'src/utils/payroll.js').replaceAll('\\', '/'))

const baseUsers = [
  { username: 'user-A', employeeId: 'emp-A', status: 'active' },
  { username: 'user-B', employeeId: 'emp-B', status: 'active' },
]
const staffRow = (id, date, employeeId, name) => ({ id, storeId: 'guanshe', storeKey: 'guanshe', date, employeeId, staffId: `st-${id}`, staffNameSnapshot: name, actualHours: 8 })

// A + I: 全稳定（张伟/李四 唯一名）→ EMPLOYEE_ID + parity
{
  const entries = { '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟', '李四'] } }
  const staff = [staffRow('a', '2026-09-01', 'emp-A', '张伟'), staffRow('b', '2026-09-01', 'emp-B', '李四')]
  const out = resolvePayrollCalculation({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, employees: [{ id: 'emp-A' }, { id: 'emp-B' }], users: baseUsers })
  assert.equal(out.mode, 'EMPLOYEE_ID', 'A mode')
  assert.equal(out.calculationReady, true, 'A calc ready')
  assert.equal(out.issueReady, true, 'A issue ready')
  assert.equal(out.payroll.employees.length, 2, 'A 2 行')
  // parity: shadow 结果与 legacy 等额（同一 calcDailyPay）
  const legacy = monthlyPayrollFromEntries(entries, '2026-09')
  assert.equal(out.payroll.employees.find((e) => e.employeeId === 'emp-A').salary, Math.round(legacy.get('张伟').salary * 100) / 100, 'I emp-A == legacy 张伟')
  assert.equal(out.payroll.employees.find((e) => e.employeeId === 'emp-B').salary, Math.round(legacy.get('李四').salary * 100) / 100, 'I emp-B == legacy 李四')
  console.log('  [A/I] 全稳定 EMPLOYEE_ID + parity PASS')
}

// B: 同店同名 → EMPLOYEE_ID + 2 行
{
  const entries = { '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟', '张伟'] } }
  const staff = [staffRow('a', '2026-09-01', 'emp-A', '张伟'), staffRow('b', '2026-09-01', 'emp-B', '张伟')]
  const out = resolvePayrollCalculation({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, employees: [{ id: 'emp-A' }, { id: 'emp-B' }], users: baseUsers })
  assert.equal(out.mode, 'EMPLOYEE_ID', 'B mode')
  assert.equal(out.payroll.employees.length, 2, 'B 2 payroll rows')
  const ids = out.payroll.employees.map((e) => e.employeeId).sort()
  assert.deepEqual(ids, ['emp-A', 'emp-B'], 'B 分离')
  console.log('  [B] 同店同名 2 行 PASS')
}

// C: unknown legacy 考勤不允许把稳定员工降级到姓名工资
{
  const entries = { '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟', '王五'] } }
  const staff = [
    staffRow('a', '2026-09-01', 'emp-A', '张伟'),
    { id: 'legacy', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-09-01', employeeId: null, staffId: 'st-l', staffNameSnapshot: '王五', actualHours: 4 },
  ]
  const out = resolvePayrollCalculation({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, employees: [{ id: 'emp-A' }], users: baseUsers })
  assert.equal(out.mode, 'EMPLOYEE_ID', 'C mode')
  assert.equal(out.calculationReady, false, 'C calc not ready')
  assert.equal(out.issueReady, false, 'C issue false')
  assert.ok(out.blockers.some((b) => b.reason === 'MIXED_STABLE_LEGACY'), 'C blocker')
  assert.equal(out.payroll.employees.some((e) => !e.employeeId), false, 'C 不合成姓名身份')
  console.log('  [C] unknown legacy 不触发姓名回退 PASS')
}

// D: legacy 调整阻断发放但稳定员工不降级
{
  const entries = { '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟'] } }
  const staff = [staffRow('a', '2026-09-01', 'emp-A', '张伟')]
  const adjustments = [{ employeeId: null, staffName: '张伟', date: '2026-09-01' }]
  const out = resolvePayrollCalculation({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, dailyPayAdjustments: adjustments, employees: [{ id: 'emp-A' }], users: baseUsers })
  assert.equal(out.mode, 'EMPLOYEE_ID', 'D mode')
  assert.ok(out.blockers.some((b) => b.reason === 'LEGACY_PAY_ADJUSTMENT_IDENTITY'), 'D blocker')
  console.log('  [D] legacy 调整 → LEGACY PASS')
}

// E: legacy 奖金阻断发放但稳定员工不降级
{
  const entries = { '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟'] } }
  const staff = [staffRow('a', '2026-09-01', 'emp-A', '张伟')]
  const bonuses = [{ employeeId: null, staffName: '张伟', date: '2026-09-01' }]
  const out = resolvePayrollCalculation({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, bigOrderBonuses: bonuses, employees: [{ id: 'emp-A' }], users: baseUsers })
  assert.equal(out.mode, 'EMPLOYEE_ID', 'E mode')
  assert.ok(out.blockers.some((b) => b.reason === 'LEGACY_BIG_BONUS_IDENTITY'), 'E blocker')
  console.log('  [E] legacy 奖金 → LEGACY PASS')
}

// F: stable + 未绑定 → EMPLOYEE_ID / issue false（不整体降级）
{
  const entries = { '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟', '李四'] } }
  const staff = [staffRow('a', '2026-09-01', 'emp-A', '张伟'), staffRow('b', '2026-09-01', 'emp-B', '李四')]
  const out = resolvePayrollCalculation({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, employees: [{ id: 'emp-A' }, { id: 'emp-B' }], users: [{ username: 'user-A', employeeId: 'emp-A', status: 'active' }] })
  assert.equal(out.mode, 'EMPLOYEE_ID', 'F mode（不因一人未绑定降级）')
  assert.equal(out.calculationReady, true, 'F calc ready')
  assert.equal(out.issueReady, false, 'F issue false')
  assert.equal(out.payroll.employees.length, 2, 'F 两人都算')
  console.log('  [F] stable+未绑定 PASS')
}

// G: 重复绑定 → EMPLOYEE_ID / issue false
{
  const entries = { '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟'] } }
  const staff = [staffRow('a', '2026-09-01', 'emp-A', '张伟')]
  const users = [
    { username: 'user-A', employeeId: 'emp-A', status: 'active' },
    { username: 'user-A2', employeeId: 'emp-A', status: 'active' },
  ]
  const out = resolvePayrollCalculation({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, employees: [{ id: 'emp-A' }], users })
  assert.equal(out.mode, 'EMPLOYEE_ID', 'G mode')
  assert.equal(out.calculationReady, true, 'G calc ready')
  assert.equal(out.issueReady, false, 'G issue false')
  assert.ok(out.blockers.some((b) => b.reason === 'DUPLICATE_PAYROLL_RECIPIENT'), 'G blocker')
  console.log('  [G] 重复绑定 PASS')
}

// H: 月隔离——7 月 legacy 不把 8 月拉进 LEGACY
{
  const entries = {
    '2026-08|guanshe|08-01': { inc: 1000, ord: 10, staff: ['赵六'] },
    '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟'] },
  }
  const staff = [
    { id: 'aug', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-01', employeeId: null, staffId: 'st-aug', staffNameSnapshot: '赵六', actualHours: 8 },
    staffRow('a', '2026-09-01', 'emp-A', '张伟'),
  ]
  const out = resolvePayrollCalculation({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, employees: [{ id: 'emp-A' }], users: baseUsers })
  assert.equal(out.mode, 'EMPLOYEE_ID', 'H 8月 legacy 不影响 9 月')
  assert.equal(out.calculationReady, true, 'H calc ready')
  console.log('  [H] 月隔离 PASS')
}

// J: 缺业务日保持 EMPLOYEE_ID 权威且不虚构金额
{
  const staff = [staffRow('a', '2026-09-01', 'emp-A', '张伟')]
  const out = resolvePayrollCalculation({ month: '2026-09', dailyEntries: {}, dailyStoreStaffRows: staff, employees: [{ id: 'emp-A' }], users: baseUsers })
  assert.equal(out.mode, 'EMPLOYEE_ID', 'J 缺业务保持稳定身份')
  assert.equal(out.calculationReady, false, 'J not ready')
  console.log('  [J] 零部分稳定 PASS')
}

// K: 空月确定性——无 DailyEntry → 确定 LEGACY + 空 payroll
{
  const out = resolvePayrollCalculation({ month: '2026-09', dailyEntries: {}, dailyStoreStaffRows: [], employees: [], users: [] })
  assert.equal(out.mode, 'LEGACY', 'K 空月 mode LEGACY')
  assert.equal(out.calculationReady, false, 'K not ready')
  assert.equal(out.payroll.employees.length, 0, 'K 不虚构工资行')
  assert.ok(Array.isArray(out.blockers), 'K blockers 确定结构')
  console.log('  [K] 空月确定性 PASS')
}

console.log('GATE 23 UNIFIED PAYROLL RESOLVER TEST OK')
