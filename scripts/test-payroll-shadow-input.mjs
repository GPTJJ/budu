// Gate 13：Employee.id payroll 输入 shadow 模型（纯函数，SHADOW ONLY，零 live 消费）
// A 单员工 / B 同日两人 share=2 / C 跨店同名分离 / D 调店历史保留 / E 前员工保留
// F legacy NULL 不推断 / G 仅姓名无稳定考勤 → unresolved / H 稳定考勤无业务 → 不虚构
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { buildEmployeePayrollDayInputs } = await import(path.join(root, 'src/utils/payrollShadowInput.js').replaceAll('\\', '/'))

// A: 单员工
{
  const entries = { '2026-09|guanshe|09-01': { inc: 10000, ord: 100, staff: ['张三'] } }
  const staff = [{ id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-09-01', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张三', actualHours: 8 }]
  const out = buildEmployeePayrollDayInputs(entries, staff)
  assert.equal(out.stableRows.length, 1, 'A 一行稳定输入')
  assert.equal(out.stableRows[0].employeeId, 'emp-A')
  assert.equal(out.stableRows[0].staffCountForShare, 1)
  assert.equal(out.stableRows[0].dailyRevenueCents, 1000000, 'inc 元 → 分')
  assert.equal(out.stableRows[0].entryStatus, 'JOINED')
  console.log('  [A] 单员工 PASS')
}

