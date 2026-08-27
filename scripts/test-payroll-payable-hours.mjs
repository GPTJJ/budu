// Gate 29B：Employee.id 稳定工资以 tagged union 归一化后的 payableHours 为唯一计薪工时权威。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { calcDailyPay } = await import(path.join(root, 'src/utils/payroll.js').replaceAll('\\', '/'))
const { calculateEmployeeIdShadowPayroll } = await import(path.join(root, 'src/utils/payrollShadowCalculator.js').replaceAll('\\', '/'))
const { employeeDailyPayDetail } = await import(path.join(root, 'src/utils/selectors.js').replaceAll('\\', '/'))
const { buildIssueSnapshot } = await import(path.join(root, 'src/utils/payrollIssue.js').replaceAll('\\', '/'))
const { seedCachedDataForTest } = await import(path.join(root, 'src/utils/userData.js').replaceAll('\\', '/'))

const attendance = (employeeId, name, storeId, date, actualHours) => ({
  id: `${employeeId}-${date}`,
  storeId,
  storeKey: storeId,
  date,
  employeeId,
  staffId: `staff-${employeeId}`,
  staffNameSnapshot: name,
  actualHours,
})

// 1. 用户场景：通盈工作日，2050 元，单人实际 8h => 280（旧稳定结果 420 不得保留）。
{
  const entries = { '2026-08|tongying|08-10': { inc: 2050, ord: 20, staff: ['叶芷辰'] } }
  const rows = [attendance('emp-ye', '叶芷辰', 'tongying', '2026-08-10', 8)]
  const rec = calculateEmployeeIdShadowPayroll(entries, rows, [], [], '2026-08').employees[0]
  assert.deepEqual(
    { hours: rec.payableHours, basePay: rec.basePay, commission: rec.commission, subsidy: rec.transferSubsidy, salary: rec.salary },
    { hours: 8, basePay: 240, commission: 40, subsidy: 0, salary: 280 },
  )
  console.log('  [用户场景] 通盈 2050 / 1人 / 8h = 280 PASS')
}

// 2. 同店两人：参与人数只决定费率，金额分别按 8h / 6h。
{
  const entries = { '2026-08|tongying|08-10': { inc: 2050, ord: 20, staff: ['张伟', '张伟'] } }
  const rows = [
    attendance('emp-A', '张伟', 'tongying', '2026-08-10', 8),
    attendance('emp-B', '张伟', 'tongying', '2026-08-10', 6),
  ]
  const out = calculateEmployeeIdShadowPayroll(entries, rows, [], [], '2026-08')
  const a = out.employees.find((row) => row.employeeId === 'emp-A')
  const b = out.employees.find((row) => row.employeeId === 'emp-B')
  assert.deepEqual({ basePay: a.basePay, commission: a.commission, salary: a.salary }, { basePay: 224, commission: 40, salary: 264 })
  assert.deepEqual({ basePay: b.basePay, commission: b.commission, salary: b.salary }, { basePay: 168, commission: 30, salary: 198 })
  assert.notEqual(a.salary, b.salary)
  console.log('  [双员工] A 8h=264 / B 6h=198 / 无身份交叉 PASS')
}

// 3. 周末目标、官舍补贴规则不变；仅乘数改为实际工时。
{
  const weekend = calcDailyPay({ storeKey: 'tongying', revenue: 4800, date: '2026-08-09', staffCount: 1, payableHours: 8 })
  assert.deepEqual({ basePay: weekend.basePay, rate: weekend.commissionRate, commission: weekend.commission, total: weekend.total }, { basePay: 240, rate: 0, commission: 0, total: 240 })
  const guanshe = calcDailyPay({ storeKey: 'guanshe', revenue: 0, date: '2026-08-10', staffCount: 1, payableHours: 7 })
  assert.deepEqual({ basePay: guanshe.basePay, subsidyRate: guanshe.transferSubsidyRate, subsidy: guanshe.transferSubsidy, total: guanshe.total }, { basePay: 210, subsidyRate: 2, subsidy: 14, total: 224 })
  console.log('  [规则冻结] 通盈周末目标 / 官舍 2元每小时补贴 PASS')
}

