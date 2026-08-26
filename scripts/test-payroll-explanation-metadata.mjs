// Gate 29I：LIVE/UNISSUED Employee.id 工资解释元数据；金额、主体、历史快照全部冻结。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { calcDailyPay, PAYABLE_HOURS_SOURCE } = await import(path.join(root, 'src/utils/payroll.js').replaceAll('\\', '/'))
const { calculateEmployeeIdShadowPayroll } = await import(path.join(root, 'src/utils/payrollShadowCalculator.js').replaceAll('\\', '/'))
const { resolvePayrollCalculation } = await import(path.join(root, 'src/utils/payrollResolver.js').replaceAll('\\', '/'))
const { employeeDailyPayDetail } = await import(path.join(root, 'src/utils/selectors.js').replaceAll('\\', '/'))
const { buildIssueSnapshot } = await import(path.join(root, 'src/utils/payrollIssue.js').replaceAll('\\', '/'))
const { seedCachedDataForTest } = await import(path.join(root, 'src/utils/userData.js').replaceAll('\\', '/'))

const attendance = (employeeId, name, storeId, date, actualHours) => ({
  id: `att-${employeeId}-${storeId}-${date}`,
  employeeId,
  staffId: `staff-${employeeId}`,
  staffNameSnapshot: name,
  storeId,
  storeKey: storeId,
  date,
  actualHours,
})

const bonus = (id, employeeId, date, amountCents, bonusCents, receipt = '', storeKey = 'tongying') => ({
  id,
  employeeId,
  staffKey: `${storeKey}::张伟`,
  staffName: '张伟',
  storeKey,
  date,
  amountCents,
  bonusCents,
  receipt,
  createdBy: 'must-not-leak',
  createdAt: '2026-08-10T12:00:00.000Z',
})

const adjustment = (employeeId, date, adjustedPayCents, reason, autoPayCentsSnapshot = 0) => ({
  id: `adj-${employeeId}-${date}`,
  employeeId,
  staffName: '张伟',
  date,
  autoPayCentsSnapshot,
  adjustedPayCents,
  reason,
  active: true,
  createdBy: 'must-not-leak',
  version: 9,
})

const moneyFields = (row) => ({
  hours: row.hours,
  baseRate: row.baseRate,
  basePay: row.basePay,
  commissionRate: row.commissionRate,
  commission: row.commission,
  transferSubsidyRate: row.transferSubsidyRate,
  transferSubsidy: row.transferSubsidy,
  total: row.total,
})

// 1. calcDailyPay 自包含解释复用同一变量；用户场景金额冻结。
{
  const result = calcDailyPay({
    storeKey: 'tongying', revenue: 2050, date: '2026-08-10', staffCount: 1,
    payableHours: 8, payableHoursSource: PAYABLE_HOURS_SOURCE.ACTUAL_HOURS,
  })
  assert.deepEqual(moneyFields(result), {
    hours: 8, baseRate: 30, basePay: 240, commissionRate: 5, commission: 40,
    transferSubsidyRate: 0, transferSubsidy: 0, total: 280,
  })
  assert.deepEqual(result.explanation, {
    payableHours: 8,
    payableHoursSource: 'ACTUAL_HOURS',
    participantCount: 1,
    rawStoreRevenue: 2050,
    commissionBasis: 2050,
    calculationDayPolicy: 'WORKDAY_POLICY',
    baseRate: 30,
    basePay: 240,
    commissionTarget: 2000,
    commissionRate: 5,
    commission: 40,
    transferSubsidyRate: 0,
    transferSubsidy: 0,
    total: 280,
  })
  for (const key of ['baseRate', 'basePay', 'commissionRate', 'commission', 'transferSubsidyRate', 'transferSubsidy', 'total']) {
    assert.equal(result.explanation[key], result[key], `${key} 必须复用权威计算值`)
  }
  console.log('  [用户场景] 金额冻结 + 自包含解释 PASS')
}

