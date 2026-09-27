// Gate 22：payroll 月就绪度评估（纯函数，READINESS ONLY）
// A 全就绪 / B 计算就绪发放未就绪 / C 重复绑定 / D mixed 考勤 / E legacy 调整
// F legacy 奖金 / G 同店同名全就绪 / H 缺业务 / I 月隔离 / J 前员工 / K coverage 指标
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { evaluatePayrollReadiness } = await import(path.join(root, 'src/utils/payrollReadiness.js').replaceAll('\\', '/'))

const baseEmployees = [
  { id: 'emp-A', status: 'ACTIVE' },
  { id: 'emp-B', status: 'ACTIVE' },
]
const baseUsers = [
  { username: 'user-A', employeeId: 'emp-A', status: 'active' },
  { username: 'user-B', employeeId: 'emp-B', status: 'active' },
]
const entry = (inc = 6000, ord = 60) => ({ inc, ord, staff: ['张伟', '李四'] })
const staffRow = (id, date, employeeId, name) => ({ id, storeId: 'guanshe', storeKey: 'guanshe', date, employeeId, staffId: `st-${id}`, staffNameSnapshot: name, actualHours: 8 })

// A: 全就绪（唯一名场景用 张伟/李四 更清晰；同店同名留给 G）
{
  const entries = { '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟', '李四'] } }
  const staff = [staffRow('a', '2026-09-01', 'emp-A', '张伟'), staffRow('b', '2026-09-01', 'emp-B', '李四')]
  const adjustments = [{ employeeId: 'emp-A', date: '2026-09-01' }]
  const bonuses = [{ employeeId: 'emp-B', date: '2026-09-01' }]
  const out = evaluatePayrollReadiness({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, dailyPayAdjustments: adjustments, bigOrderBonuses: bonuses, employees: baseEmployees, users: baseUsers })
  assert.equal(out.calculationReady, true, 'A calc ready')
  assert.equal(out.issueReady, true, 'A issue ready')
  assert.equal(out.calculationBlockers.length, 0)
  assert.equal(out.issueBlockers.length, 0)
  assert.equal(out.employees.length, 2)
  assert.equal(out.employees.every((e) => e.issueReady), true)
  console.log('  [A] 全就绪 PASS')
}

// B: 计算就绪 / 发放未就绪（emp-B 无绑定）
{
  const entries = { '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟', '李四'] } }
  const staff = [staffRow('a', '2026-09-01', 'emp-A', '张伟'), staffRow('b', '2026-09-01', 'emp-B', '李四')]
  const out = evaluatePayrollReadiness({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, employees: baseEmployees, users: [{ username: 'user-A', employeeId: 'emp-A', status: 'active' }] })
  assert.equal(out.calculationReady, true, 'B calc ready（不要求绑定）')
  assert.equal(out.issueReady, false, 'B issue not ready')
  const empA = out.employees.find((e) => e.employeeId === 'emp-A')
  const empB = out.employees.find((e) => e.employeeId === 'emp-B')
  assert.equal(empA.issueReady, true, 'B emp-A issue ready')
  assert.equal(empB.issueReady, false, 'B emp-B issue unready')
  assert.equal(empB.blockers.some((b) => b.reason === 'UNBOUND_PAYROLL_RECIPIENT'), true, 'B reason')
  console.log('  [B] 计算/发放分离 PASS')
}

// C: 重复绑定
{
  const entries = { '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟'] } }
  const staff = [staffRow('a', '2026-09-01', 'emp-A', '张伟')]
  const users = [
    { username: 'user-A', employeeId: 'emp-A', status: 'active' },
    { username: 'user-A2', employeeId: 'emp-A', status: 'active' },
  ]
  const out = evaluatePayrollReadiness({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, employees: baseEmployees, users })
  assert.equal(out.calculationReady, true, 'C calc ready')
  assert.equal(out.issueReady, false, 'C issue not ready')
  assert.equal(out.employees[0].blockers.some((b) => b.reason === 'DUPLICATE_PAYROLL_RECIPIENT'), true, 'C reason')
  console.log('  [C] 重复绑定 PASS')
}

