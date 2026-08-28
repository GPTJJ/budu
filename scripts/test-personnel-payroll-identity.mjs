// Gate 29F：Personnel 日/周工资以 Employee.id + date + store 为唯一稳定身份。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { seedCachedDataForTest } = await import(path.join(root, 'src/utils/userData.js').replaceAll('\\', '/'))
const {
  employeeDailyPayDetail,
  employeeDayStatus,
  employeeWeekStatus,
  legacyAmbiguousEmployeeNames,
  payrollPeriodMonths,
} = await import(path.join(root, 'src/utils/selectors.js').replaceAll('\\', '/'))
const { resolvePayrollCalculation } = await import(path.join(root, 'src/utils/payrollResolver.js').replaceAll('\\', '/'))

const stores = [
  { key: 'tongying', name: '北京通盈中心店' },
  { key: 'guanshe', name: '北京官舍店' },
  { key: 'xidan', name: '北京西单店' },
]
const employees = [
  { id: 'emp-A', name: '张伟', storeKey: 'tongying', type: 'fulltime' },
  { id: 'emp-B', name: '张伟', storeKey: 'tongying', type: 'parttime' },
]
const entries = { '2026-08|tongying|08-10': { inc: 2050, ord: 20, staff: ['张伟', '张伟'] } }
const attendance = [
  { id: 'att-A', storeId: 'tongying', storeKey: 'tongying', date: '2026-08-10', employeeId: 'emp-A', staffNameSnapshot: '张伟', actualHours: 8 },
  { id: 'att-B', storeId: 'tongying', storeKey: 'tongying', date: '2026-08-10', employeeId: 'emp-B', staffNameSnapshot: '张伟', actualHours: 6 },
]

function seed(overrides = {}) {
  seedCachedDataForTest({
    entries: overrides.entries ?? entries,
    staff: overrides.staff ?? employees,
    dailyPayAdjustments: overrides.dailyPayAdjustments ?? [],
    bigBonuses: overrides.bigBonuses ?? [],
    dailyStoreStaffByMonth: overrides.dailyStoreStaffByMonth ?? {},
    removedStaff: [], stores, schedules: {}, products: [], inventoryRequests: [], inventory: [],
    analysis: {}, productImages: {}, posDaily: [], posProductSales: [],
  })
}

// A/B/F：同店同名按 Employee.id + actualHours 独立；周汇总复用精确日结果。
seed()
const dayA = employeeDayStatus('2026-08', '08-10', '张伟', 'emp-A', attendance)
const dayB = employeeDayStatus('2026-08', '08-10', '张伟', 'emp-B', attendance)
assert.deepEqual([dayA.hours, dayA.basePay, dayA.commission, dayA.pay], [8, 224, 40, 264])
assert.deepEqual([dayB.hours, dayB.basePay, dayB.commission, dayB.pay], [6, 168, 30, 198])
const weekDates = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16']
const weekA = employeeWeekStatus('2026-08', weekDates, '张伟', 'emp-A', attendance)
const weekB = employeeWeekStatus('2026-08', weekDates, '张伟', 'emp-B', attendance)
assert.deepEqual([weekA.hours, weekA.pay], [8, 264])
assert.deepEqual([weekB.hours, weekB.pay], [6, 198])
console.log('  [A/B/F] 同名 A=8h/264，B=6h/198，日/周无交叉 PASS')

// C：调整只按 employeeId；B 不因同名收到 A 的调整。
seed({
  dailyPayAdjustments: [
    { id: 'adj-A', employeeId: 'emp-A', staffName: '张伟', date: '2026-08-10', autoPayCentsSnapshot: 26400, adjustedPayCents: 30000, reason: 'A 独有调整' },
  ],
})
const adjustedA = employeeDayStatus('2026-08', '08-10', '张伟', 'emp-A', attendance)
const unadjustedB = employeeDayStatus('2026-08', '08-10', '张伟', 'emp-B', attendance)
assert.equal(adjustedA.pay, 300)
assert.equal(adjustedA.payAdjustment.employeeId, 'emp-A')
assert.equal(unadjustedB.pay, 198)
assert.equal(unadjustedB.payAdjustment, null)
console.log('  [C] 同名调整仅归 emp-A，emp-B 保持 198 PASS')

// D/16A/17：手工大单奖是合法权威输入，不要求 POS/orderId；仍只归精确 Employee.id。
seed({
  bigBonuses: [
    { id: 'bonus-A', employeeId: 'emp-A', staffKey: 'tongying::张伟', staffName: '张伟', storeKey: 'tongying', date: '2026-08-10', amountCents: 200000, bonusCents: 10000 },
  ],
})
const bonusA = employeeDayStatus('2026-08', '08-10', '张伟', 'emp-A', attendance)
const bonusB = employeeDayStatus('2026-08', '08-10', '张伟', 'emp-B', attendance)
assert.equal(bonusA.bigBonus, 100)
assert.equal(bonusA.pay, 364)
assert.equal(bonusB.bigBonus, 0)
assert.equal(bonusB.pay, 198)
console.log('  [D] 无 POS/orderId 的手工大单奖仅归 emp-A PASS')