// 2. 同店同名两人：人数来自稳定考勤行数，解释按 Employee.id 隔离。
{
  const entries = { '2026-08|tongying|08-10': { inc: 2050, ord: 20, staff: ['张伟', '张伟'] } }
  const rows = [
    attendance('emp-A', '张伟', 'tongying', '2026-08-10', 8),
    attendance('emp-B', '张伟', 'tongying', '2026-08-10', 6),
  ]
  const out = calculateEmployeeIdShadowPayroll(entries, rows, [], [], '2026-08', { tongying: '北京通盈中心店' })
  const a = out.employees.find((row) => row.employeeId === 'emp-A')
  const b = out.employees.find((row) => row.employeeId === 'emp-B')
  assert.deepEqual({ basePay: a.basePay, commission: a.commission, salary: a.salary }, { basePay: 224, commission: 40, salary: 264 })
  assert.deepEqual({ basePay: b.basePay, commission: b.commission, salary: b.salary }, { basePay: 168, commission: 30, salary: 198 })
  for (const [rec, hours, display] of [[a, 8, 1025], [b, 6, 1025]]) {
    assert.equal(rec.dailyExplanations.length, 1)
    const day = rec.dailyExplanations[0]
    assert.equal(day.employeeId, rec.employeeId)
    assert.equal(day.storeName, '北京通盈中心店')
    assert.equal(day.explanation.payableHours, hours)
    assert.equal(day.explanation.participantCount, 2)
    assert.equal(day.explanation.rawStoreRevenue, 2050)
    assert.equal(day.explanation.displayWorkedRevenue, display)
    assert.equal(day.explanation.commissionBasis, 2050)
  }
  console.log('  [双员工] 8h/6h + participantCount=2 + 无交叉 PASS')
}

// 3. 日期政策只描述实际工资分支；官舍补贴元数据与金额一致。
{
  const holiday = calcDailyPay({ storeKey: 'tongying', revenue: 4800, date: '2026-08-09', staffCount: 1, payableHours: 8 })
  assert.deepEqual(
    { target: holiday.explanation.commissionTarget, policy: holiday.explanation.calculationDayPolicy, commission: holiday.commission, total: holiday.total },
    { target: 5000, policy: 'HOLIDAY_POLICY', commission: 0, total: 240 },
  )
  const guanshe = calcDailyPay({ storeKey: 'guanshe', revenue: 0, date: '2026-08-10', staffCount: 1, payableHours: 7 })
  assert.deepEqual(
    { rate: guanshe.explanation.transferSubsidyRate, subsidy: guanshe.explanation.transferSubsidy, total: guanshe.total },
    { rate: 2, subsidy: 14, total: 224 },
  )
  console.log('  [政策] 通盈节假日目标 + 官舍补贴 PASS')
}

// 4. 多笔人工大单奖保持逐笔；调整快照不替代当前自动工资。
{
  const entries = { '2026-08|tongying|08-10': { inc: 2050, ord: 20, staff: ['张伟'] } }
  const rows = [attendance('emp-A', '张伟', 'tongying', '2026-08-10', 8)]
  const bonuses = [
    bonus('bb-1', 'emp-A', '2026-08-10', 100000, 5000, 'receipt.jpg'),
    bonus('bb-2', 'emp-A', '2026-08-10', 200000, 10000, ''),
  ]
  const adjustments = [adjustment('emp-A', '2026-08-10', 50000, '经理确认 500', 25000)]
  const rec = calculateEmployeeIdShadowPayroll(entries, rows, bonuses, adjustments, '2026-08').employees[0]
  assert.deepEqual(
    { basePay: rec.basePay, commission: rec.commission, bigBonus: rec.bigBonus, salaryAdjustment: rec.salaryAdjustment, salary: rec.salary },
    { basePay: 240, commission: 40, bigBonus: 150, salaryAdjustment: 70, salary: 500 },
  )
  const explanation = rec.dailyExplanations[0].explanation
  assert.deepEqual(explanation.bigOrderBonuses, [
    { orderAmount: 1000, bonusAmount: 50, receiptPresent: true },
    { orderAmount: 2000, bonusAmount: 100, receiptPresent: false },
  ])
  assert.deepEqual(explanation.adjustment, {
    automaticPay: 430,
    autoPaySnapshot: 250,
    salaryAdjustment: 70,
    finalPay: 500,
    reason: '经理确认 500',
  })
  assert.equal(JSON.stringify(explanation).includes('must-not-leak'), false)
  assert.equal(Object.hasOwn(explanation.bigOrderBonuses[0], 'sourceType'), false)
  assert.equal(Object.hasOwn(explanation.bigOrderBonuses[0], 'orderId'), false)
  console.log('  [奖金/调整] 人工多笔权威 + 当前自动工资/历史快照分离 PASS')
}