// B: 同日两人 share=2
{
  const entries = { '2026-09|guanshe|09-02': { inc: 20000, ord: 200, staff: ['张三', '李四'] } }
  const staff = [
    { id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-09-02', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张三', actualHours: 8 },
    { id: 'r2', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-09-02', employeeId: 'emp-B', staffId: 'st-b', staffNameSnapshot: '李四', actualHours: 6 },
  ]
  const out = buildEmployeePayrollDayInputs(entries, staff)
  assert.equal(out.stableRows.length, 2, 'B 两行')
  assert.equal(out.stableRows[0].staffCountForShare, 2)
  assert.equal(out.stableRows[1].staffCountForShare, 2)
  assert.equal(out.stableRows[0].actualHours, 8)
  assert.equal(out.stableRows[1].actualHours, 6)
  console.log('  [B] 同日两人 share=2 PASS')
}

// C: 跨店同名分离
{
  const entries = {
    '2026-09|guanshe|09-03': { inc: 5000, ord: 50, staff: ['张伟'] },
    '2026-09|chaowai|09-03': { inc: 6000, ord: 60, staff: ['张伟'] },
  }
  const staff = [
    { id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-09-03', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张伟', actualHours: 8 },
    { id: 'r2', storeId: 'chaowai', storeKey: 'chaowai', date: '2026-09-03', employeeId: 'emp-B', staffId: 'st-b', staffNameSnapshot: '张伟', actualHours: 8 },
  ]
  const out = buildEmployeePayrollDayInputs(entries, staff)
  assert.equal(out.stableRows.length, 2, 'C 两行不合并')
  const ids = out.stableRows.map((r) => r.employeeId).sort()
  assert.deepEqual(ids, ['emp-A', 'emp-B'])
  console.log('  [C] 跨店同名分离 PASS')
}

// D: 调店历史保留（同 employeeId 不同 store/date）
{
  const entries = {
    '2026-08|guanshe|08-01': { inc: 5000, ord: 50, staff: ['张三'] },
    '2026-08|chaowai|08-20': { inc: 7000, ord: 70, staff: ['张三'] },
  }
  const staff = [
    { id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-01', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张三', actualHours: 8 },
    { id: 'r2', storeId: 'chaowai', storeKey: 'chaowai', date: '2026-08-20', employeeId: 'emp-A', staffId: 'st-a2', staffNameSnapshot: '张三', actualHours: 8 },
  ]
  const out = buildEmployeePayrollDayInputs(entries, staff)
  assert.equal(out.stableRows.length, 2, 'D 两行')
  assert.equal(out.stableRows[0].employeeId, 'emp-A')
  assert.equal(out.stableRows[0].storeId, 'guanshe')
  assert.equal(out.stableRows[1].storeId, 'chaowai', '历史门店保留（非 currentStoreKey）')
  console.log('  [D] 调店历史保留 PASS')
}

// E: 前员工保留（不要求当前 ACTIVE——纯历史数据输入）
{
  const entries = { '2026-07|guanshe|07-15': { inc: 4000, ord: 40, staff: ['王五'] } }
  const staff = [{ id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-07-15', employeeId: 'emp-X', staffId: 'st-x', staffNameSnapshot: '王五', actualHours: 8 }]
  const out = buildEmployeePayrollDayInputs(entries, staff)
  assert.equal(out.stableRows.length, 1, 'E 前员工行保留')
  assert.equal(out.stableRows[0].employeeId, 'emp-X')
  console.log('  [E] 前员工保留 PASS')
}

// F: legacy NULL 不推断
{
  const entries = { '2026-09|guanshe|09-05': { inc: 3000, ord: 30, staff: ['赵六'] } }
  const staff = [{ id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-09-05', employeeId: null, staffId: 'st-legacy', staffNameSnapshot: '赵六', actualHours: 4 }]
  const out = buildEmployeePayrollDayInputs(entries, staff)
  assert.equal(out.stableRows.length, 0, 'F 无稳定行')
  assert.equal(out.legacyRows.length, 1, 'F legacy 行保留')
  assert.equal(out.legacyRows[0].employeeId, null, 'F 不推断 id')
  assert.equal(out.legacyRows[0].legacy, 'UNRESOLVED')
  console.log('  [F] legacy NULL 不推断 PASS')
}

// G: DailyEntry 仅姓名、无稳定考勤 → unresolved，绝不合成 id
{
  const entries = { '2026-09|guanshe|09-06': { inc: 2000, ord: 20, staff: ['张三'] } }
  const out = buildEmployeePayrollDayInputs(entries, [])
  assert.equal(out.stableRows.length, 0, 'G 无合成稳定行')
  assert.equal(out.unresolvedDays.length, 1, 'G 记入 unresolved')
  assert.equal(out.unresolvedDays[0].reason, 'LEGACY_NAME_ONLY_ENTRY')
  console.log('  [G] 仅姓名 unresolved PASS')
}

// H: 孤立 DailyStoreStaff 无 DailyEntry → 保留诊断，但不形成 payroll dependency
{
  const staff = [{ id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-09-07', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张三', actualHours: 8 }]
  const out = buildEmployeePayrollDayInputs({}, staff)
  assert.equal(out.stableRows.length, 0, 'H 孤立行不进入稳定 payroll input')
  assert.equal(out.unresolvedDays.length, 0, 'H 孤立行不形成 completeness dependency')
  assert.deepEqual(out.orphanRows, [{
    id: 'r1', storeId: 'guanshe', date: '2026-09-07', employeeId: 'emp-A',
    participantUserId: null, participantType: 'EMPLOYEE', reason: 'ORPHAN_DAILY_STORE_STAFF',
  }])
  console.log('  [H] orphan DSS 隔离 PASS')
}

// Parity: 非重名 fixture——shadow 识别同一批参与者（张三/李四），按 Employee.id
{
  const entries = { '2026-09|guanshe|09-08': { inc: 8000, ord: 80, staff: ['张三', '李四'] } }
  const staff = [
    { id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-09-08', employeeId: 'emp-A', staffId: 'st-a', staffNameSnapshot: '张三', actualHours: 8 },
    { id: 'r2', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-09-08', employeeId: 'emp-B', staffId: 'st-b', staffNameSnapshot: '李四', actualHours: 8 },
  ]
  const out = buildEmployeePayrollDayInputs(entries, staff)
  assert.equal(out.stableRows.length, 2, 'Parity 两名参与者')
  assert.deepEqual(out.stableRows.map((r) => r.employeeId).sort(), ['emp-A', 'emp-B'])
  assert.deepEqual(out.stableRows.map((r) => r.staffNameSnapshot).sort(), ['张三', '李四'])
  console.log('  [Parity] 参与者一致（按 Employee.id）PASS')
}

// 同店同名：Gate 6 legacy 约束导致 DailyStoreStaff 只有一行（BLOCKED BY LEGACY CONSTRAINT）
{
  const entries = { '2026-09|guanshe|09-09': { inc: 5000, ord: 50, staff: ['张伟', '张伟'] } }
  const staff = [{ id: 'r1', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-09-09', employeeId: 'emp-A', staffId: 'st-same', staffNameSnapshot: '张伟', actualHours: 8 }]
  const out = buildEmployeePayrollDayInputs(entries, staff)
  assert.equal(out.stableRows.length, 1, '同店同名受 Gate 6 约束只有一行（BLOCKED BY LEGACY DAILY STORE STAFF CONSTRAINT，非 Gate 13 失败）')
  console.log('  [同店同名] BLOCKED BY LEGACY CONSTRAINT（预期记录）PASS')
}

console.log('GATE 13 PAYROLL SHADOW INPUT TEST OK')