// E：调整仅日恰好一次，不虚构考勤、门店、工时或营业额。
seed({
  entries: {},
  dailyPayAdjustments: [
    { id: 'adj-C', employeeId: 'emp-C', staffName: '王五', date: '2026-08-12', autoPayCentsSnapshot: 0, adjustedPayCents: 50000, reason: '仅调整日' },
  ],
})
const adjustmentOnlyDay = employeeDayStatus('2026-08', '08-12', '王五', 'emp-C', [])
const adjustmentOnlyWeek = employeeWeekStatus('2026-08', weekDates, '王五', 'emp-C', [])
assert.deepEqual(
  [adjustmentOnlyDay.hours, adjustmentOnlyDay.inc, adjustmentOnlyDay.stores.length, adjustmentOnlyDay.automaticPay, adjustmentOnlyDay.pay],
  [0, 0, 0, 0, 500],
)
assert.deepEqual([adjustmentOnlyWeek.workedDays, adjustmentOnlyWeek.hours, adjustmentOnlyWeek.pay], [0, 0, 500])
assert.equal(adjustmentOnlyWeek.adjustmentOnly, true)
console.log('  [E] 调整仅日：日/周 500，0 考勤/工时/营业额，且只计一次 PASS')

// G：跨月周显式需要两个月；合并后的稳定考勤没有缺日或重复。
const boundaryEntries = {
  '2026-08|tongying|08-31': { inc: 2050, ord: 20, staff: ['张伟'] },
  '2026-09|tongying|09-01': { inc: 2050, ord: 20, staff: ['张伟'] },
}
const boundaryAttendance = [
  { id: 'a-aug', storeId: 'tongying', storeKey: 'tongying', date: '2026-08-31', employeeId: 'emp-A', staffNameSnapshot: '张伟', actualHours: 8 },
  { id: 'a-sep', storeId: 'tongying', storeKey: 'tongying', date: '2026-09-01', employeeId: 'emp-A', staffNameSnapshot: '张伟', actualHours: 8 },
]
seed({ entries: boundaryEntries })
const boundaryDates = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06']
assert.deepEqual(payrollPeriodMonths(boundaryDates), ['2026-08', '2026-09'])
const boundaryWeek = employeeWeekStatus('2026-08', boundaryDates, '张伟', 'emp-A', boundaryAttendance)
assert.deepEqual([boundaryWeek.workedDays, boundaryWeek.hours, boundaryWeek.pay], [2, 16, 560])
console.log('  [G] 8.31–9.6 跨月周加载 08/09，2 天/16h/560，无遗漏无重复 PASS')