// 5. 调整独占日不虚构考勤/门店/收入；真实 0h 不回退。
{
  const adjusted = calculateEmployeeIdShadowPayroll({}, [], [], [adjustment('emp-A', '2026-08-12', 50000, '仅调整')], '2026-08').employees[0]
  const day = adjusted.dailyExplanations[0]
  assert.deepEqual(
    { state: day.explanation.state, source: day.explanation.payableHoursSource, hours: day.hours, storeKey: day.storeKey, revenue: day.explanation.rawStoreRevenue, automaticPay: day.automaticPay, delta: day.salaryAdjustment, finalPay: day.finalPay },
    { state: 'ADJUSTMENT_ONLY', source: 'ADJUSTMENT_ONLY', hours: 0, storeKey: null, revenue: null, automaticPay: 0, delta: 500, finalPay: 500 },
  )
  const zero = calculateEmployeeIdShadowPayroll(
    { '2026-08|tongying|08-10': { inc: 2050, ord: 20, staff: ['张伟'] } },
    [attendance('emp-A', '张伟', 'tongying', '2026-08-10', 0)], [], [], '2026-08',
  ).employees[0].dailyExplanations[0]
  assert.equal(zero.explanation.state, 'REAL_ZERO')
  assert.equal(zero.explanation.payableHours, 0)
  assert.equal(zero.explanation.payableHoursSource, 'ACTUAL_HOURS')
  assert.equal(zero.finalPay, 0)
  console.log('  [状态] ADJUSTMENT_ONLY / REAL_ZERO / 无伪造数据 PASS')
}

// 6. 奖金独占仍不产生 payroll subject；无数据不制造日解释。
{
  const bonuses = [bonus('bb-only', 'emp-A', '2026-08-10', 100000, 5000)]
  const result = resolvePayrollCalculation({
    month: '2026-08', dailyEntries: {}, dailyStoreStaffRows: [], dailyPayAdjustments: [],
    bigOrderBonuses: bonuses, employees: [{ id: 'emp-A', name: '张伟' }], users: [],
  })
  assert.equal(result.calculationReady, false)
  assert.equal(result.payroll.employees.length, 0)
  assert.equal(result.readiness.calculationBlockers.some((item) => item.reason === 'NO_PAYROLL_SUBJECTS'), true)
  const empty = calculateEmployeeIdShadowPayroll({}, [], [], [], '2026-08')
  assert.equal(empty.employees.length, 0)
  console.log('  [无主体] BONUS_ONLY_UNSUPPORTED / NO_DATA 不造行 PASS')
}

// 7. 同名身份元数据隔离；resolver 暴露日解释但不伪造月费率。
{
  const entries = { '2026-08|tongying|08-10': { inc: 2050, ord: 20, staff: ['张伟', '张伟'] } }
  const rows = [attendance('emp-A', '张伟', 'tongying', '2026-08-10', 8), attendance('emp-B', '张伟', 'tongying', '2026-08-10', 6)]
  const result = resolvePayrollCalculation({
    month: '2026-08', dailyEntries: entries, dailyStoreStaffRows: rows,
    dailyPayAdjustments: [adjustment('emp-A', '2026-08-10', 50000, '仅 A')],
    bigOrderBonuses: [bonus('bb-A', 'emp-A', '2026-08-10', 100000, 5000)],
    employees: [{ id: 'emp-A', name: '张伟' }, { id: 'emp-B', name: '张伟' }], users: [],
    storeNames: { tongying: '北京通盈中心店' },
  })
  assert.equal(result.mode, 'EMPLOYEE_ID')
  const a = result.payroll.employees.find((row) => row.employeeId === 'emp-A')
  const b = result.payroll.employees.find((row) => row.employeeId === 'emp-B')
  assert.equal(a.dailyExplanations[0].explanation.bigOrderBonuses.length, 1)
  assert.equal(a.dailyExplanations[0].explanation.adjustment.reason, '仅 A')
  assert.equal(b.dailyExplanations[0].explanation.bigOrderBonuses.length, 0)
  assert.equal(b.dailyExplanations[0].explanation.adjustment, null)
  for (const key of ['baseRate', 'commissionRate', 'commissionTarget', 'participantCount']) {
    assert.equal(Object.hasOwn(a, key), false, `月汇总不得伪造 ${key}`)
  }
  console.log('  [Resolver] Employee.id 元数据隔离 + 无月费率 PASS')
}

