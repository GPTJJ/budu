// Gate 27：PayrollIssueModal 稳定发放纯逻辑（resolver 消费 + Employee.id 主体/快照/预检）
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { buildIssueSnapshot, buildIssueRows, preflightIssueSelection, buildIssuePayloadRows } = await import(path.join(root, 'src/utils/payrollIssue.js').replaceAll('\\', '/'))
const { resolvePayrollCalculation } = await import(path.join(root, 'src/utils/payrollResolver.js').replaceAll('\\', '/'))

const recA = { employeeId: 'emp-A', displayName: '张伟', storesWorked: ['guanshe'], days: 1, actualHours: 8, workedRevenue: 6000, orders: 60, basePay: 224, commission: 440, transferSubsidy: 16, bigBonus: 0, salaryAdjustment: 0, salary: 680 }
const recB = { employeeId: 'emp-B', displayName: '张伟', storesWorked: ['guanshe'], days: 1, actualHours: 6, workedRevenue: 6000, orders: 60, basePay: 168, commission: 330, transferSubsidy: 12, bigBonus: 0, salaryAdjustment: 0, salary: 510 }
const users = [
  { id: 'u1', username: 'user-a', employeeId: 'emp-A', status: 'active' },
  { id: 'u2', username: 'user-b', employeeId: 'emp-B', status: 'active' },
]
const dirById = new Map([
  ['emp-A', { id: 'emp-A', name: '张伟', employeeNo: 'A001', storeKey: 'guanshe', type: 'fulltime' }],
  ['emp-B', { id: 'emp-B', name: '张伟', employeeNo: 'B001', storeKey: 'guanshe', type: 'parttime' }],
])

// ---- A: 稳定单员工（快照形状 + 金额来自同一 rec）----
{
  const snap = buildIssueSnapshot(recA)
  assert.equal(snap.summary.workedDays, 1, 'A 出勤天')
  assert.equal(snap.summary.hours, 8, 'A 工时')
  assert.equal(snap.summary.total, 680, 'A 合计 = rec.salary')
  assert.equal(snap.summary.basePay, 224, 'A basePay 同源')
  assert.ok(Array.isArray(snap.days) && typeof snap.summary === 'object', 'A 快照形状 {days, summary}')
  const rows = buildIssueRows([recA], [{ employeeId: 'emp-A', days: 1, issueReady: true, blockers: [] }], users, dirById)
  assert.equal(rows.length, 1, 'A 一行')
  assert.equal(rows[0].employeeId, 'emp-A', 'A 主体 employeeId')
  assert.equal(rows[0].targetUsername, 'user-a', 'A 收件人 User.employeeId 精确')
  const payload = buildIssuePayloadRows(rows)
  assert.equal(payload[0].employeeId, 'emp-A')
  assert.equal(payload[0].totalCents, 68000, 'A totalCents = rec.salary*100')
  console.log('  [A] 稳定单员工快照/金额/收件人 PASS')
}

// ---- B: 同店同名 A/B 不同金额，两行独立、金额各自归属 ----
{
  const readiness = [
    { employeeId: 'emp-A', days: 1, issueReady: true, blockers: [] },
    { employeeId: 'emp-B', days: 1, issueReady: true, blockers: [] },
  ]
  const rows = buildIssueRows([recA, recB], readiness, users, dirById)
  assert.equal(rows.length, 2, 'B 两行')
  const a = rows.find((r) => r.employeeId === 'emp-A')
  const b = rows.find((r) => r.employeeId === 'emp-B')
  assert.equal(a.rec.salary, 680, 'B A 金额 680')
  assert.equal(b.rec.salary, 510, 'B B 金额 510')
  assert.equal(a.targetUsername, 'user-a', 'B 收件人 user-a')
  assert.equal(b.targetUsername, 'user-b', 'B 收件人 user-b')
  const payload = buildIssuePayloadRows(rows)
  assert.deepEqual(payload.map((p) => [p.employeeId, p.totalCents]), [['emp-A', 68000], ['emp-B', 51000]], 'B payload 独立')
  assert.equal(payload[0].snapshot.summary.total, 680)
  assert.equal(payload[1].snapshot.summary.total, 510)
  console.log('  [B] 同店同名两行独立（金额/收件人/快照）PASS')
}

