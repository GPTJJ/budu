import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { resolvePayrollCalculation } = await import(path.join(root, 'src/utils/payrollResolver.js').replaceAll('\\', '/'))
const { buildPayrollExportRows } = await import(path.join(root, 'src/utils/payrollExport.js').replaceAll('\\', '/'))
const exportSource = fs.readFileSync(path.join(root, 'src/components/ExportSalaryModal.jsx'), 'utf8')

const staffRow = (id, date, employeeId, name, hours = 8) => ({
  id, storeId: 'guanshe', storeKey: 'guanshe', date, employeeId,
  participantType: 'EMPLOYEE', staffId: `st-${id}`, staffNameSnapshot: name,
  actualHours: hours, historicalPayrollHours: null, payableHoursSource: 'ACTUAL_HOURS',
})

const entries = {
  '2026-08|guanshe|08-31': { inc: 3000, ord: 30, staff: ['张伟'], status: 'confirmed' },
  '2026-09|guanshe|09-01': { inc: 6000, ord: 60, staff: ['张伟', '张伟'], status: 'confirmed' },
}
const staff = [
  staffRow('a0', '2026-08-31', 'emp-A', '张伟'),
  staffRow('a1', '2026-09-01', 'emp-A', '张伟'),
  staffRow('b1', '2026-09-01', 'emp-B', '张伟', 6),
]
const employees = [
  { id: 'emp-A', name: '张伟', employeeNo: 'A001', storeKey: 'guanshe', type: 'fulltime' },
  { id: 'emp-B', name: '张伟', employeeNo: 'B001', storeKey: 'guanshe', type: 'parttime' },
]

const result = resolvePayrollCalculation({
  periodType: 'custom', periodStart: '2026-08-31', periodEnd: '2026-09-01',
  dailyEntries: entries, dailyStoreStaffRows: staff, employees, users: [],
})
assert.equal(result.mode, 'EMPLOYEE_ID')
assert.equal(result.calculationReady, true)
assert.equal(result.issueReady, false, '导出不要求收件人绑定')

const exported = buildPayrollExportRows(result, employees, new Set(['emp-A', 'emp-B']))
assert.equal(exported.summaryRows.length, 2, '同名 Employee.id 独立导出')
assert.equal(exported.detailRows.length, 3, '跨月精确日明细，无遗漏/重复')
assert.deepEqual(new Set(exported.summaryRows.map((row) => row['Employee.id'])), new Set(['emp-A', 'emp-B']))
assert.equal(exported.summaryRows.every((row) => row.周期类型 === 'CUSTOM'), true)
assert.equal(exported.summaryRows.every((row) => row.周期开始 === '2026-08-31' && row.周期结束 === '2026-09-01'), true)
assert.equal(exported.detailRows.every((row) => row.工时来源 === 'ACTUAL_HOURS'), true)
assert.equal(exported.detailRows.every((row) => row['最终工资(元)'] > 0), true)
console.log('  [A/B] 同名隔离 + 跨月 resolver Export PASS')

const onlyA = buildPayrollExportRows(result, employees, new Set(['emp-A']))
assert.equal(onlyA.summaryRows.length, 1)
assert.equal(onlyA.detailRows.length, 2)
assert.equal(onlyA.detailRows.every((row) => row['Employee.id'] === 'emp-A'), true)
console.log('  [C] Employee.id 选择范围 PASS')

assert.match(exportSource, /loadDailyStoreStaffRange\(period\.periodStart, period\.periodEnd\)/)
assert.match(exportSource, /getDailyStoreStaffRangeState\(period\.periodStart, period\.periodEnd\)/)
assert.match(exportSource, /!rangeState\.complete/)
assert.match(exportSource, /resolverResult\.mode !== 'EMPLOYEE_ID' \|\| !resolverResult\.calculationReady/)
assert.doesNotMatch(exportSource, /employeeDailyPayDetail|monthlyPayrollFromEntries|calcDailyPay/)
console.log('  [D] 跨月缓存完整性 + 无前端工资公式 PASS')

console.log('GATE 25 EXPORT SALARY IDENTITY TEST OK')
