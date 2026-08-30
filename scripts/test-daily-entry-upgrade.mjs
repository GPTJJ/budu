import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDailySchedulePrefill, dateOnly, effectiveSource, hoursFromTimes } from '../server/daily-entry-upgrade.js'

test('实际工时按上下班时间与休息分钟计算', () => {
  assert.equal(hoursFromTimes('10:00', '18:00', 0), 8)
  assert.equal(hoursFromTimes('10:00', '18:00', 60), 7)
  assert.equal(hoursFromTimes('22:00', '02:00', 0), 4)
  assert.equal(hoursFromTimes('09:30', '12:00', 30), 2)
  assert.equal(hoursFromTimes('', '18:00', 0), 0)
  assert.equal(hoursFromTimes('10:00', '18:00', 999), 0)
})

test('销售数据来源按生效日期区分历史与试点', () => {
  const manual = { salesDataSource: 'manual', salesDataSourceEffectiveDate: null }
  assert.equal(effectiveSource(manual, '2026-08-11'), 'manual')
  const pos = { salesDataSource: 'pos', salesDataSourceEffectiveDate: new Date('2026-08-01T00:00:00.000Z') }
  assert.equal(effectiveSource(pos, '2026-07-31'), 'manual')
  assert.equal(effectiveSource(pos, '2026-08-01'), 'pos')
  assert.equal(effectiveSource(pos, '2026-08-11'), 'pos')
  const noEff = { salesDataSource: 'hybrid', salesDataSourceEffectiveDate: null }
  assert.equal(effectiveSource(noEff, '2026-08-11'), 'hybrid')
})

test('日期工具校验', () => {
  assert.equal(dateOnly('2026-08-11').toISOString(), '2026-08-11T00:00:00.000Z')
  assert.throws(() => dateOnly('2026/08/11'), /YYYY-MM-DD/)
  assert.throws(() => dateOnly(''), /YYYY-MM-DD/)
})

test('排班预填只认 Employee.id，legacy 姓名不猜测', () => {
  const result = buildDailySchedulePrefill([
    { employeeId: 'emp-A', staff: '同名员工', time: '10:00-18:00' },
    { employeeId: 'emp-A', staff: '重复班次', time: '18:00-22:00' },
    { employeeId: 'emp-missing', staff: '已离职快照', time: '早班' },
    { staff: '同名员工', time: '晚班' },
  ], [
    { id: 'emp-A', name: '同名员工' },
    { id: 'emp-B', name: '同名员工' },
  ])
  assert.deepEqual(result.scheduledEmployeeIds, ['emp-A'])
  assert.deepEqual(result.unresolved.map((row) => row.reason), ['EMPLOYEE_UNAVAILABLE', 'MISSING_EMPLOYEE_ID'])
  assert.equal(result.scheduledEmployeeIds.includes('emp-B'), false, '不得用 staff 快照将 legacy 行猜成同名 emp-B')
})