// ---- D/E/F: 预检（月度 issueReady=false 但选中就绪员工可发；含未就绪则整批阻断）----
{
  const readiness = [
    { employeeId: 'emp-A', days: 1, issueReady: true, blockers: [] },
    { employeeId: 'emp-B', days: 1, issueReady: false, blockers: [{ type: 'ISSUE_BLOCKER', reason: 'UNBOUND_PAYROLL_RECIPIENT' }] },
  ]
  const rows = buildIssueRows([recA, recB], readiness, [users[0]], dirById) // 仅 user-a 绑定
  // D: 只选 emp-A → 通过
  const d = preflightIssueSelection(rows, new Set(['emp-A']))
  assert.equal(d.ok, true, 'D 仅选就绪员工可通过')
  // E: 选 A+B → 整批阻断
  const e = preflightIssueSelection(rows, new Set(['emp-A', 'emp-B']))
  assert.equal(e.ok, false, 'E A+B 阻断')
  assert.deepEqual(e.blocked.map((b) => b.employeeId), ['emp-B'], 'E 阻断列表含 emp-B')
  // F: 只选 B → 阻断
  const f = preflightIssueSelection(rows, new Set(['emp-B']))
  assert.equal(f.ok, false, 'F 仅 B 阻断')
  console.log('  [D/E/F] per-employee 预检（月度全局不要求）PASS')
}

// ---- G: 重复绑定（>1 active User.employeeId）→ 不可发放 ----
{
  const dupUsers = [
    { id: 'u1', username: 'user-a', employeeId: 'emp-A', status: 'active' },
    { id: 'u2', username: 'user-a2', employeeId: 'emp-A', status: 'active' },
  ]
  const readiness = [{ employeeId: 'emp-A', days: 1, issueReady: false, blockers: [{ type: 'ISSUE_BLOCKER', reason: 'DUPLICATE_PAYROLL_RECIPIENT' }] }]
  const rows = buildIssueRows([recA], readiness, dupUsers, dirById)
  assert.equal(rows[0].issueReady, false, 'G 重复绑定 issueReady=false')
  assert.equal(rows[0].matches.length, 2, 'G 2 个候选（不选第一个）')
  assert.equal(rows[0].targetUsername, '', 'G 无 first-match 收件人')
  const p = preflightIssueSelection(rows, new Set(['emp-A']))
  assert.equal(p.ok, false, 'G 阻断')
  console.log('  [G] 重复绑定阻断（无 first-match）PASS')
}

// ---- H: 调整仅日员工（0 天 / 0 时 / salary 500）可见可发 ----
{
  const recAdj = { employeeId: 'emp-C', displayName: '李四', storesWorked: [], days: 0, actualHours: 0, workedRevenue: 0, orders: 0, basePay: 0, commission: 0, transferSubsidy: 0, bigBonus: 0, salaryAdjustment: 500, salary: 500 }
  const readiness = [{ employeeId: 'emp-C', days: 0, issueReady: true, blockers: [] }]
  const rows = buildIssueRows([recAdj], readiness, [{ id: 'u3', username: 'user-c', employeeId: 'emp-C', status: 'active' }], new Map())
  assert.equal(rows.length, 1, 'H 主体可见')
  assert.equal(rows[0].rec.days, 0, 'H 0 天')
  assert.equal(rows[0].rec.actualHours, 0, 'H 0 时')
  assert.equal(rows[0].rec.salary, 500, 'H salary 500')
  const snap = rows[0].snapshot
  assert.equal(snap.summary.workedDays, 0)
  assert.equal(snap.summary.hours, 0)
  assert.equal(snap.summary.total, 500, 'H 快照 0/0/500')
  const p = preflightIssueSelection(rows, new Set(['emp-C']))
  assert.equal(p.ok, true, 'H 绑定后可发')
  console.log('  [H] 调整仅日员工可见可发（0/0/500）PASS')
}