// H/I：历史门店与历史姓名快照不控制身份；当前员工改名/调店后仍读取原日事实。
const historicalEntries = {
  '2026-08|guanshe|08-12': { inc: 0, ord: 0, staff: ['旧名'] },
  '2026-09|xidan|09-02': { inc: 0, ord: 0, staff: ['新名'] },
}
const historicalAttendance = [
  { id: 'h-old', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-12', employeeId: 'emp-T', staffNameSnapshot: '旧名', actualHours: 7 },
  { id: 'h-new', storeId: 'xidan', storeKey: 'xidan', date: '2026-09-02', employeeId: 'emp-T', staffNameSnapshot: '新名', actualHours: 8 },
]
seed({ entries: historicalEntries, staff: [{ id: 'emp-T', name: '新名', storeKey: 'xidan', type: 'fulltime' }] })
const oldDay = employeeDailyPayDetail('2026-08', '08-12', '新名', 'emp-T', historicalAttendance)
const newDay = employeeDailyPayDetail('2026-09', '09-02', '新名', 'emp-T', historicalAttendance)
assert.deepEqual(oldDay.rows.map((row) => row.storeKey), ['guanshe'])
assert.deepEqual(newDay.rows.map((row) => row.storeKey), ['xidan'])
assert.equal(oldDay.totals.hours, 7)
assert.equal(newDay.totals.hours, 8)
console.log('  [H/I] Employee.id 改名/调店连续，历史日使用当日门店与工时 PASS')

// Real zero：稳定 0h 不得回退为默认班次。
seed({ entries: { '2026-08|tongying|08-11': { inc: 2050, ord: 20, staff: ['零工时'] } }, staff: [{ id: 'emp-Z', name: '零工时', storeKey: 'tongying' }] })
const zero = employeeDayStatus('2026-08', '08-11', '零工时', 'emp-Z', [
  { id: 'z', storeId: 'tongying', storeKey: 'tongying', date: '2026-08-11', employeeId: 'emp-Z', staffNameSnapshot: '零工时', actualHours: 0 },
])
assert.deepEqual([zero.hours, zero.basePay, zero.commission, zero.pay], [0, 0, 0, 0])
console.log('  [Real zero] actualHours=0 保持真实 0，不回退默认班次 PASS')

// K/L：Legacy 唯一名兼容；重名由明确 ambiguity gate 阻断，绝不猜钱。
seed({ entries: { '2026-08|tongying|08-10': { inc: 2050, ord: 20, staff: ['唯一名'] } } })
assert.equal(employeeDayStatus('2026-08', '08-10', '唯一名').pay, 420)
assert.equal(legacyAmbiguousEmployeeNames([{ name: '张伟' }, { name: '张伟' }]).has('张伟'), true)
assert.equal(legacyAmbiguousEmployeeNames([{ name: '唯一名' }]).has('唯一名'), false)
console.log('  [K/L] Legacy 唯一名兼容；重名明确 ambiguous、不猜金额 PASS')

// 月 / 日 / 周 / Export / Issue 共用稳定 resolver 口径，对受控 fixture 逐项对账。
const reconcileBonuses = [{ id: 'r-b', employeeId: 'emp-A', staffKey: 'tongying::张伟', storeKey: 'tongying', date: '2026-08-10', amountCents: 200000, bonusCents: 1000 }]
const reconcileAdjustments = [{ id: 'r-a', employeeId: 'emp-B', staffName: '张伟', date: '2026-08-10', autoPayCentsSnapshot: 19800, adjustedPayCents: 25000, reason: '对账' }]
seed({ bigBonuses: reconcileBonuses, dailyPayAdjustments: reconcileAdjustments })
const resolved = resolvePayrollCalculation({
  month: '2026-08', dailyEntries: entries, dailyStoreStaffRows: attendance,
  dailyPayAdjustments: reconcileAdjustments, bigOrderBonuses: reconcileBonuses,
  employees, users: [],
})
assert.equal(resolved.mode, 'EMPLOYEE_ID')
for (const employee of employees) {
  const daily = employeeDayStatus('2026-08', '08-10', employee.name, employee.id, attendance)
  const weekly = employeeWeekStatus('2026-08', weekDates, employee.name, employee.id, attendance)
  const monthly = resolved.payroll.employees.find((row) => row.employeeId === employee.id)
  assert.ok(monthly)
  assert.deepEqual(
    [daily.hours, daily.basePay, daily.commission, daily.transferSubsidy, daily.bigBonus, daily.salaryAdjustment, daily.pay],
    [monthly.payableHours, monthly.basePay, monthly.commission, monthly.transferSubsidy, monthly.bigBonus, monthly.salaryAdjustment, monthly.salary],
  )
  assert.deepEqual(
    [weekly.hours, weekly.basePay, weekly.commission, weekly.transferSubsidy, weekly.bigBonus, weekly.salaryAdjustment, weekly.pay],
    [monthly.payableHours, monthly.basePay, monthly.commission, monthly.transferSubsidy, monthly.bigBonus, monthly.salaryAdjustment, monthly.salary],
  )
}
console.log('  [Reconcile] Personnel 日/周 = 月 resolver = Export/Issue 稳定金额合同 PASS')

// Gate29E 回归：展示姓名不产生工资权威。
seed({ entries: { '2026-08|tongying|08-10': { inc: 2050, ord: 20, staff: ['卡皮巴拉'] } }, staff: [{ id: 'emp-M', name: '卡皮巴拉', storeKey: 'tongying' }] })
const mascot = employeeDayStatus('2026-08', '08-10', '卡皮巴拉', 'emp-M', [
  { id: 'm', storeId: 'tongying', storeKey: 'tongying', date: '2026-08-10', employeeId: 'emp-M', staffNameSnapshot: '卡皮巴拉', actualHours: 8 },
])
assert.equal(mascot.pay, 280)

// J：实际组件使用递增请求序号丢弃迟到期间响应；员工切换本身不绑定异步结果。
const personnelSource = fs.readFileSync(path.join(root, 'src/components/PersonnelPage.jsx'), 'utf8')
assert.match(personnelSource, /periodRequestRef\.current !== requestId/)
assert.match(personnelSource, /loadDailyStoreStaffRange\(period\.periodStart, period\.periodEnd\)/)
assert.match(personnelSource, /resolvePayrollCalculation\(\{\s*\.\.\.period,/)
assert.match(personnelSource, /periodAttendance\.byEmployeeId\.get\(emp\.id\)/)
assert.doesNotMatch(personnelSource, /employeeDayStatus\(/)
assert.doesNotMatch(personnelSource, /employeeWeekStatus\(/)
console.log('  [J] 日期/周同一 range resolver + 请求序号防迟到覆盖 + Employee.id 渲染绑定 PASS')

console.log('GATE 29F PERSONNEL PAYROLL IDENTITY TEST OK')