// D: mixed 考勤
{
  const entries = { '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟', '王五'] } }
  const staff = [
    staffRow('a', '2026-09-01', 'emp-A', '张伟'),
    { id: 'legacy', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-09-01', employeeId: null, staffId: 'st-legacy', staffNameSnapshot: '王五', actualHours: 4 },
  ]
  const out = evaluatePayrollReadiness({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, employees: baseEmployees, users: baseUsers })
  assert.equal(out.calculationReady, false, 'D calc not ready')
  assert.equal(out.issueReady, false, 'D issue not ready')
  assert.equal(out.calculationBlockers.some((b) => b.reason === 'MIXED_STABLE_LEGACY'), true, 'D reason')
  console.log('  [D] mixed 考勤 PASS')
}

// E: legacy 调整
{
  const entries = { '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟'] } }
  const staff = [staffRow('a', '2026-09-01', 'emp-A', '张伟')]
  const adjustments = [{ employeeId: null, staffName: '张伟', date: '2026-09-01' }]
  const out = evaluatePayrollReadiness({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, dailyPayAdjustments: adjustments, employees: baseEmployees, users: baseUsers })
  assert.equal(out.calculationReady, false, 'E calc not ready')
  assert.equal(out.calculationBlockers.some((b) => b.reason === 'LEGACY_PAY_ADJUSTMENT_IDENTITY'), true, 'E reason')
  console.log('  [E] legacy 调整 PASS')
}

// F: legacy 奖金
{
  const entries = { '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟'] } }
  const staff = [staffRow('a', '2026-09-01', 'emp-A', '张伟')]
  const bonuses = [{ employeeId: null, staffName: '张伟', date: '2026-09-01' }]
  const out = evaluatePayrollReadiness({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, bigOrderBonuses: bonuses, employees: baseEmployees, users: baseUsers })
  assert.equal(out.calculationReady, false, 'F calc not ready')
  assert.equal(out.calculationBlockers.some((b) => b.reason === 'LEGACY_BIG_BONUS_IDENTITY'), true, 'F reason')
  console.log('  [F] legacy 奖金 PASS')
}

// G: 同店同名全就绪（Gate 16 后）
{
  const entries = { '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟', '张伟'] } }
  const staff = [staffRow('a', '2026-09-01', 'emp-A', '张伟'), staffRow('b', '2026-09-01', 'emp-B', '张伟')]
  const out = evaluatePayrollReadiness({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, employees: baseEmployees, users: baseUsers })
  assert.equal(out.calculationReady, true, 'G calc ready')
  assert.equal(out.issueReady, true, 'G issue ready')
  assert.equal(out.employees.length, 2, 'G 2 payroll employees')
  assert.equal(out.employees.every((e) => e.issueReady), true)
  console.log('  [G] 同店同名全就绪 PASS')
}

// H: 孤立 DSS 不构成工资主体或 completeness dependency
{
  const staff = [staffRow('a', '2026-09-01', 'emp-A', '张伟')]
  const out = evaluatePayrollReadiness({ month: '2026-09', dailyEntries: {}, dailyStoreStaffRows: staff, employees: baseEmployees, users: baseUsers })
  assert.equal(out.calculationReady, false, 'H calc not ready')
  assert.equal(out.calculationBlockers.some((b) => b.reason === 'MISSING_DAILY_ENTRY'), false, 'H no false dependency')
  assert.equal(out.calculationBlockers.some((b) => b.reason === 'NO_PAYROLL_SUBJECTS'), true, 'H empty authoritative subject set')
  assert.equal(out.coverage.orphanAttendanceRows, 1, 'H orphan remains observable')
  console.log('  [H] orphan dependency isolation PASS')
}