// ---- K: 离职/历史员工主体不因当前目录缺失被丢弃（displayName 快照回退，无 name 推断）----
{
  const recOld = { employeeId: 'emp-X', displayName: '王五', storesWorked: ['guanshe'], days: 2, actualHours: 16, workedRevenue: 9000, orders: 90, basePay: 448, commission: 880, transferSubsidy: 32, bigBonus: 0, salaryAdjustment: 0, salary: 1360 }
  const readiness = [{ employeeId: 'emp-X', days: 2, issueReady: true, blockers: [] }]
  const rows = buildIssueRows([recOld], readiness, [{ id: 'u9', username: 'wangwu', employeeId: 'emp-X', status: 'active' }], new Map()) // 目录无 emp-X
  assert.equal(rows.length, 1, 'K 主体保留')
  assert.equal(rows[0].employeeId, 'emp-X', 'K 身份 employeeId')
  assert.equal(rows[0].name, '王五', 'K 显示名取结果快照（非 name 匹配金额）')
  assert.equal(rows[0].rec.salary, 1360, 'K 金额同源')
  console.log('  [K] 历史员工主体保留（快照回退）PASS')
}

// ---- M: 快照身份——summary 每字段与同一 rec 同源（无混合）----
{
  const mixed = { ...recA, basePay: 999, commission: 888, transferSubsidy: 77, bigBonus: 66, salaryAdjustment: 55, salary: 444 }
  const snap = buildIssueSnapshot(mixed)
  assert.equal(snap.summary.basePay, 999)
  assert.equal(snap.summary.commission, 888)
  assert.equal(snap.summary.transferSubsidy, 77)
  assert.equal(snap.summary.bigBonus, 66)
  assert.equal(snap.summary.adjustment, 55)
  assert.equal(snap.summary.total, 444, 'M 合计 = 同 rec.salary')
  const payload = buildIssuePayloadRows([{ employeeId: 'emp-A', name: '张伟', storeKey: 'guanshe', rec: mixed, snapshot: snap }])
  assert.equal(payload[0].totalCents, 44400, 'M totalCents 同源')
  console.log('  [M] 快照全字段同源 PASS')
}