// 8. selector 的稳定日行复用同一个 calc 结果；历史 PayrollNotice 既有快照形状不扩张。
{
  const entries = { '2026-08|tongying|08-10': { inc: 2050, ord: 20, staff: ['张伟'] } }
  const rows = [attendance('emp-A', '张伟', 'tongying', '2026-08-10', 8)]
  seedCachedDataForTest({
    entries,
    staff: [{ id: 'emp-A', name: '张伟', storeKey: 'tongying', type: 'fulltime' }],
    dailyPayAdjustments: [], bigBonuses: [], removedStaff: [],
    stores: [{ key: 'tongying', name: '北京通盈中心店' }], schedules: {}, products: [],
    inventoryRequests: [], inventory: [], analysis: {}, productImages: {}, posDaily: [], posProductSales: [],
  })
  const detail = employeeDailyPayDetail('2026-08', '08-10', '张伟', 'emp-A', rows)
  const row = detail.rows[0]
  assert.equal(row.explanation.payableHours, row.hours)
  assert.equal(row.explanation.baseRate, row.baseRate)
  assert.equal(row.explanation.basePay, row.basePay)
  assert.equal(row.explanation.commissionRate, row.commissionRate)
  assert.equal(row.explanation.commission, row.commission)
  assert.equal(row.explanation.transferSubsidyRate, row.transferSubsidyRate)
  assert.equal(row.explanation.transferSubsidy, row.transferSubsidy)

  const rec = calculateEmployeeIdShadowPayroll(entries, rows, [], [], '2026-08').employees[0]
  const snapshot = buildIssueSnapshot(rec, { month: '2026-08', name: '张伟', attendanceRows: rows })
  assert.deepEqual(Object.keys(snapshot).sort(), ['days', 'summary'])
  assert.deepEqual(Object.keys(snapshot.summary).sort(), ['adjustment', 'basePay', 'bigBonus', 'commission', 'hours', 'revenue', 'total', 'transferSubsidy', 'workedDays'])
  assert.equal(snapshot.days.some((day) => Object.hasOwn(day, 'explanation')), false)
  assert.deepEqual(snapshot.summary, {
    workedDays: 1, hours: 8, revenue: 2050, basePay: 240, commission: 40,
    transferSubsidy: 0, bigBonus: 0, adjustment: 0, total: 280,
  })
  console.log('  [Selector/历史] 字段一致 + PayrollNotice 形状与金额冻结 PASS')
}

// 9. Legacy 可继续计算，但只声明 LEGACY_DUTY_HOURS，不伪装稳定 Employee.id 日解释。
{
  const legacy = calcDailyPay({ storeKey: 'tongying', revenue: 2050, date: '2026-08-10', staffCount: 1 })
  assert.equal(legacy.total, 420)
  assert.equal(legacy.explanation.payableHoursSource, 'LEGACY_DUTY_HOURS')
  const result = resolvePayrollCalculation({ month: '2026-08', dailyEntries: {}, dailyStoreStaffRows: [], dailyPayAdjustments: [], bigOrderBonuses: [], employees: [], users: [] })
  assert.equal(result.mode, 'LEGACY')
  assert.equal(result.payroll.employees.length, 0)
  console.log('  [Legacy] 兼容金额保留 / 无稳定级伪解释 PASS')
}

console.log('GATE 29I AUTHORITATIVE EXPLANATION METADATA TEST OK')