// I: 月隔离
{
  const entries = {
    '2026-08|guanshe|08-01': { inc: 1000, ord: 10, staff: ['赵六'] },
    '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟'] },
  }
  const staff = [
    { id: 'aug', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-01', employeeId: null, staffId: 'st-aug', staffNameSnapshot: '赵六', actualHours: 8 },
    staffRow('a', '2026-09-01', 'emp-A', '张伟'),
  ]
  const adjustments = [{ employeeId: null, staffName: '赵六', date: '2026-08-01' }]
  const out = evaluatePayrollReadiness({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, dailyPayAdjustments: adjustments, employees: baseEmployees, users: baseUsers })
  assert.equal(out.calculationReady, true, 'I 8月 legacy 数据不影响 9 月')
  assert.equal(out.issueReady, true, 'I issue ready')
  assert.equal(out.coverage.totalBusinessDays, 1, 'I 只统计 9 月业务日')
  console.log('  [I] 月隔离 PASS')
}

// J: 前员工（RESIGNED 不阻断计算；发放按绑定）
{
  const entries = { '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟'] } }
  const staff = [staffRow('a', '2026-09-01', 'emp-A', '张伟')]
  const resignedEmployees = [{ id: 'emp-A', status: 'RESIGNED' }]
  const resignedUsers = [{ username: 'user-A', employeeId: 'emp-A', status: 'active' }]
  const out = evaluatePayrollReadiness({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, employees: resignedEmployees, users: resignedUsers })
  assert.equal(out.calculationReady, true, 'J calc ready（RESIGNED 不阻断）')
  assert.equal(out.issueReady, true, 'J issue ready（绑定有效）')
  console.log('  [J] 前员工 PASS')
}

// K: coverage 指标
{
  const entries = {
    '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟', '李四'] },
    '2026-09|guanshe|09-02': { inc: 3000, ord: 30, staff: ['王五'] },
  }
  const staff = [staffRow('a', '2026-09-01', 'emp-A', '张伟'), staffRow('b', '2026-09-01', 'emp-B', '李四')]
  const out = evaluatePayrollReadiness({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, employees: baseEmployees, users: baseUsers })
  assert.equal(out.calculationReady, false, 'K 09-02 仅姓名日 → 未就绪')
  assert.equal(out.coverage.totalBusinessDays, 2)
  assert.equal(out.coverage.stableEligibleDays, 1)
  assert.equal(out.coverage.payrollEmployeeCount, 2)
  assert.ok(out.coverage.reasonCounts.LEGACY_NAME_ONLY_ENTRY >= 1, 'K reason count')
  console.log('  [K] coverage 指标 PASS')
}

// L: 孤立 DSS 不得使任何员工进入 incomplete
{
  const entries = { '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟', '李四'] } }
  const staff = [
    staffRow('a', '2026-09-01', 'emp-A', '张伟'),
    staffRow('b', '2026-09-01', 'emp-B', '李四'),
    staffRow('b-orphan', '2026-09-02', 'emp-B', '李四'),
  ]
  const out = evaluatePayrollReadiness({ month: '2026-09', dailyEntries: entries, dailyStoreStaffRows: staff, employees: baseEmployees, users: baseUsers })
  assert.equal(out.calculationReady, true, 'L valid period remains ready')
  assert.equal(out.issueReady, true, 'L valid issuance remains ready')
  const empA = out.employees.find((row) => row.employeeId === 'emp-A')
  const empB = out.employees.find((row) => row.employeeId === 'emp-B')
  assert.equal(empA.calculationReady, true, 'L unaffected employee remains display-calculable')
  assert.equal(empB.calculationReady, true, 'L orphan does not affect employee')
  assert.equal(empB.blockers.some((blocker) => blocker.reason === 'MISSING_DAILY_ENTRY'), false)
  assert.equal(out.coverage.orphanAttendanceRows, 1)
  console.log('  [L] orphan 不污染员工完整性 PASS')
}

console.log('GATE 22 PAYROLL READINESS TEST OK')
