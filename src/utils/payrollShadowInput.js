/**
 * Gate 13：Employee.id-native payroll 输入 shadow 模型（纯函数，SHADOW ONLY）。
 *
 * 目的：把 DailyEntry（store/day 业务数据）与 DailyStoreStaff（store/date/employeeId 考勤）
 * 按 store + date 规范化 JOIN 成稳定的 payroll 日输入行——以 Employee.id 为唯一身份。
 *
 * 边界（本模块绝不触碰）：
 * - 不计算任何工资/绩效/提成/奖金/最终金额
 * - 不修改 monthlyPayrollFromEntries / entryMonthStats / entryEmployeePerformance
 * - 零 live 消费者；仅测试与未来并行计算可读
 * - legacy employeeId=NULL 行：不推断身份，显式分类为 legacy unresolved
 */

/**
 * 构建某月 Employee.id payroll 日输入 shadow 行。
 *
 * @param {object} dailyEntries 与 cached.entries 同构：key `YYYY-MM|storeKey|MM-DD` → { inc, ord, staff, v2version }
 * @param {Array} dailyStoreStaffRows Gate 12 加载的 DailyStoreStaff 行（含 storeId/storeKey/date/employeeId/...）
 * @returns {{ stableRows: Array, legacyRows: Array, unresolvedDays: Array }}
 */
export function buildEmployeePayrollDayInputs(dailyEntries, dailyStoreStaffRows) {
  const entries = dailyEntries && typeof dailyEntries === 'object' ? dailyEntries : {}
  const staffRows = Array.isArray(dailyStoreStaffRows) ? dailyStoreStaffRows : []

  // 1) 建立 DailyEntry 索引：`storeKey|YYYY-MM-DD` → 业务行
  const entryByStoreDate = new Map()
  for (const [key, v] of Object.entries(entries)) {
    const parts = key.split('|')
    if (parts.length !== 3 || parts[1] === 'all') continue
    const fullDate = `${parts[0]}-${String(parts[2]).includes('-') ? String(parts[2]).slice(3) : parts[2]}`
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fullDate)) continue
    entryByStoreDate.set(`${parts[1]}|${fullDate}`, { storeKey: parts[1], date: fullDate, inc: Number(v.inc) || 0, ord: Number(v.ord) || 0, staffNames: Array.isArray(v.staff) ? v.staff : [] })
  }

  // 2) DailyStoreStaff 按 (storeId, date) 分组 → 计数（分摊基数）
  const rowsByStoreDate = new Map()
  for (const row of staffRows) {
    const storeId = row.storeId || row.storeKey || ''
    const date = String(row.date || '').slice(0, 10)
    if (!storeId || !date) continue
    const key = `${storeId}|${date}`
    const group = rowsByStoreDate.get(key) || []
    group.push(row)
    rowsByStoreDate.set(key, group)
  }

  const stableRows = []
  const legacyRows = []
  const unresolvedDays = []

  for (const [key, group] of rowsByStoreDate) {
    const [storeId, date] = key.split('|')
    const entry = entryByStoreDate.get(key)
    const staffCountForShare = group.length
    // 稳定员工行：employeeId 非空 → 规范身份
    for (const row of group) {
      const base = {
        employeeId: row.employeeId || null,
        date,
        storeId,
        storeKey: row.storeKey || storeId,
        staffNameSnapshot: row.staffNameSnapshot || '',
        actualHours: Number(row.actualHours) || 0,
        scheduledHours: Number(row.scheduledHours) || 0,
        attendanceStatus: row.attendanceStatus || 'normal',
        staffCountForShare,
        dailyRevenueCents: entry ? Math.round((entry.inc || 0) * 100) : null,
        orderCount: entry ? entry.ord || 0 : null,
        // 缺失 DailyEntry：不虚构营业数据，显式标记
        entryStatus: entry ? 'JOINED' : 'MISSING_DAILY_ENTRY',
      }
      if (row.employeeId) {
        stableRows.push(base)
      } else {
        legacyRows.push({ ...base, legacy: 'UNRESOLVED' })
      }
    }
    // 该 store/date 有稳定考勤但无 DailyEntry 业务记录 → 记入 unresolvedDays（不虚构）
    if (!entry) unresolvedDays.push({ storeId, date, staffCountForShare, reason: 'MISSING_DAILY_ENTRY' })
  }

  // 3) DailyEntry 有 staffNames 但该 store/date 无任何 stable 考勤行 → legacy/unresolved（绝不按名合成 id）
  for (const entry of entryByStoreDate.values()) {
    if (rowsByStoreDate.has(`${entry.storeKey}|${entry.date}`)) continue
    if (!Array.isArray(entry.staffNames) || entry.staffNames.length === 0) continue
    unresolvedDays.push({
      storeId: entry.storeKey,
      date: entry.date,
      reason: 'LEGACY_NAME_ONLY_ENTRY',
      staffNames: entry.staffNames,
    })
  }

  return { stableRows, legacyRows, unresolvedDays }
}
