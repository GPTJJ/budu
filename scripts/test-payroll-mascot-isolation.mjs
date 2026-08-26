// Gate 29E：历史吉祥物名称仅为展示数据，不得控制任何运行时工资行为。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { monthlyPayrollFromEntries } = await import(path.join(root, 'src/utils/payroll.js').replaceAll('\\', '/'))
const { calculateEmployeeIdShadowPayroll } = await import(path.join(root, 'src/utils/payrollShadowCalculator.js').replaceAll('\\', '/'))

const attendance = (employeeId, actualHours) => ({
  id: `${employeeId}-2026-08-10`,
  storeId: 'tongying',
  storeKey: 'tongying',
  date: '2026-08-10',
  employeeId,
  staffId: `staff-${employeeId}`,
  staffNameSnapshot: '卡皮巴拉',
  actualHours,
})

// A：稳定 Employee.id 路径——展示姓名“卡皮巴拉”按普通单人 8h 计薪。
{
  const entries = { '2026-08|tongying|08-10': { inc: 2050, ord: 20, staff: ['卡皮巴拉'] } }
  const rec = calculateEmployeeIdShadowPayroll(entries, [attendance('emp-capy', 8)], [], [], '2026-08').employees[0]
  assert.deepEqual(
    { hours: rec.actualHours, basePay: rec.basePay, commission: rec.commission, salary: rec.salary },
    { hours: 8, basePay: 240, commission: 40, salary: 280 },
  )
  console.log('  [A] 稳定路径：卡皮巴拉 8h / 2050 = 280 PASS')
}

// B：legacy 姓名兼容路径——姓名仍可作兼容聚合键，但不携带特殊薪资政策。
{
  const entries = { '2026-08|tongying|08-10': { inc: 2050, ord: 20, staff: ['卡皮巴拉'] } }
  const rec = monthlyPayrollFromEntries(entries, '2026-08').get('卡皮巴拉')
  assert.deepEqual(
    { hours: rec.hours, basePay: rec.basePay, commission: rec.commission, salary: rec.salary },
    { hours: 12, basePay: 360, commission: 60, salary: 420 },
  )
  console.log('  [B] legacy 路径：卡皮巴拉按普通 dutyHours 公式 = 420 PASS')
}

// C：同名稳定员工完全按 Employee.id 分离，工时与金额不交叉。
{
  const entries = { '2026-08|tongying|08-10': { inc: 2050, ord: 20, staff: ['卡皮巴拉', '卡皮巴拉'] } }
  const out = calculateEmployeeIdShadowPayroll(entries, [attendance('emp-A', 8), attendance('emp-B', 6)], [], [], '2026-08')
  const a = out.employees.find((row) => row.employeeId === 'emp-A')
  const b = out.employees.find((row) => row.employeeId === 'emp-B')
  assert.deepEqual({ hours: a.actualHours, salary: a.salary }, { hours: 8, salary: 264 })
  assert.deepEqual({ hours: b.actualHours, salary: b.salary }, { hours: 6, salary: 198 })
  console.log('  [C] 同名 Employee.id A=264 / B=198 / 无身份交叉 PASS')
}

// D：锁定运行时不得重新引入 magic-name 工资权威。
{
  const runtime = [
    path.join(root, 'src/utils/payroll.js'),
    path.join(root, 'src/utils/selectors.js'),
  ].map((file) => fs.readFileSync(file, 'utf8')).join('\n')
  assert.doesNotMatch(runtime, /NO_PAY_STAFF|isNoPayStaff/)
  assert.equal(runtime.includes("'卡皮巴拉'"), false)
  console.log('  [D] payroll 运行时无 magic-name 工资权威 PASS')
}

console.log('GATE 29E PAYROLL MASCOT ISOLATION TEST OK')
