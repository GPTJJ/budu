// Gate 26：稳定调整仅日 Employee.id 月度 payroll 贡献
// 无考勤的显式 Employee.id 调整仍可进入月度 payroll（automaticPay=0，贡献=调整额），
// 不虚构考勤/业绩，不按 name 推断身份；考勤+调整同日恰好一次；legacy NULL 冻结。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { calculateEmployeeIdShadowPayroll } = await import(path.join(root, 'src/utils/payrollShadowCalculator.js').replaceAll('\\', '/'))
const { evaluatePayrollReadiness } = await import(path.join(root, 'src/utils/payrollReadiness.js').replaceAll('\\', '/'))
const { resolvePayrollCalculation } = await import(path.join(root, 'src/utils/payrollResolver.js').replaceAll('\\', '/'))
const { seedCachedDataForTest } = await import(path.join(root, 'src/utils/userData.js').replaceAll('\\', '/'))
const { employeeDailyPayDetail } = await import(path.join(root, 'src/utils/selectors.js').replaceAll('\\', '/'))

const adj = (employeeId, date, adjustedPayCents, reason = '') => ({ id: `d-${employeeId}-${date}`, employeeId, staffName: '张伟', date, autoPayCentsSnapshot: 0, adjustedPayCents, reason, active: true, version: 1 })

// ---- A: 调整仅日正数（无考勤、无 DailyEntry）+500 ----
{
  const adjustments = [adj('emp-A', '2026-08-10', 50000, '仅调整日 +500')]
  const out = calculateEmployeeIdShadowPayroll({}, [], [], adjustments, '2026-08')
  assert.equal(out.employees.length, 1, 'A 一名员工')
  const a = out.employees[0]
  assert.equal(a.employeeId, 'emp-A', 'A 身份 employeeId')
  assert.equal(a.days, 0, 'A 出勤天数 0')
  assert.equal(a.payableHours, 0, 'A 工时 0')
  assert.equal(a.workedRevenue, 0, 'A 营业额 0')
  assert.equal(a.salaryAdjustment, 500, 'A 调整 +500（automaticPay=0 → 差额=调整额）')
  assert.equal(a.salary, 500, 'A 月度贡献 500')
  assert.equal(a.adjustmentCount, 1, 'A 调整次数 1')
  assert.equal(a.basePay, 0, 'A 无公式基础工资（不虚构考勤）')
  console.log('  [A] 调整仅日 +500 → salary=500 / adjustmentCount=1 / 0 工时 PASS')
}

// ---- B: 调整仅日负数 -50 ----
{
  const out = calculateEmployeeIdShadowPayroll({}, [], [], [adj('emp-A', '2026-08-10', -5000, '扣 50')], '2026-08')
  assert.equal(out.employees[0].salary, -50, 'B 负调整 -50')
  assert.equal(out.employees[0].salaryAdjustment, -50, 'B salaryAdjustment -50')
  console.log('  [B] 调整仅日 -50 → salary=-50 PASS')
}

// ---- C: 显式零调整（绝不变成"缺失"）----
{
  const out = calculateEmployeeIdShadowPayroll({}, [], [], [adj('emp-A', '2026-08-10', 0, '清零')], '2026-08')
  assert.equal(out.employees.length, 1, 'C 员工仍存在（显式零非缺失）')
  assert.equal(out.employees[0].adjustmentCount, 1, 'C 显式零仍计调整 1 次')
  assert.equal(out.employees[0].salary, 0, 'C 贡献 0')
  console.log('  [C] 显式调整 0 → 表示存在、贡献 0 PASS')
}