// ---- N: 全链路——resolver 结果 → 行 → 预检 → payload（与 modal 同构）----
{
  const res = resolvePayrollCalculation({
    month: '2026-08',
    dailyEntries: { '2026-08|guanshe|08-01': { inc: 6000, ord: 60, staff: ['张伟', '张伟'] } },
    dailyStoreStaffRows: [
      { id: 'a1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-01', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张伟', actualHours: 8 },
      { id: 'b1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-01', employeeId: 'emp-B', staffId: 'st-b', staffNameSnapshot: '张伟', actualHours: 6 },
    ],
    dailyPayAdjustments: [],
    bigOrderBonuses: [],
    employees: [],
    users,
  })
  assert.equal(res.mode, 'EMPLOYEE_ID', 'N 稳定模式')
  assert.equal(res.calculationReady, true, 'N 计算就绪')
  assert.equal(res.issueReady, true, 'N 月度发放就绪（两人均绑定）')
  const rows = buildIssueRows(res.payroll.employees, res.readiness.employees, users, dirById)
  assert.equal(rows.length, 2, 'N 两行')
  const a = rows.find((r) => r.employeeId === 'emp-A')
  assert.equal(a.rec.salary, res.payroll.employees.find((r) => r.employeeId === 'emp-A').salary, 'N 金额 = resolver 同 id 行')
  assert.equal(preflightIssueSelection(rows, new Set(['emp-A', 'emp-B'])).ok, true, 'N 全选可发')
  console.log('  [N] resolver → 行 → 预检 → payload 全链路 PASS')
}

// ---- O: 跨月条目不得污染当月就绪度（Gate 27 月隔离：8 月仅姓名条目不影响 7 月空月判定）----
{
  const { evaluatePayrollReadiness } = await import(path.join(root, 'src/utils/payrollReadiness.js').replaceAll('\\', '/'))
  const out = evaluatePayrollReadiness({
    month: '2026-07',
    dailyEntries: { '2026-08|guanshe|08-01': { inc: 6000, ord: 60, staff: ['张伟'] } }, // 8 月条目无考勤行
    dailyStoreStaffRows: [],
    dailyPayAdjustments: [],
    bigOrderBonuses: [],
    employees: [],
    users: [],
  })
  const blockers = out.calculationBlockers
  assert.equal(blockers.some((b) => b.reason === 'LEGACY_NAME_ONLY_ENTRY'), false, 'O 8 月条目不产生 7 月 LEGACY_NAME_ONLY_ENTRY')
  assert.equal(blockers.some((b) => b.reason === 'NO_PAYROLL_SUBJECTS'), true, 'O 7 月仅 NO_PAYROLL_SUBJECTS')
  assert.equal(out.coverage.unresolvedDays, 0, 'O coverage unresolved 月内')
  console.log('  [O] 跨月条目不污染当月就绪度 PASS')
}

// ---- P/Q/R: 快照逐日明细（employeeId 安全；同店同名隔离；调整仅日真实表示）----
{
  const { seedCachedDataForTest } = await import(path.join(root, 'src/utils/userData.js').replaceAll('\\', '/'))
  seedCachedDataForTest({
    entries: { '2026-08|guanshe|08-01': { inc: 12000, ord: 120, staff: ['张伟', '张伟'] } },
    staff: [
      { id: 'emp-A', name: '张伟', storeKey: 'guanshe', type: 'fulltime', employeeNo: 'A001' },
      { id: 'emp-B', name: '张伟', storeKey: 'guanshe', type: 'parttime', employeeNo: 'B001' },
    ],
    dailyPayAdjustments: [
      { id: 'dpa-a', employeeId: 'emp-A', staffName: '张伟', date: '2026-08-10', autoPayCentsSnapshot: 0, adjustedPayCents: 50000, reason: 'A 仅调整日 +500', active: true, version: 1 },
      { id: 'dpa-b', employeeId: 'emp-B', staffName: '张伟', date: '2026-08-10', autoPayCentsSnapshot: 0, adjustedPayCents: -5000, reason: 'B 仅调整日 -50', active: true, version: 1 },
    ],
    bigBonuses: [], removedStaff: [], stores: [{ key: 'guanshe', name: '北京官舍店' }],
    schedules: {}, products: [], inventoryRequests: [], inventory: [], analysis: {}, productImages: {}, posDaily: [], posProductSales: [],
  })
  const attendance = [
    { id: 'a1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-01', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张伟', actualHours: 8 },
    { id: 'b1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-01', employeeId: 'emp-B', staffId: 'st-b', staffNameSnapshot: '张伟', actualHours: 6 },
  ]
  const snapA = buildIssueSnapshot(recA, { month: '2026-08', name: '张伟', attendanceRows: attendance })
  const snapB = buildIssueSnapshot(recB, { month: '2026-08', name: '张伟', attendanceRows: attendance })
  // P: 逐日填充（31 天；考勤日 hasData + 各自工时）
  assert.equal(snapA.days.length, 31, 'P 31 天逐日')
  const dayA01 = snapA.days.find((d) => d.day === '08-01')
  const dayB01 = snapB.days.find((d) => d.day === '08-01')
  assert.equal(dayA01.hasData, true, 'P A 考勤日 hasData')
  assert.equal(dayA01.hours, 8, 'P A 工时 8（DailyStoreStaff.actualHours）')
  assert.equal(dayB01.hours, 6, 'P B 工时 6')
  assert.equal(dayB01.pay, 510, 'P B 考勤日工资（6h 口径）')
  // Q: 同店同名隔离——A/B 各自调整仅日归属（无交叉）
  const dayA10 = snapA.days.find((d) => d.day === '08-10')
  const dayB10 = snapB.days.find((d) => d.day === '08-10')
  assert.equal(dayA10.hasData, true, 'Q A 调整仅日 hasData')
  assert.equal(dayA10.hours, 0, 'Q A 调整仅日工时 0（不虚构考勤）')
  assert.equal(dayA10.adjustment, 500, 'Q A 调整 500')
  assert.equal(dayA10.pay, 500, 'Q A 最终 500')
  assert.equal(dayB10.adjustment, -50, 'Q B 调整 -50（不误取 A 的 500）')
  assert.equal(dayB10.pay, -50, 'Q B 最终 -50')
  // R: 无考勤无调整日 hasData=false（与既有工资条语义一致）
  const dayA02 = snapA.days.find((d) => d.day === '08-02')
  assert.equal(dayA02.hasData, false, 'R 空日 hasData=false')
  assert.equal(dayA02.hours, 0, 'R 空日工时 0')
  console.log('  [P/Q/R] 快照逐日明细（工时/调整按 employeeId、仅调整日真实表示）PASS')
}

// ---- S: 负工资总额预检（NEGATIVE_PAYROLL_TOTAL，仅 ISSUE 级阻断）----
{
  const recNeg = { ...recB, salary: -50 }
  const recZero = { ...recA, salary: 0 }
  const ready = (id) => ({ employeeId: id, days: 1, issueReady: true, blockers: [] })
  const rowsAll = buildIssueRows([recA, recNeg], [ready('emp-A'), ready('emp-B')], users, dirById)
  const rowsZero = buildIssueRows([recZero], [ready('emp-A')], users, dirById)
  // A: 正工资单独选中 → 允许
  assert.equal(preflightIssueSelection(rowsAll, new Set(['emp-A'])).ok, true, 'S-A 正工资可发')
  // B: 负工资单独选中 → 阻断
  const b = preflightIssueSelection(rowsAll, new Set(['emp-B']))
  assert.equal(b.ok, false, 'S-B 负工资阻断')
  assert.equal(b.blocked[0].reason, 'NEGATIVE_PAYROLL_TOTAL', 'S-B 原因 NEGATIVE_PAYROLL_TOTAL')
  // C: 正 + 负 → 整批阻断
  const c = preflightIssueSelection(rowsAll, new Set(['emp-A', 'emp-B']))
  assert.equal(c.ok, false, 'S-C A+B 整批阻断')
  assert.equal(c.blocked.some((x) => x.reason === 'NEGATIVE_PAYROLL_TOTAL'), true, 'S-C 含负工资原因')
  // D: 负工资未选中 → 不阻断正工资员工
  assert.equal(preflightIssueSelection(rowsAll, new Set(['emp-A'])).ok, true, 'S-D 未选中的负工资不阻断就绪员工')
  // 零工资 → 允许（服务端允许 0，不发明零工资阻断）
  assert.equal(preflightIssueSelection(rowsZero, new Set(['emp-A'])).ok, true, 'S-零工资允许')
  // 负工资不影响 calculationReady（resolver 层面可计算）
  assert.equal(rowsAll.find((r) => r.employeeId === 'emp-B').rec.salary, -50, 'S 负工资结果仍存在（展示/导出可用）')
  console.log('  [S] 负工资预检（A/B/C/D/零）PASS')
}

console.log('GATE 27 PAYROLL ISSUE RESOLVER TEST OK')
