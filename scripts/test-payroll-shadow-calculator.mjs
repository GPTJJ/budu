// Gate 14：Employee.id shadow 月度工资计算器（SHADOW ONLY，零 live 消费）
// A 单员工整月 / B 同日两人 share / C 跨店同名分离 / D 调店 / E 前员工
// F mixed legacy 日拒绝 / G 仅姓名日 unresolved / H 缺业务日 unresolved
// I 简单 parity（legacy vs shadow）/ J 重名 legacy merge vs shadow 分离 / K coverage
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { calculateEmployeeIdShadowPayroll } = await import(path.join(root, 'src/utils/payrollShadowCalculator.js').replaceAll('\\', '/'))
const { monthlyPayrollFromEntries } = await import(path.join(root, 'src/utils/payroll.js').replaceAll('\\', '/'))

// ---- I: 简单唯一名 parity（legacy vs shadow 同一参与者、同公式、同金额）----
{
  // 9 月 10 个工作日，每店每天 1 人（张三 guanshe、李四 chaowai），营业额 6000 元/天
  const entries = {}
  const staff = []
  for (let d = 1; d <= 10; d += 1) {
    const day = String(d).padStart(2, '0')
    entries[`2026-09|guanshe|09-${day}`] = { inc: 6000, ord: 60, staff: ['张三'] }
    entries[`2026-09|chaowai|09-${day}`] = { inc: 6000, ord: 60, staff: ['李四'] }
    // 该 parity fixture 的实际工时刻意等于 legacy 门店默认班次；稳定合同本身不再依赖默认班次。
    staff.push({ id: `g${d}`, storeId: 'guanshe', storeKey: 'guanshe', date: `2026-09-${day}`, employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张三', actualHours: 11 })
    staff.push({ id: `c${d}`, storeId: 'chaowai', storeKey: 'chaowai', date: `2026-09-${day}`, employeeId: 'emp-B', staffId: 'st-b', staffNameSnapshot: '李四', actualHours: 11.5 })
  }
  const shadow = calculateEmployeeIdShadowPayroll(entries, staff)
  assert.equal(shadow.employees.length, 2, 'I 两名员工')
  assert.equal(shadow.coverage.stableEligibleDays, 20, 'I 20 个稳定日')
  assert.equal(shadow.coverage.unresolvedDaysCount, 0, 'I 无 unresolved')
  // legacy 计算（同一输入，name 聚合）
  const legacyMap = monthlyPayrollFromEntries(entries, '2026-09')
  const legacyZhang = legacyMap.get('张三')
  const legacyLi = legacyMap.get('李四')
  assert.ok(legacyZhang && legacyLi, 'I legacy 两名')
  const shadowA = shadow.employees.find((e) => e.employeeId === 'emp-A')
  const shadowB = shadow.employees.find((e) => e.employeeId === 'emp-B')
  // 金额必须等价（同一公式 calcDailyPay + 同一分摊基数）
  assert.equal(shadowA.salary, Math.round(legacyZhang.salary * 100) / 100, 'I emp-A == legacy 张三')
  assert.equal(shadowB.salary, Math.round(legacyLi.salary * 100) / 100, 'I emp-B == legacy 李四')
  assert.equal(shadowA.basePay, Math.round(legacyZhang.basePay * 100) / 100)
  assert.equal(shadowA.commission, Math.round(legacyZhang.commission * 100) / 100)
  assert.equal(shadowA.transferSubsidy, Math.round(legacyZhang.transferSubsidy * 100) / 100)
  console.log('  [I] 简单 parity PASS（legacy 张三 == shadow emp-A 等额）')
}

// ---- A: 单员工整月 ----
{
  const entries = { '2026-08|guanshe|08-01': { inc: 5000, ord: 50, staff: ['张三'] } }
  const staff = [{ id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-01', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张三', actualHours: 8 }]
  const out = calculateEmployeeIdShadowPayroll(entries, staff)
  assert.equal(out.employees.length, 1)
  assert.equal(out.employees[0].employeeId, 'emp-A')
  assert.equal(out.employees[0].days, 1)
  assert.equal(out.employees[0].actualHours, 8)
  assert.ok(out.employees[0].salary > 0)
  console.log('  [A] 单员工整月 PASS')
}

// ---- B: 同日两人 share=2（分母来自稳定考勤行数）----
{
  const entries = { '2026-08|guanshe|08-02': { inc: 10000, ord: 100, staff: ['张三', '李四'] } }
  const staff = [
    { id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-02', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张三', actualHours: 8 },
    { id: 'r2', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-02', employeeId: 'emp-B', staffId: 'st-b', staffNameSnapshot: '李四', actualHours: 6 },
  ]
  const out = calculateEmployeeIdShadowPayroll(entries, staff)
  assert.equal(out.employees.length, 2)
  const a = out.employees.find((row) => row.employeeId === 'emp-A')
  const b = out.employees.find((row) => row.employeeId === 'emp-B')
  assert.equal(a.salary, 600, 'B emp-A 按实际 8h')
  assert.equal(b.salary, 450, 'B emp-B 按实际 6h')
  console.log('  [B] 同日两人 share PASS')
}

// ---- C: 跨店同名分离 ----
{
  const entries = {
    '2026-08|guanshe|08-03': { inc: 5000, ord: 50, staff: ['张伟'] },
    '2026-08|chaowai|08-03': { inc: 6000, ord: 60, staff: ['张伟'] },
  }
  const staff = [
    { id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-03', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张伟', actualHours: 8 },
    { id: 'r2', storeId: 'chaowai', storeKey: 'chaowai', date: '2026-08-03', employeeId: 'emp-B', staffId: 'st-b', staffNameSnapshot: '张伟', actualHours: 8 },
  ]
  const out = calculateEmployeeIdShadowPayroll(entries, staff)
  assert.equal(out.employees.length, 2, 'C shadow 两名张伟')
  const ids = out.employees.map((e) => e.employeeId).sort()
  assert.deepEqual(ids, ['emp-A', 'emp-B'])
  // 金额独立：不同店营业额 → 不同 commission
  const a = out.employees.find((e) => e.employeeId === 'emp-A')
  const b = out.employees.find((e) => e.employeeId === 'emp-B')
  assert.ok(Math.abs(a.salary - b.salary) > 0.001, 'C 两名张伟金额独立')
  console.log('  [C] 跨店同名分离 PASS')
}

// ---- D: 调店同人保留 ----
{
  const entries = {
    '2026-08|guanshe|08-10': { inc: 5000, ord: 50, staff: ['张三'] },
    '2026-08|chaowai|08-20': { inc: 7000, ord: 70, staff: ['张三'] },
  }
  const staff = [
    { id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-10', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张三', actualHours: 8 },
    { id: 'r2', storeId: 'chaowai', storeKey: 'chaowai', date: '2026-08-20', employeeId: 'emp-A', staffId: 'st-a2', staffNameSnapshot: '张三', actualHours: 8 },
  ]
  const out = calculateEmployeeIdShadowPayroll(entries, staff)
  assert.equal(out.employees.length, 1, 'D 同一人合并')
  assert.equal(out.employees[0].employeeId, 'emp-A')
  assert.deepEqual(out.employees[0].storesWorked.sort(), ['chaowai', 'guanshe'], 'D 两家店历史保留')
  assert.equal(out.employees[0].days, 2)
  console.log('  [D] 调店同人保留 PASS')
}

// ---- E: 前员工保留（不要求 ACTIVE）----
{
  const entries = { '2026-06|guanshe|06-15': { inc: 4000, ord: 40, staff: ['王五'] } }
  const staff = [{ id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-06-15', employeeId: 'emp-X', staffId: 'st-x', staffNameSnapshot: '王五', actualHours: 8 }]
  const out = calculateEmployeeIdShadowPayroll(entries, staff)
  assert.equal(out.employees.length, 1, 'E 前员工保留')
  assert.equal(out.employees[0].employeeId, 'emp-X')
  console.log('  [E] 前员工保留 PASS')
}

// ---- F: mixed stable+legacy 日拒绝 ----
{
  const entries = { '2026-08|guanshe|08-04': { inc: 10000, ord: 100, staff: ['张三', '赵六'] } }
  const staff = [
    { id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-04', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张三', actualHours: 8 },
    { id: 'r2', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-04', employeeId: null, staffId: 'st-legacy', staffNameSnapshot: '赵六', actualHours: 4 },
  ]
  const out = calculateEmployeeIdShadowPayroll(entries, staff)
  assert.equal(out.employees.length, 0, 'F 该日不得部分计算')
  assert.equal(out.coverage.stableEligibleDays, 0)
  assert.ok(out.unresolvedDays.some((u) => u.reason === 'MIXED_STABLE_LEGACY'), 'F MIXED_STABLE_LEGACY 记录')
  console.log('  [F] mixed legacy 日拒绝 PASS')
}

// ---- G: 仅姓名日 unresolved（不合成 id）----
{
  const entries = { '2026-08|guanshe|08-05': { inc: 2000, ord: 20, staff: ['王五'] } }
  const out = calculateEmployeeIdShadowPayroll(entries, [])
  assert.equal(out.employees.length, 0, 'G 无合成员工')
  assert.ok(out.unresolvedDays.some((u) => u.reason === 'LEGACY_NAME_ONLY_ENTRY'))
  console.log('  [G] 仅姓名日 unresolved PASS')
}

// ---- H: 缺业务日 unresolved（不虚构收入）----
{
  const staff = [{ id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-06', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张三', actualHours: 8 }]
  const out = calculateEmployeeIdShadowPayroll({}, staff)
  assert.equal(out.employees.length, 0, 'H 不计算缺业务日')
  assert.ok(out.unresolvedDays.some((u) => u.reason === 'MISSING_DAILY_ENTRY'))
  console.log('  [H] 缺业务日 unresolved PASS')
}

// ---- J: 重名 legacy merge vs shadow 分离 ----
{
  const entries = {
    '2026-08|guanshe|08-07': { inc: 5000, ord: 50, staff: ['张伟'] },
    '2026-08|chaowai|08-07': { inc: 6000, ord: 60, staff: ['张伟'] },
  }
  const staff = [
    { id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-07', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张伟', actualHours: 8 },
    { id: 'r2', storeId: 'chaowai', storeKey: 'chaowai', date: '2026-08-07', employeeId: 'emp-B', staffId: 'st-b', staffNameSnapshot: '张伟', actualHours: 8 },
  ]
  const legacy = monthlyPayrollFromEntries(entries, '2026-08')
  const shadow = calculateEmployeeIdShadowPayroll(entries, staff)
  assert.equal(legacy.size, 1, 'J legacy 合并为一名张伟')
  assert.equal(shadow.employees.length, 2, 'J shadow 分离为两名')
  console.log('  [J] 重名 legacy merge vs shadow 分离 PASS（迁移必要性证明）')
}

// ---- K: coverage 指标 ----
{
  const entries = {
    '2026-08|guanshe|08-08': { inc: 5000, ord: 50, staff: ['张三'] },   // 稳定
    '2026-08|guanshe|08-09': { inc: 3000, ord: 30, staff: ['王五'] },   // 仅姓名
  }
  const staff = [{ id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-08', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张三', actualHours: 8 }]
  const out = calculateEmployeeIdShadowPayroll(entries, staff)
  assert.equal(out.coverage.totalDailyEntries, 2)
  assert.equal(out.coverage.stableEligibleDays, 1)
  assert.equal(out.coverage.unresolvedDaysCount, 1)
  assert.equal(out.coverage.reasonCounts.LEGACY_NAME_ONLY_ENTRY, 1)
  console.log('  [K] coverage 指标 PASS')
}

// ---- 调整/大单奖：稳定行精确 + legacy 不猜测 ----
{
  const entries = { '2026-08|guanshe|08-11': { inc: 5000, ord: 50, staff: ['张三'] } }
  const staff = [{ id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-11', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张三', actualHours: 8 }]
  const bonuses = [
    { employeeId: 'emp-A', date: '2026-08-11', bonusCents: 1000 },
    { employeeId: '', date: '2026-08-11', bonusCents: 5000 }, // legacy NULL 不猜测
  ]
  const adjustments = [
    { employeeId: 'emp-A', date: '2026-08-11', adjustedPayCents: 88888 },
    { employeeId: '', date: '2026-08-11', adjustedPayCents: 77777 }, // legacy NULL 不猜测
  ]
  const out = calculateEmployeeIdShadowPayroll(entries, staff, bonuses, adjustments)
  assert.equal(out.employees.length, 1)
  assert.equal(out.employees[0].bigBonus, 10, '稳定大单奖 1000 分 = 10 元（legacy 5000 未计入）')
  assert.equal(out.employees[0].salary, 888.88, '稳定调整 88888 分覆盖（legacy 77777 未计入）')
  console.log('  [调整/大单奖] 稳定精确 + legacy 不猜测 PASS')
}

console.log('GATE 14 PAYROLL SHADOW CALCULATOR TEST OK')