// 4. 真实 0h 不回退；显式非法稳定工时 fail closed。省略参数仍是 legacy dutyHours。
{
  assert.equal(calcDailyPay({ storeKey: 'tongying', revenue: 2050, date: '2026-08-10', staffCount: 1, payableHours: 0 }).total, 0)
  for (const bad of [undefined, null, '', Number.NaN, -1]) {
    assert.throws(() => calcDailyPay({ storeKey: 'tongying', revenue: 2050, date: '2026-08-10', staffCount: 1, payableHours: bad }), /payableHours/)
  }
  assert.equal(calcDailyPay({ storeKey: 'tongying', revenue: 2050, date: '2026-08-10', staffCount: 1 }).total, 420, 'legacy 仍使用 12h dutyHours')
  const entries = { '2026-08|tongying|08-10': { inc: 2050, ord: 20, staff: ['叶芷辰'] } }
  assert.throws(
    () => calculateEmployeeIdShadowPayroll(entries, [attendance('emp-ye', '叶芷辰', 'tongying', '2026-08-10', undefined)], [], [], '2026-08'),
    /payableHours/,
  )
  console.log('  [校验] 0h 保留 / 非法稳定工时拒绝 / legacy 兼容 PASS')
}

// 5. 正常员工的月汇总、导出逐日明细、发放快照严格复用同一金额结果。
{
  const entries = { '2026-08|tongying|08-10': { inc: 2050, ord: 20, staff: ['叶芷辰'] } }
  const rows = [attendance('emp-ye', '叶芷辰', 'tongying', '2026-08-10', 8)]
  seedCachedDataForTest({
    entries,
    staff: [{ id: 'emp-ye', name: '叶芷辰', storeKey: 'tongying', type: 'fulltime' }],
    dailyPayAdjustments: [], bigBonuses: [], removedStaff: [], stores: [{ key: 'tongying', name: '北京通盈中心店' }],
    schedules: {}, products: [], inventoryRequests: [], inventory: [], analysis: {}, productImages: {}, posDaily: [], posProductSales: [],
  })
  const rec = calculateEmployeeIdShadowPayroll(entries, rows, [], [], '2026-08').employees[0]
  const detail = employeeDailyPayDetail('2026-08', '08-10', '叶芷辰', 'emp-ye', rows)
  assert.deepEqual(
    { basePay: detail.totals.basePay, commission: detail.totals.commission, subsidy: detail.totals.transferSubsidy, pay: detail.totals.pay },
    { basePay: rec.basePay, commission: rec.commission, subsidy: rec.transferSubsidy, pay: rec.salary },
  )
  const snapshot = buildIssueSnapshot(rec, { month: '2026-08', name: '叶芷辰', attendanceRows: rows })
  const sum = (field) => Math.round(snapshot.days.reduce((total, day) => total + Number(day[field] || 0), 0) * 100) / 100
  assert.equal(sum('basePay'), snapshot.summary.basePay)
  assert.equal(sum('commission'), snapshot.summary.commission)
  assert.equal(sum('transferSubsidy'), snapshot.summary.transferSubsidy)
  assert.equal(sum('pay'), snapshot.summary.total)
  console.log('  [对账] 月汇总 = 导出日明细 = 发放快照 PASS')
}

// 6. Gate 29E：展示姓名只是快照，不得成为工资资格；普通稳定考勤必须正常计薪。
{
  const entries = { '2026-08|guanshe|08-10': { inc: 0, ord: 0, staff: ['卡皮巴拉'] } }
  const rows = [attendance('emp-capy', '卡皮巴拉', 'guanshe', '2026-08-10', 8)]
  const rec = calculateEmployeeIdShadowPayroll(entries, rows, [], [], '2026-08').employees[0]
  assert.deepEqual(
    { hours: rec.payableHours, basePay: rec.basePay, subsidy: rec.transferSubsidy, salary: rec.salary },
    { hours: 8, basePay: 240, subsidy: 16, salary: 256 },
    '展示姓名不得使稳定工资归零',
  )
  console.log('  [姓名安全] 展示姓名不影响稳定工资资格 PASS')
}

console.log('GATE 29B PAYROLL PAYABLE HOURS TEST OK')