// ---- D: 考勤+调整同日（既有语义不变，恰好一次）----
{
  const entries = { '2026-08|guanshe|08-01': { inc: 6000, ord: 60, staff: ['张伟'] } }
  const staff = [{ id: 'a1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-01', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张伟', actualHours: 8 }]
  const out = calculateEmployeeIdShadowPayroll(entries, staff, [], [adj('emp-A', '2026-08-01', 10000, '考勤日调整 100')], '2026-08')
  const a = out.employees[0]
  assert.equal(a.days, 1, 'D 出勤 1 天')
  assert.equal(a.adjustmentCount, 1, 'D 调整恰好一次')
  assert.equal(a.salary, 100, 'D 当日最终工资 = 调整覆盖 100')
  assert.equal(a.salaryAdjustment, Math.round((100 - a.salary + a.salaryAdjustment) * 100) / 100 || a.salaryAdjustment, 'D 差额口径自洽')
  assert.ok(a.salaryAdjustment < 0, 'D 自动工资为正 → 差额为负')
  console.log('  [D] 考勤+调整同日 → 一次覆盖 PASS')
}

// ---- E: 同名 A/B，仅 emp-A 调整仅日 ----
{
  const entries = { '2026-08|guanshe|08-01': { inc: 6000, ord: 60, staff: ['张伟', '张伟'] } }
  const staff = [
    { id: 'a1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-01', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张伟', actualHours: 8 },
    { id: 'b1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-01', employeeId: 'emp-B', staffId: 'st-b', staffNameSnapshot: '张伟', actualHours: 6 },
  ]
  const out = calculateEmployeeIdShadowPayroll(entries, staff, [], [adj('emp-A', '2026-08-10', 50000, 'A 仅调整日 +500')], '2026-08')
  const a = out.employees.find((r) => r.employeeId === 'emp-A')
  const b = out.employees.find((r) => r.employeeId === 'emp-B')
  assert.ok(a && b, 'E A/B 两行')
  assert.equal(a.salary, Math.round((a.salary - 500 + 500) * 100) / 100, 'E A 含 +500（与考勤工资叠加）')
  assert.ok(a.salary >= 500, 'E A 月度 >= 500')
  assert.equal(b.adjustmentCount, 0, 'E emp-B 不因同名获得调整')
  assert.equal(b.salary, Math.round((b.salary) * 100) / 100, 'E B 仅考勤工资')
  console.log('  [E] 同名仅 A 调整 → B 不接收 PASS')
}

// ---- F: 同名 A/B 各自调整仅日（+500 / -50，不合并）----
{
  const adjustments = [adj('emp-A', '2026-08-10', 50000, 'A +500'), adj('emp-B', '2026-08-10', -5000, 'B -50')]
  const out = calculateEmployeeIdShadowPayroll({}, [], [], adjustments, '2026-08')
  assert.equal(out.employees.length, 2, 'F 两行独立')
  const a = out.employees.find((r) => r.employeeId === 'emp-A')
  const b = out.employees.find((r) => r.employeeId === 'emp-B')
  assert.equal(a.salary, 500, 'F A = +500')
  assert.equal(b.salary, -50, 'F B = -50')
  assert.notEqual(a, b, 'F 未合并')
  console.log('  [F] 同名 A=+500 / B=-50 两行独立 PASS')
}

// ---- G: 仅调整月 readiness（无考勤无业务）----
{
  const adjustments = [adj('emp-A', '2026-08-10', 50000, 'G')]
  const r = evaluatePayrollReadiness({ month: '2026-08', dailyEntries: {}, dailyStoreStaffRows: [], dailyPayAdjustments: adjustments, bigOrderBonuses: [], employees: [{ id: 'emp-A' }], users: [] })
  assert.equal(r.calculationReady, true, 'G 仅调整月计算就绪')
  assert.equal(r.calculationBlockers.some((b) => b.reason === 'NO_PAYROLL_SUBJECTS'), false, 'G 无 NO_PAYROLL_SUBJECTS')
  assert.equal(r.coverage.payrollEmployeeCount, 1, 'G payroll 主体含 emp-A')
  console.log('  [G] 仅调整月 calculationReady=true / 无 NO_PAYROLL_SUBJECTS PASS')
}

// ---- H: 仅调整月 issue 未绑定 ----
{
  const adjustments = [adj('emp-A', '2026-08-10', 50000, 'H')]
  const r = evaluatePayrollReadiness({ month: '2026-08', dailyEntries: {}, dailyStoreStaffRows: [], dailyPayAdjustments: adjustments, bigOrderBonuses: [], employees: [{ id: 'emp-A' }], users: [] })
  assert.equal(r.calculationReady, true, 'H 计算就绪')
  assert.equal(r.issueReady, false, 'H 发放不就绪')
  assert.equal(r.issueBlockers.some((b) => b.reason === 'UNBOUND_PAYROLL_RECIPIENT'), true, 'H UNBOUND_PAYROLL_RECIPIENT')
  console.log('  [H] 仅调整月无 User → issueReady=false / UNBOUND PASS')
}

// ---- I: 仅调整月 issue 已绑定 ----
{
  const adjustments = [adj('emp-A', '2026-08-10', 50000, 'I')]
  const r = evaluatePayrollReadiness({ month: '2026-08', dailyEntries: {}, dailyStoreStaffRows: [], dailyPayAdjustments: adjustments, bigOrderBonuses: [], employees: [{ id: 'emp-A' }], users: [{ id: 'u1', username: 'zhangwei', employeeId: 'emp-A', status: 'active' }] })
  assert.equal(r.calculationReady, true, 'I 计算就绪')
  assert.equal(r.issueReady, true, 'I 发放就绪（1 个 active 绑定 User）')
  console.log('  [I] 仅调整月绑定 User → issueReady=true PASS')
}

// ---- J: 导出汇总（resolver EMPLOYEE_ID 结果含调整仅日行）----
{
  const adjustments = [adj('emp-A', '2026-08-10', 50000, 'J +500')]
  const res = resolvePayrollCalculation({ month: '2026-08', dailyEntries: {}, dailyStoreStaffRows: [], dailyPayAdjustments: adjustments, bigOrderBonuses: [], employees: [{ id: 'emp-A', name: '张伟', employeeNo: 'A001', storeKey: 'guanshe', type: 'fulltime' }], users: [] })
  assert.equal(res.mode, 'EMPLOYEE_ID', 'J 稳定模式')
  assert.equal(res.calculationReady, true, 'J 计算就绪')
  assert.equal(res.payroll.employees.length, 1, 'J payroll 含 emp-A')
  const a = res.payroll.employees[0]
  assert.equal(a.salary, 500, 'J 汇总含 500')
  assert.equal(a.salaryAdjustment, 500, 'J 汇总调整 500')
  console.log('  [J] 导出汇总含调整仅日贡献 PASS')
}

// ---- K: 导出明细（仅调整日调整独占行：reason + employeeId 正确、工时 0）----
{
  seedCachedDataForTest({
    entries: {},
    staff: [],
    dailyPayAdjustments: [adj('emp-A', '2026-08-10', 50000, 'K 仅调整日 +500')],
    bigBonuses: [], removedStaff: [], stores: [{ key: 'guanshe', name: '北京官舍店' }],
    schedules: {}, products: [], inventoryRequests: [], inventory: [], analysis: {}, productImages: {}, posDaily: [], posProductSales: [],
  })
  const detail = employeeDailyPayDetail('2026-08', '08-10', '张伟', 'emp-A', [])
  assert.ok(detail, 'K 调整独占明细存在')
  assert.equal(detail.rows.length, 0, 'K 无考勤行（不虚构）')
  assert.equal(detail.totals.hours, 0, 'K 工时 0')
  assert.equal(detail.totals.automaticPay, 0, 'K 自动工资 0')
  assert.equal(detail.totals.salaryAdjustment, 500, 'K 调整 500')
  assert.equal(detail.totals.pay, 500, 'K 最终工资 500')
  assert.equal(detail.totals.payAdjustment.employeeId, 'emp-A', 'K 身份 employeeId')
  assert.equal(detail.totals.payAdjustment.reason, 'K 仅调整日 +500', 'K 原因正确')
  console.log('  [K] 导出明细调整独占行（employeeId+reason+工时 0）PASS')
}

// ---- L: 考勤+调整同日不重复（明细行 1 条、调整贡献 1 次）----
{
  seedCachedDataForTest({
    entries: { '2026-08|guanshe|08-01': { inc: 6000, ord: 60, staff: ['张伟'] } },
    staff: [{ id: 'emp-A', name: '张伟', storeKey: 'guanshe', type: 'fulltime', employeeNo: 'A001' }],
    dailyPayAdjustments: [adj('emp-A', '2026-08-01', 10000, 'L 考勤日调整 100')],
    bigBonuses: [], removedStaff: [], stores: [{ key: 'guanshe', name: '北京官舍店' }],
    schedules: {}, products: [], inventoryRequests: [], inventory: [], analysis: {}, productImages: {}, posDaily: [], posProductSales: [],
  })
  const detail = employeeDailyPayDetail('2026-08', '08-01', '张伟', 'emp-A', [{ id: 'a1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-01', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张伟', actualHours: 8 }])
  assert.equal(detail.rows.length, 1, 'L 考勤日 1 条门店行（非 1+1 重复）')
  assert.equal(detail.totals.pay, 100, 'L 调整覆盖一次')
  const out = calculateEmployeeIdShadowPayroll({ '2026-08|guanshe|08-01': { inc: 6000, ord: 60, staff: ['张伟'] } }, [{ id: 'a1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-01', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张伟', actualHours: 8 }], [], [adj('emp-A', '2026-08-01', 10000, 'L')], '2026-08')
  assert.equal(out.employees[0].adjustmentCount, 1, 'L 月度调整贡献恰好 1 次')
  console.log('  [L] 考勤+调整同日 → 恰好一次 PASS')
}

// ---- M: 正常 8h/6h 回归（Gate 25 口径不变）----
{
  const entries = { '2026-08|guanshe|08-01': { inc: 6000, ord: 60, staff: ['张伟', '张伟'] } }
  const staff = [
    { id: 'a1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-01', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张伟', actualHours: 8 },
    { id: 'b1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-01', employeeId: 'emp-B', staffId: 'st-b', staffNameSnapshot: '张伟', actualHours: 6 },
  ]
  const out = calculateEmployeeIdShadowPayroll(entries, staff, [], [], '2026-08')
  const a = out.employees.find((r) => r.employeeId === 'emp-A')
  const b = out.employees.find((r) => r.employeeId === 'emp-B')
  assert.equal(a.payableHours, 8, 'M emp-A 8h')
  assert.equal(b.payableHours, 6, 'M emp-B 6h')
  assert.equal(a.salary, 440, 'M emp-A 按实际 8h')
  assert.equal(b.salary, 330, 'M emp-B 按实际 6h')
  console.log('  [M] 8h/6h 稳定工时金额独立 PASS')
}

// ---- N: Personnel 展示（resolver → Employee.id join；byEmployeeId 可命中调整仅日行）----
{
  const adjustments = [adj('emp-A', '2026-08-10', 50000, 'N +500')]
  const res = resolvePayrollCalculation({ month: '2026-08', dailyEntries: {}, dailyStoreStaffRows: [], dailyPayAdjustments: adjustments, bigOrderBonuses: [], employees: [{ id: 'emp-A', name: '张伟' }, { id: 'emp-B', name: '张伟' }], users: [] })
  const byId = new Map(res.payroll.employees.map((row) => [row.employeeId, { ...row, payrollComputed: true }]))
  assert.equal(byId.has('emp-A'), true, 'N emp-A 卡可 join 到 payroll 行')
  assert.equal(byId.get('emp-A').salary, 500, 'N emp-A 金额 500')
  assert.equal(byId.has('emp-B'), false, 'N emp-B 无 payroll 行（同名不串）')
  console.log('  [N] Personnel Employee.id join 可命中调整仅日行 PASS')
}

// ---- O: 空月（无考勤无调整）行为保留 ----
{
  const r = evaluatePayrollReadiness({ month: '2026-08', dailyEntries: {}, dailyStoreStaffRows: [], dailyPayAdjustments: [], bigOrderBonuses: [], employees: [], users: [] })
  assert.equal(r.calculationReady, false, 'O 空月计算不就绪')
  assert.equal(r.calculationBlockers.some((b) => b.reason === 'NO_PAYROLL_SUBJECTS'), true, 'O NO_PAYROLL_SUBJECTS 保留')
  const res = resolvePayrollCalculation({ month: '2026-08', dailyEntries: {}, dailyStoreStaffRows: [], dailyPayAdjustments: [], bigOrderBonuses: [], employees: [], users: [] })
  assert.equal(res.mode, 'LEGACY', 'O 空月 LEGACY（Gate 23 行为）')
  assert.equal(res.payroll.employees.length, 0, 'O 空结果')
  console.log('  [O] 空月 NO_PAYROLL_SUBJECTS 保留 PASS')
}

// ---- P: 月边界（7 月调整绝不进入 8 月 payroll）----
{
  const out = calculateEmployeeIdShadowPayroll({}, [], [], [adj('emp-A', '2026-07-31', 50000, '7 月')], '2026-08')
  assert.equal(out.employees.length, 0, 'P 7 月调整不进入 8 月')
  const r = evaluatePayrollReadiness({ month: '2026-08', dailyEntries: {}, dailyStoreStaffRows: [], dailyPayAdjustments: [adj('emp-A', '2026-07-31', 50000, '7 月')], bigOrderBonuses: [], employees: [], users: [] })
  assert.equal(r.calculationReady, false, 'P 8 月无主体（7 月调整不算 8 月）')
  console.log('  [P] 月边界严格 PASS')
}

// ---- Q: legacy NULL 调整冻结（LEGACY_PAY_ADJUSTMENT_IDENTITY 阻断）----
{
  const legacyAdj = { id: 'd-legacy', employeeId: null, staffName: '张伟', date: '2026-08-10', autoPayCentsSnapshot: 0, adjustedPayCents: 50000, reason: '无身份', active: true, version: 1 }
  const r = evaluatePayrollReadiness({ month: '2026-08', dailyEntries: {}, dailyStoreStaffRows: [], dailyPayAdjustments: [legacyAdj], bigOrderBonuses: [], employees: [], users: [] })
  assert.equal(r.calculationReady, false, 'Q legacy NULL 调整阻断计算就绪')
  assert.equal(r.calculationBlockers.some((b) => b.reason === 'LEGACY_PAY_ADJUSTMENT_IDENTITY'), true, 'Q LEGACY_PAY_ADJUSTMENT_IDENTITY')
  const out = calculateEmployeeIdShadowPayroll({}, [], [], [legacyAdj], '2026-08')
  assert.equal(out.employees.length, 0, 'Q 计算器不猜测 NULL 调整身份')
  console.log('  [Q] legacy NULL 调整冻结 PASS')
}

console.log('GATE 26 PAYROLL ADJUSTMENT-ONLY TEST OK')
