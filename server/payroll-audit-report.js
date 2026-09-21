import crypto from 'node:crypto'
import fs from 'node:fs'
import { fixedStoreName } from '../shared/storeDirectory.js'

const WORDMARK_SVG = fs.readFileSync(new URL('../brand/web/budu-wordmark.svg', import.meta.url), 'utf8')
const WORDMARK_SHA256 = crypto.createHash('sha256').update(WORDMARK_SVG).digest('hex')
const WORDMARK_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(WORDMARK_SVG).toString('base64')}`
export const PAYROLL_AUDIT_SOURCE = 'budu OS Payroll Audit'

const RESULT_RANK = { PASS: 0, REVIEW_REQUIRED: 1, BLOCKED: 2 }
const COMPONENT_LABELS = {
  basePay: '基础 / 工时工资',
  commission: '营业提成',
  transferSubsidy: '跨店补贴',
  bigBonus: '大单奖励',
  salaryAdjustment: '工资调整',
  overtimePay: '加班工资',
}
const NON_COMPONENT_NUMERIC = new Set([
  'days', 'workedDays', 'hours', 'payableHours', 'orders', 'workedRevenue',
  'workedRevenueCents', 'adjustmentCount', 'salary',
])

const DISPLAY_LABELS = {
  PASS: '通过', FAIL: '未通过', MATCH: '一致', MISMATCH: '不一致',
  REVIEW: '需人工复核', REVIEW_REQUIRED: '需人工复核', BLOCKED: '审查阻断',
  SCHEDULE_ONLY: '仅有排班记录', NO_ACTUAL_ATTENDANCE: '无实际出勤', ACTUAL_ONLY: '仅有实际出勤',
  STORE_CHANGED: '排班与实际门店不同', HOURS_DIFFERENCE: '排班与实际工时不同',
  SHIFT_CHANGED: '排班与实际班次不同', ADJUSTMENT_ONLY: '仅有薪酬调整', AUDITED: '已审查',
  UNKNOWN: '待确认', YES: '有影响', NO: '无影响',
}

const ISSUE_TITLES = {
  EMPLOYMENT_TYPE_HISTORY_UNAVAILABLE: '缺少用工类型历史记录',
  PAYROLL_SUBJECT_OUTSIDE_RANGE: '本周期缺少薪酬权威结果',
  EMPLOYEE_CARD_PROJECTION_ERROR: '员工薪酬卡片与权威结果不一致',
  MISSING_ACTUAL_HOURS: '缺少实际工时',
}

const text = (value) => String(value == null ? '' : value)
const isoDate = (value) => text(value).slice(0, 10)
const toCents = (yuan) => String(Math.round(Number(yuan || 0) * 100))
const centsBigInt = (value) => BigInt(text(value || '0'))
const addCents = (values) => values.reduce((sum, value) => sum + centsBigInt(value), 0n).toString()

export function payrollAuditDisplayLabel(code, context = '') {
  if (code === 'BLOCKED' && context === 'cover') return '暂不建议结算'
  return DISPLAY_LABELS[text(code)] || '待确认'
}

function employmentTypeLabel(value) {
  const normalized = text(value).toLowerCase()
  if (normalized === 'parttime' || normalized === 'part_time') return '兼职'
  if (normalized === 'fulltime' || normalized === 'full_time') return '全职'
  return text(value) || '待确认'
}

function issuePresentation(issue, employee) {
  const type = text(issue.type).trim()
  if (type === 'EMPLOYMENT_TYPE_HISTORY_UNAVAILABLE') {
    return {
      title: ISSUE_TITLES[type],
      problem: `当前系统只能确认该员工目前为“${employmentTypeLabel(employee.employmentType)}”，但缺少有效期历史，无法独立证明该身份覆盖本次完整审查周期。`,
      basis: `当前员工用工类型：${employmentTypeLabel(employee.employmentType)}`,
    }
  }
  if (type === 'PAYROLL_SUBJECT_OUTSIDE_RANGE') {
    return {
      title: ISSUE_TITLES[type],
      problem: '本审查周期内未取得该员工的薪酬权威计算结果。',
      basis: '薪酬权威未返回本周期结果。',
    }
  }
  if (type === 'MISSING_ACTUAL_HOURS') {
    return {
      title: ISSUE_TITLES[type],
      problem: '薪酬权威计算所需的实际工时缺失，当前无法完成本周期薪酬复核。',
      basis: '实际工时权威记录缺失',
    }
  }
  if (type === 'EMPLOYEE_CARD_PROJECTION_ERROR') {
    return {
      title: ISSUE_TITLES[type],
      problem: `员工薪酬卡片与薪酬权威结果相差 ${formatCents(issue.amountImpactCents)}。`,
      basis: '薪酬权威与员工薪酬卡片的同周期对照',
    }
  }
  return {
    title: ISSUE_TITLES[type] || '需要人工核对的薪酬数据异常',
    problem: issue.evidence || '当前证据不足，需要人工核对。',
    basis: issue.errorLayer || '薪酬审查数据',
  }
}

function displayAuthority(value) {
  const raw = text(value)
  if (/payroll authority/i.test(raw)) return '薪酬权威'
  if (/employee card projection/i.test(raw)) return '员工薪酬卡片'
  return raw || '待确认'
}

function displayStoreName(row = {}) {
  return text(row.storeName) || fixedStoreName(text(row.storeKey), text(row.storeKey)) || '未知门店'
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

export function stableAuditJson(value) {
  return JSON.stringify(stableValue(value))
}

export function auditHash(value) {
  return crypto.createHash('sha256').update(stableAuditJson(value)).digest('hex')
}

export function formatCents(value) {
  if (value == null || value === '') return '—'
  const cents = centsBigInt(value)
  const sign = cents < 0n ? '-' : ''
  const absolute = cents < 0n ? -cents : cents
  const yuan = absolute / 100n
  const fraction = String(absolute % 100n).padStart(2, '0')
  return `${sign}¥${yuan.toLocaleString('en-US')}.${fraction}`
}

export function previousMonthPeriod(now = new Date(), timeZone = 'Asia/Shanghai') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  const year = Number(parts.year)
  const month = Number(parts.month)
  const previous = new Date(Date.UTC(year, month - 2, 1))
  const y = previous.getUTCFullYear()
  const m = String(previous.getUTCMonth() + 1).padStart(2, '0')
  const last = new Date(Date.UTC(y, previous.getUTCMonth() + 1, 0)).getUTCDate()
  return { periodStart: `${y}-${m}-01`, periodEnd: `${y}-${m}-${String(last).padStart(2, '0')}` }
}

export function previousWeekPeriod(now = new Date(), timeZone = 'Asia/Shanghai') {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
  const today = new Date(`${date}T00:00:00.000Z`)
  const mondayOffset = (today.getUTCDay() + 6) % 7
  const currentMonday = new Date(today.getTime() - mondayOffset * 86400000)
  const previousMonday = new Date(currentMonday.getTime() - 7 * 86400000)
  const previousSunday = new Date(currentMonday.getTime() - 86400000)
  return { periodStart: previousMonday.toISOString().slice(0, 10), periodEnd: previousSunday.toISOString().slice(0, 10) }
}

function enumerateDates(start, end) {
  const rows = []
  let current = new Date(`${start}T00:00:00.000Z`)
  const finish = new Date(`${end}T00:00:00.000Z`)
  while (current <= finish) {
    rows.push(current.toISOString().slice(0, 10))
    current = new Date(current.getTime() + 86400000)
  }
  return rows
}

function discoverComponents(record = {}) {
  if (Array.isArray(record.components)) {
    return record.components.map((component) => ({
      key: text(component.key || component.name),
      label: text(component.label || component.name || component.key),
      amountCents: component.amountCents != null ? text(component.amountCents) : toCents(component.amount),
      authority: text(component.authority || 'Payroll authority'),
    }))
  }
  return Object.entries(record)
    .filter(([key, value]) => (
      typeof value === 'number'
      && !NON_COMPONENT_NUMERIC.has(key)
      && /(pay|bonus|subsidy|adjustment|allowance|deduction|commission)/i.test(key)
    ))
    .map(([key, value]) => ({
      key,
      label: COMPONENT_LABELS[key] || key,
      amountCents: toCents(value),
      authority: 'Payroll authority',
    }))
}

function parseShiftHours(time) {
  const match = text(time).match(/(\d{1,2}):(\d{2})\s*[-–—~至]\s*(\d{1,2}):(\d{2})/u)
  if (!match) return null
  const start = Number(match[1]) * 60 + Number(match[2])
  let end = Number(match[3]) * 60 + Number(match[4])
  if (end < start) end += 1440
  return Math.round(((end - start) / 60) * 100) / 100
}

function buildScheduleIndex(schedules) {
  const stable = new Map()
  const legacy = []
  for (const schedule of schedules || []) {
    for (const shift of Array.isArray(schedule.shifts) ? schedule.shifts : []) {
      const employeeId = text(shift?.employeeId).trim()
      const row = { scheduleId: schedule.id, storeKey: schedule.storeKey, date: schedule.date, ...shift }
      if (!employeeId) legacy.push(row)
      else {
        const key = `${employeeId}|${schedule.date}`
        const rows = stable.get(key) || []
        rows.push(row)
        stable.set(key, rows)
      }
    }
  }
  return { stable, legacy }
}

function classifySchedule(actualRows, scheduleRows) {
  if (scheduleRows.length === 0 && actualRows.length === 0) return 'MATCH'
  if (scheduleRows.length === 0) return 'ACTUAL_ONLY'
  if (actualRows.length === 0) return 'SCHEDULE_ONLY'
  const actualStores = new Set(actualRows.map((row) => row.storeKey || row.storeId))
  const scheduleStores = new Set(scheduleRows.map((row) => row.storeKey))
  if ([...actualStores].some((store) => !scheduleStores.has(store))) return 'STORE_CHANGED'
  const plannedHours = scheduleRows.map((row) => parseShiftHours(row.time)).filter((value) => value != null)
  const actualHours = actualRows.reduce((sum, row) => sum + Number(row.payableHours ?? row.actualHours ?? 0), 0)
  if (plannedHours.length > 0 && Math.abs(plannedHours.reduce((a, b) => a + b, 0) - actualHours) > 0.005) return 'HOURS_DIFFERENCE'
  const actualTimes = actualRows.filter((row) => row.actualStartTime || row.actualEndTime)
  if (actualTimes.length > 0 && scheduleRows.some((row) => row.time) && actualTimes.some((row) => !text(scheduleRows[0].time).includes(text(row.actualStartTime)))) return 'SHIFT_CHANGED'
  return 'MATCH'
}

function topResult(results) {
  return results.reduce((top, result) => RESULT_RANK[result] > RESULT_RANK[top] ? result : top, 'PASS')
}

function issueFromBlocker(blocker, employee, index) {
  return {
    id: `ISSUE-${String(index + 1).padStart(3, '0')}`,
    type: text(blocker.reason || blocker.type || 'PAYROLL_AUTHORITY_ERROR'),
    employeeId: employee.employeeId,
    employeeName: employee.employeeName,
    date: isoDate(blocker.date || blocker.businessDate),
    store: text(blocker.storeName || blocker.storeKey || blocker.storeId),
    evidence: text(blocker.detail || blocker.message || 'Payroll authority returned a blocker.'),
    rootCause: text(blocker.reason || 'UNRESOLVED'),
    errorLayer: 'Payroll authority',
    payrollImpact: 'YES',
    amountImpactCents: null,
    options: [
      { label: '方案 A', detail: '核对并确认缺失或冲突的工资权威事实，保持现有数据不变直到事实明确。' },
      { label: '方案 B', detail: '若业务确认权威事实有误，另行批准通过合法历史修订流程处理并保留审计轨迹。' },
    ],
    recommendation: '先完成事实核对，再决定是否另行授权修订。',
    risk: '未经确认修改历史工资事实会造成审计与发放风险。',
    requiredConfirmation: '需要业务负责人确认实际出勤、身份及对应权威记录。',
    actionExecuted: false,
  }
}

export function buildPayrollAuditReportModel(input = {}) {
  const actualModel = text(input.actualModel).trim()
  const actualReasoning = text(input.actualReasoning).trim()
  if (!actualModel || !actualReasoning) {
    throw Object.assign(new Error('Payroll audit execution metadata is required'), { code: 'PAYROLL_AUDIT_EXECUTION_METADATA_REQUIRED' })
  }
  const period = input.period || input.authority?.period || {}
  const result = input.authority?.result || {}
  const payrollRows = Array.isArray(result.payroll?.employees) ? result.payroll.employees : []
  const employeeById = new Map((input.authority?.employees || []).map((employee) => [employee.id, employee]))
  const readinessById = new Map((result.readiness?.employees || []).map((row) => [row.employeeId, row]))
  const payrollById = new Map(payrollRows.map((row) => [row.employeeId, row]))
  const requested = Array.isArray(input.scopeEmployeeIds)
    ? [...new Set(input.scopeEmployeeIds)]
    : [...new Set([...payrollById.keys(), ...readinessById.keys()])]
  const scheduleIndex = buildScheduleIndex(input.schedules || [])
  const rawAttendanceIndex = new Map()
  for (const row of input.attendanceRows || []) {
    if (!row.employeeId) continue
    const key = `${row.employeeId}|${isoDate(row.date)}|${row.storeKey || row.storeId || ''}`
    rawAttendanceIndex.set(key, row)
  }
  const actualByEmployeeDate = new Map()
  const payrollDayByEmployeeDate = new Map()
  for (const payroll of payrollRows) {
    for (const day of payroll.dailyExplanations || []) {
      const date = isoDate(day.date)
      const storeKey = day.storeKey || ''
      const key = `${payroll.employeeId}|${date}`
      const payrollDays = payrollDayByEmployeeDate.get(key) || []
      payrollDays.push(day)
      payrollDayByEmployeeDate.set(key, payrollDays)
      if (day.explanation?.state === 'ADJUSTMENT_ONLY') continue
      const raw = rawAttendanceIndex.get(`${payroll.employeeId}|${date}|${storeKey}`) || {}
      const rows = actualByEmployeeDate.get(key) || []
      rows.push({
        ...raw,
        employeeId: payroll.employeeId,
        date,
        storeKey,
        storeName: day.storeName || input.authority?.storeNames?.[storeKey] || storeKey,
        actualHours: raw.actualHours ?? day.payableHours ?? day.hours,
        payableHours: day.payableHours ?? day.hours,
        payableHoursSource: day.payableHoursSource || raw.payableHoursSource,
      })
      actualByEmployeeDate.set(key, rows)
    }
  }
  const globalBlockers = (result.blockers || []).filter((blocker) => !blocker.employeeId && !(blocker.employeeIds || []).length)
  const dates = enumerateDates(period.periodStart, period.periodEnd)

  const employeeResults = requested.sort().map((employeeId) => {
    const directory = employeeById.get(employeeId) || {}
    const payroll = payrollById.get(employeeId)
    const readiness = readinessById.get(employeeId) || {}
    const employeeName = text(directory.name || payroll?.displayName || employeeId)
    const employee = { employeeId, employeeName }
    const components = payroll ? discoverComponents(payroll) : []
    const dailyComponentKeys = components.map((component) => component.key)
    const blockers = [
      ...(readiness.blockers || []).filter((blocker) => blocker.type === 'CALCULATION_BLOCKER'),
      ...globalBlockers,
    ]
    if (!payroll) blockers.push({ reason: 'PAYROLL_SUBJECT_OUTSIDE_RANGE', detail: '当前 Payroll authority 未返回该员工的周期工资结果。' })
    const authoritativePayrollCents = payroll ? toCents(payroll.salary) : null
    const cardValue = input.cardAmountCentsById?.[employeeId]
    const employeeCardCents = cardValue == null ? authoritativePayrollCents : text(cardValue)
    const differenceCents = authoritativePayrollCents == null || employeeCardCents == null
      ? null
      : (centsBigInt(employeeCardCents) - centsBigInt(authoritativePayrollCents)).toString()
    const dailyReconciliation = dates.map((date) => {
      const actual = actualByEmployeeDate.get(`${employeeId}|${date}`) || []
      const planned = scheduleIndex.stable.get(`${employeeId}|${date}`) || []
      const payrollDays = payrollDayByEmployeeDate.get(`${employeeId}|${date}`) || []
      const classification = classifySchedule(actual, planned)
      const payrollComponents = Object.fromEntries(dailyComponentKeys.map((component) => [
        component,
        addCents(payrollDays.filter((day) => typeof day?.[component] === 'number').map((day) => toCents(day[component]))),
      ]))
      const dailyTotalComplete = payrollDays.every((day) => typeof day?.finalPay === 'number')
      return {
        date,
        stores: [...new Set(actual.map((row) => row.storeName || input.authority?.storeNames?.[row.storeKey || row.storeId] || row.storeKey || row.storeId))],
        planned: planned.map((row) => ({ storeKey: row.storeKey, time: text(row.time), staff: text(row.staff) })),
        actual: actual.map((row) => ({ storeKey: row.storeKey || row.storeId, actualHours: row.actualHours, payableHours: row.payableHours, authority: row.payableHoursSource })),
        payableHours: actual.reduce((sum, row) => sum + Number(row.payableHours ?? row.actualHours ?? 0), 0),
        authority: actual.length ? [...new Set(actual.map((row) => row.payableHoursSource || ''))].filter(Boolean).join(', ') : '',
        scheduleResult: classification,
        payrollImpact: classification === 'UNRESOLVED' ? 'UNKNOWN' : 'NO',
        result: payrollDays.some((day) => day?.explanation?.state === 'ADJUSTMENT_ONLY') ? 'ADJUSTMENT_ONLY' : actual.length ? 'AUDITED' : 'NO_ACTUAL_ATTENDANCE',
        payroll: {
          source: 'Payroll authority dailyExplanations',
          complete: dailyTotalComplete,
          totalCents: dailyTotalComplete ? addCents(payrollDays.map((day) => toCents(day.finalPay))) : null,
          components: payrollComponents,
        },
      }
    })
    const issues = blockers.map((blocker, index) => issueFromBlocker(blocker, employee, index))
    if (differenceCents != null && differenceCents !== '0') {
      issues.push({
        id: `ISSUE-${String(issues.length + 1).padStart(3, '0')}`,
        type: 'EMPLOYEE_CARD_PROJECTION_ERROR', employeeId, employeeName, date: '', store: '',
        evidence: `员工卡片与 Payroll authority 相差 ${formatCents(differenceCents)}。`,
        rootCause: 'Employee card projection requires reconciliation.', errorLayer: 'Employee Card projection',
        payrollImpact: 'NO', amountImpactCents: differenceCents,
        options: [
          { label: '方案 A', detail: '确认卡片缓存或 DTO projection 是否使用同一周期和同一 Employee.id。' },
          { label: '方案 B', detail: '如权威投影确有缺陷，另行批准修复投影；不得修改工资事实来迎合卡片。' },
        ],
        recommendation: '以 Payroll authority 为准，先修正或刷新卡片 projection。',
        risk: '直接修改工资事实会掩盖展示层错误。', requiredConfirmation: '确认员工卡片请求周期与当前审计周期一致。', actionExecuted: false,
      })
    }
    if (input.employmentTypeHistoryAvailable === false) {
      issues.push({
        id: `ISSUE-${String(issues.length + 1).padStart(3, '0')}`,
        type: 'EMPLOYMENT_TYPE_HISTORY_UNAVAILABLE', employeeId, employeeName, date: '', store: '',
        evidence: `当前 Employee.employmentType=${text(directory.type || directory.employmentType)}；系统没有有效期历史，无法独立证明该类型覆盖整个审查期间。`,
        rootCause: 'Employment type is current-state only.', errorLayer: 'Employee authority', payrollImpact: 'UNKNOWN', amountImpactCents: null,
        options: [{ label: '方案 A', detail: '由负责人核对该员工在本期内的实际用工类型；本报告不自动改写身份。' }],
        recommendation: '确认历史用工类型后再据此使用审查结论。', risk: '把当前类型当作历史类型可能造成周报/月报归属错误。',
        requiredConfirmation: '需要负责人确认该员工在完整审查期间的用工类型。', actionExecuted: false,
      })
    }
    const status = blockers.length ? 'BLOCKED' : (differenceCents !== '0' || input.employmentTypeHistoryAvailable === false) ? 'REVIEW_REQUIRED' : 'PASS'
    const scheduleStatus = dailyReconciliation.some((row) => row.scheduleResult !== 'MATCH') ? 'REVIEW' : 'PASS'
    const dailyPayrollTotalCents = addCents(dailyReconciliation.map((day) => day.payroll?.totalCents).filter((value) => value != null))
    const dailyComponentTotals = Object.fromEntries(dailyComponentKeys.map((component) => [
      component,
      addCents(dailyReconciliation.map((day) => day.payroll?.components?.[component]).filter((value) => value != null)),
    ]))
    const componentTotalsMatch = components.every((component) => (
      dailyComponentTotals[component.key] === component.amountCents
    ))
    const dailyPayrollBreakdownComplete = Boolean(payroll)
      && dailyReconciliation.every((day) => day.payroll?.complete === true)
      && dailyPayrollTotalCents === authoritativePayrollCents
      && componentTotalsMatch
    return {
      employeeId,
      employeeNo: text(directory.employeeNo),
      employeeName,
      employmentType: text(directory.type || directory.employmentType),
      businessRole: employeeName === '卡皮巴拉' ? '老板替班' : text(directory.position || ''),
      status,
      scheduleStatus,
      payableHours: payroll ? Number(payroll.payableHours ?? payroll.hours ?? 0) : null,
      authoritativePayrollCents,
      employeeCardCents,
      differenceCents,
      components,
      dailyReconciliation,
      dailyPayrollBreakdownComplete,
      dailyPayrollBreakdownReason: dailyPayrollBreakdownComplete ? '' : 'MONTH_BOUNDARY_SOURCE_INSUFFICIENT',
      issues,
    }
  })

  const finalResult = topResult(employeeResults.map((row) => row.status))
  const summary = {
    employeeCount: employeeResults.length,
    passCount: employeeResults.filter((row) => row.status === 'PASS').length,
    reviewRequiredCount: employeeResults.filter((row) => row.status === 'REVIEW_REQUIRED').length,
    blockedCount: employeeResults.filter((row) => row.status === 'BLOCKED').length,
    issueCount: employeeResults.reduce((sum, row) => sum + row.issues.length, 0),
    authoritativePayrollCents: addCents(employeeResults.map((row) => row.authoritativePayrollCents).filter((value) => value != null)),
    employeeCardCents: addCents(employeeResults.map((row) => row.employeeCardCents).filter((value) => value != null)),
    differenceCents: addCents(employeeResults.map((row) => row.differenceCents).filter((value) => value != null)),
    finalResult,
    settlementRecommendation: finalResult === 'PASS' ? '可以进入独立结算复核' : '暂不建议进入结算',
  }
  const identityInput = {
    periodStart: period.periodStart, periodEnd: period.periodEnd,
    auditMode: input.auditMode || 'FINAL', scope: requested,
    reportType: input.reportType || 'MONTHLY_FULL_TIME',
    employeeType: input.employeeType || '',
    productionSha: input.productionSha, authorityDigest: input.authorityDigest,
    actualModel, actualReasoning,
    source: PAYROLL_AUDIT_SOURCE,
    reportContractVersion: 6,
    brandAssetSha256: WORDMARK_SHA256,
  }
  const runId = input.runId || auditHash(identityInput).slice(0, 24)
  const model = {
    schemaVersion: 6,
    runId,
    metadata: {
      generatedAt: input.generatedAt || new Date().toISOString(),
      actualModel,
      actualReasoning,
      source: PAYROLL_AUDIT_SOURCE,
      productionSha: text(input.productionSha),
      authority: input.authorityName || 'budu Payroll authority',
      brand: { name: 'budu', wordmarkSha256: WORDMARK_SHA256 },
      requestedPeriod: { start: period.periodStart, end: period.periodEnd },
      effectivePeriod: { start: period.periodStart, end: period.periodEnd },
      auditMode: input.auditMode || 'FINAL',
      scope: input.scope || 'ALL',
      reportType: input.reportType || 'MONTHLY_FULL_TIME',
      employeeType: input.employeeType || '',
      employmentTypeAuthority: input.employmentTypeAuthority || 'Employee.employmentType',
      employmentTypeHistoryAvailable: input.employmentTypeHistoryAvailable !== false,
      timeZone: input.timeZone || 'Asia/Shanghai',
      authorityDigest: text(input.authorityDigest),
    },
    summary,
    employeeResults,
    legacyScheduleIdentityCount: scheduleIndex.legacy.length,
    finalRecommendation: summary.settlementRecommendation,
    actionExecuted: false,
    safetyStatement: '本报告仅做审查，未执行任何数据修改。',
  }
  model.canonicalHash = auditHash({ ...model, metadata: { ...model.metadata, generatedAt: '' } })
  return model
}

export function renderPayrollAuditMarkdown(model) {
  const m = model.metadata
  const s = model.summary
  const lines = [
    `# ${m.reportType === 'WEEKLY_PART_TIME' ? 'budu 兼职员工周薪酬审查报告' : 'budu 全职员工月度薪酬审查报告'}`, '',
    `审查周期：${m.requestedPeriod.start} ～ ${m.requestedPeriod.end}`,
    `审查结果：${payrollAuditDisplayLabel(s.finalResult, 'cover')}`,
    `审查员工：${s.employeeCount} 人`,
    `通过 / 需人工复核 / 审查阻断：${s.passCount} / ${s.reviewRequiredCount} / ${s.blockedCount}`,
    `薪酬权威合计：${formatCents(s.authoritativePayrollCents)}`,
    `员工薪酬卡片合计：${formatCents(s.employeeCardCents)}`,
    `总差额：${formatCents(s.differenceCents)}`,
    `需关注问题：${s.issueCount} 项`,
    `结算建议：${s.settlementRecommendation}`, '',
    model.safetyStatement, '',
    '## 管理层总览', '',
    '| 员工 | 业务角色 | 实际工时 | 权威工资 | 卡片金额 | 差额 | 结果 |',
    '|---|---|---:|---:|---:|---:|---|',
    ...model.employeeResults.map((row) => `| ${row.employeeName} | ${row.businessRole || '—'} | ${row.payableHours ?? '—'} | ${formatCents(row.authoritativePayrollCents)} | ${formatCents(row.employeeCardCents)} | ${formatCents(row.differenceCents)} | ${payrollAuditDisplayLabel(row.status)} |`),
  ]
  for (const employee of model.employeeResults) {
    lines.push('', `## 员工薪酬审查：${employee.employeeName}`, '',
      `业务角色：${employee.businessRole || '—'}`,
      `薪酬计算：${payrollAuditDisplayLabel(employee.status === 'BLOCKED' ? 'BLOCKED' : employee.differenceCents === '0' ? 'PASS' : 'MISMATCH')}`,
      `排班对照：${payrollAuditDisplayLabel(employee.scheduleStatus)}`,
      `最终审查：${payrollAuditDisplayLabel(employee.status)}`, '',
      '### 薪酬组成', '',
      '| 项目 | 金额 | 权威来源 |', '|---|---:|---|')
    for (const component of employee.components) lines.push(`| ${component.label} | ${formatCents(component.amountCents)} | ${displayAuthority(component.authority)} |`)
    lines.push(`| 最终应发 | ${formatCents(employee.authoritativePayrollCents)} | 薪酬权威 |`, '',
      '### 逐日事实与排班对照', '',
      '| 日期 | 计划排班 | 实际出勤 | 对照结果 |', '|---|---|---|---|')
    for (const day of employee.dailyReconciliation) {
      const planned = day.planned.length ? day.planned.map((row) => `${displayStoreName(row)} ${row.time}`.trim()).join('；') : '无排班'
      const actual = day.actual.length ? day.actual.map((row) => `${displayStoreName(row)} ${row.payableHours ?? row.actualHours ?? 0}小时`).join('；') : '无实际出勤'
      lines.push(`| ${day.date} | ${planned} | ${actual} | ${payrollAuditDisplayLabel(day.scheduleResult)} |`)
    }
    lines.push('', '### 异常与处理建议', '')
    if (!employee.issues.length) lines.push('未发现异常。')
    for (const issue of employee.issues) {
      const presented = issuePresentation(issue, employee)
      lines.push(`#### 异常 ${issue.id.replace('ISSUE-', '')}：${presented.title}`, '',
        `- 问题：${presented.problem}`, `- 系统依据：${presented.basis}`,
        `- 对薪酬的影响：${payrollAuditDisplayLabel(issue.payrollImpact)}${issue.amountImpactCents == null ? '' : ` · ${formatCents(issue.amountImpactCents)}`}`,
        ...issue.options.map((option) => `- ${option.label}：${option.detail}`),
        `- 建议：${issue.recommendation}`, `- 风险：${issue.risk}`, `- 需要确认：${issue.requiredConfirmation}`, '- 本次未自动处理',
        `- 技术追溯：${issue.type}`)
    }
  }
  lines.push('', '## 最终审查结论', '',
    `薪酬权威：${payrollAuditDisplayLabel(s.blockedCount ? 'FAIL' : 'PASS')}`,
    `员工薪酬卡片：${payrollAuditDisplayLabel(s.reviewRequiredCount ? 'MISMATCH' : 'PASS')}`,
    `排班对照：${payrollAuditDisplayLabel(model.employeeResults.some((row) => row.scheduleStatus === 'REVIEW') ? 'REVIEW' : 'PASS')}`,
    `需关注问题：${s.issueCount} 项`, `最终审查：${payrollAuditDisplayLabel(s.finalResult, 'cover')}`, `建议：${model.finalRecommendation}`, '',
    '**本次未自动处理**', '', model.safetyStatement, '',
    `技术追溯：Run ID ${model.runId} · Canonical hash ${model.canonicalHash} · Production SHA ${m.productionSha}`)
  return lines.join('\n')
}

export function renderPayrollAuditEmail(model) {
  const { summary: s, metadata: m } = model
  const [year, month] = m.requestedPeriod.start.slice(0, 7).split('-')
  const weekly = m.reportType === 'WEEKLY_PART_TIME'
  const title = weekly ? 'budu 兼职员工薪酬审查报告' : 'budu 全职员工薪酬审查报告'
  const periodLabel = weekly ? `${m.requestedPeriod.start} ～ ${m.requestedPeriod.end}` : `${year}年${month}月`
  const priority = model.employeeResults.flatMap((row) => row.issues.map((issue) => `${row.employeeName}：${issuePresentation(issue, row).title}`)).slice(0, 3)
  const subject = `${title}｜${periodLabel}｜${payrollAuditDisplayLabel(s.finalResult, 'cover')}`
  const body = [
    title, periodLabel, '', `结果：${payrollAuditDisplayLabel(s.finalResult, 'cover')}`, '',
    `审查员工：${s.employeeCount} 人`, `通过：${s.passCount}`, `需人工复核：${s.reviewRequiredCount}`, `审查阻断：${s.blockedCount}`, '',
    `权威工资：${formatCents(s.authoritativePayrollCents)}`, `员工卡片：${formatCents(s.employeeCardCents)}`, `差额：${formatCents(s.differenceCents)}`, '',
    `本期发现：${s.issueCount} 项需关注问题`, ...(priority.length ? ['', '重点问题：', ...priority.map((item, index) => `${index + 1}. ${item}`)] : []), '',
    `建议：${s.settlementRecommendation}`, '', '未修改任何生产数据。', '完整证据、逐日明细和解决方案见附件。', '', `Run ID: ${model.runId}`,
  ].join('\n')
  const recipients = ['yuegu1995@gmail.com', '970701330@qq.com', 'korea_jing@163.com']
  return { subject, body, recipient: recipients[0], recipients, runId: model.runId, canonicalHash: model.canonicalHash }
}

function escapeHtml(value) {
  return text(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

export function payrollAuditSourceMark(model) {
  return `由 budu Payroll Audit Automation 生成 · 来源：${PAYROLL_AUDIT_SOURCE} · 模型：${text(model?.metadata?.actualModel)} / ${text(model?.metadata?.actualReasoning)}`
}

export function renderPayrollAuditHtml(model) {
  const s = model.summary
  const statusClass = s.finalResult.toLowerCase().replace('_', '-')
  const employeeSections = model.employeeResults.map((employee) => {
    const dayCards = employee.dailyReconciliation.map((day) => {
      const planned = day.planned.length ? day.planned.map((row) => `${displayStoreName(row)} ${row.time}`.trim()).join('；') : '无排班'
      const actual = day.actual.length ? day.actual.map((row) => `${displayStoreName(row)} ${row.payableHours ?? row.actualHours ?? 0}小时`).join('；') : '无实际出勤'
      const technical = day.scheduleResult === 'MATCH' ? '' : `<small class="technical-code">${escapeHtml(day.scheduleResult)}</small>`
      return `<div class="day-row"><div><b>${escapeHtml(day.date)}</b><span>${escapeHtml(day.stores.join('、') || payrollAuditDisplayLabel(day.result))}</span></div><div><span><b>计划排班</b> ${escapeHtml(planned)}</span><span><b>实际出勤</b> ${escapeHtml(actual)}</span></div><div class="day-result"><strong class="tag ${day.scheduleResult === 'MATCH' ? 'pass' : 'review-required'}">${escapeHtml(payrollAuditDisplayLabel(day.scheduleResult))}</strong>${technical}</div></div>`
    }).join('')
    const issues = employee.issues.length ? employee.issues.map((issue) => {
      const presented = issuePresentation(issue, employee)
      return `<article class="issue"><h4><span>异常 ${escapeHtml(issue.id.replace('ISSUE-', ''))}</span>${escapeHtml(presented.title)}</h4><p><b>问题</b>${escapeHtml(presented.problem)}</p><p><b>系统依据</b>${escapeHtml(presented.basis)}</p><p><b>对薪酬的影响</b>${escapeHtml(payrollAuditDisplayLabel(issue.payrollImpact))}${issue.amountImpactCents == null ? '' : ` · ${escapeHtml(formatCents(issue.amountImpactCents))}`}</p><div class="options"><b>可选处理方案</b>${issue.options.map((option) => `<p>${escapeHtml(option.label)}：${escapeHtml(option.detail)}</p>`).join('')}</div><p><b>建议</b>${escapeHtml(issue.recommendation)}</p><p><b>风险</b>${escapeHtml(issue.risk)}</p><p><b>需要确认</b>${escapeHtml(issue.requiredConfirmation)}</p><p class="no-action">本次未自动处理</p><p class="technical-code">技术追溯：${escapeHtml(issue.type)}</p></article>`
    }).join('') : '<p class="empty">未发现异常。</p>'
    return `<section class="employee page-break"><header class="section-head"><div><p class="eyebrow">员工薪酬审查</p><h2>${escapeHtml(employee.employeeName)}</h2><p>${employee.businessRole ? escapeHtml(employee.businessRole) : '本周期薪酬审查'}</p></div><span class="status ${employee.status.toLowerCase().replace('_', '-')}">${escapeHtml(payrollAuditDisplayLabel(employee.status))}</span></header><div class="kpis"><div><span>实际工时</span><b>${employee.payableHours ?? '—'}小时</b></div><div><span>薪酬权威</span><b>${escapeHtml(formatCents(employee.authoritativePayrollCents))}</b></div><div><span>员工薪酬卡片</span><b>${escapeHtml(formatCents(employee.employeeCardCents))}</b></div><div><span>差额</span><b>${escapeHtml(formatCents(employee.differenceCents))}</b></div></div><h3>薪酬组成</h3><div class="component-list">${employee.components.map((component) => `<div><span>${escapeHtml(component.label)}</span><b>${escapeHtml(formatCents(component.amountCents))}</b><small>${escapeHtml(displayAuthority(component.authority))}</small></div>`).join('')}<div class="total"><span>最终应发</span><b>${escapeHtml(formatCents(employee.authoritativePayrollCents))}</b><small>薪酬权威</small></div></div><h3>逐日事实与排班对照</h3><div class="day-list">${dayCards}</div><h3>异常与处理建议</h3>${issues}</section>`
  }).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  @page{size:A4 portrait;margin:14mm 13mm 16mm}*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d2733;font:13px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif}main{max-width:184mm;margin:auto}.cover{min-height:260mm;display:flex;flex-direction:column;justify-content:space-between;padding:18mm 12mm;background:#fff;border-radius:18px}.brand-wordmark{display:block;width:42mm;height:auto}.cover h1{font-size:30px;margin:20px 0 4px}.cover .period{font-size:18px;color:#536273}.source-mark{max-width:150mm;margin:12px 0 0;color:#7a8695;font-size:9px;line-height:1.45}.status{display:inline-flex;border-radius:999px;padding:7px 12px;font-weight:700;font-size:11px}.status.pass,.tag.pass{background:#e8f7ee;color:#187a43}.status.review-required,.tag.review-required{background:#fff3de;color:#a15c00}.status.blocked,.tag.blocked{background:#ffe8e8;color:#b42318}.hero-status{font-size:34px;font-weight:700;letter-spacing:-.04em}.hero-status.pass{color:#187a43}.hero-status.review-required{color:#b56b08}.hero-status.blocked{color:#b42318}.kpis{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:18px 0}.kpis>div{background:#fff;border:1px solid #e6e8ec;border-radius:14px;padding:13px}.kpis span{display:block;color:#697586;font-size:11px}.kpis b{display:block;margin-top:4px;font-size:18px;color:#243140}.safety{border-left:3px solid #d84f86;padding:10px 12px;background:#fff5f8;border-radius:8px;color:#693246}.page-break{break-before:page}.section-head{display:flex;justify-content:space-between;align-items:flex-start;margin:4px 0 16px}.section-head h2{font-size:26px;margin:2px 0}.section-head p{margin:0;color:#697586}.eyebrow{color:#d84f86!important;font-size:10px;font-weight:700;letter-spacing:.12em}h3{font-size:16px;margin:20px 0 9px}.overview{background:#fff;border-radius:16px;padding:16px;margin-top:14px}.overview-row{display:grid;grid-template-columns:1.4fr .8fr 1fr 1fr .8fr .9fr;gap:7px;padding:9px 0;border-bottom:1px solid #eceef1;align-items:center}.overview-row:last-child{border:0}.overview-row.head{font-size:10px;color:#697586;font-weight:700}.component-list>div{display:grid;grid-template-columns:1.4fr .8fr 1fr;gap:8px;background:#fff;border-bottom:1px solid #eceef1;padding:9px 11px}.component-list>div:first-child{border-radius:12px 12px 0 0}.component-list>div:last-child{border-radius:0 0 12px 12px;border-bottom:0}.component-list small{color:#7a8695}.component-list .total{background:#fff4f8}.day-row{display:grid;grid-template-columns:1fr 2.15fr 1fr;gap:10px;align-items:center;background:#fff;border-bottom:1px solid #eceef1;padding:9px 11px;break-inside:avoid}.day-row:first-child{border-radius:12px 12px 0 0}.day-row:last-child{border-radius:0 0 12px 12px;border:0}.day-row span{display:block;color:#667384;font-size:11px}.day-row span b{display:inline;color:#3c4858;margin-right:4px}.day-result{text-align:right}.day-result .technical-code{display:block;margin-top:3px}.tag{display:inline-block;border-radius:999px;padding:4px 7px;font-size:9px}.issue{background:#fff8ed;border:1px solid #f2d6a7;border-radius:14px;padding:13px;margin-bottom:10px;break-inside:avoid}.issue h4{margin:0 0 10px;color:#6f4308;font-size:15px}.issue h4 span{display:block;color:#a56b19;font-size:9px;letter-spacing:.08em;margin-bottom:2px}.issue p{margin:6px 0}.issue p b{display:block;color:#566273;font-size:10px}.options{margin:8px 0;padding:9px 10px;background:#fff;border-radius:9px}.options>b{font-size:10px;color:#566273}.options p{margin:3px 0}.no-action{font-weight:700;color:#8b3c18}.technical-code{color:#929aa6!important;font:8px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.empty{color:#667384}.conclusion{min-height:250mm;display:flex;flex-direction:column;justify-content:center}.conclusion h2{font-size:28px}.footer-note{margin-top:22px;padding:16px;border-radius:14px;background:#fff5f8;border:1px solid #f3cfdd;color:#693246;font-weight:700}
  </style></head><body><main><section class="cover"><div><img class="brand-wordmark" src="${WORDMARK_DATA_URI}" alt="budu"><h1>薪酬审查报告</h1><p class="period">审查周期：${escapeHtml(model.metadata.requestedPeriod.start)} ～ ${escapeHtml(model.metadata.requestedPeriod.end)}</p><p class="source-mark" data-payroll-source-mark="true">${escapeHtml(payrollAuditSourceMark(model))}</p></div><div><p>最终审查</p><div class="hero-status ${statusClass}">${escapeHtml(payrollAuditDisplayLabel(s.finalResult, 'cover'))}</div><div class="kpis"><div><span>审查员工</span><b>${s.employeeCount} 人</b></div><div><span>薪酬权威</span><b>${escapeHtml(formatCents(s.authoritativePayrollCents))}</b></div><div><span>员工薪酬卡片</span><b>${escapeHtml(formatCents(s.employeeCardCents))}</b></div><div><span>总差额</span><b>${escapeHtml(formatCents(s.differenceCents))}</b></div><div><span>需关注问题</span><b>${s.issueCount} 项</b></div><div><span>结算建议</span><b>${escapeHtml(s.settlementRecommendation)}</b></div></div></div><p class="safety">${escapeHtml(model.safetyStatement)}</p></section><section class="page-break"><p class="eyebrow">管理层总览</p><h2>管理层总览</h2><div class="overview"><div class="overview-row head"><span>员工</span><span>工时</span><span>薪酬权威</span><span>薪酬卡片</span><span>差额</span><span>结果</span></div>${model.employeeResults.map((row) => `<div class="overview-row"><span><b>${escapeHtml(row.employeeName)}</b>${row.businessRole ? `<small> · ${escapeHtml(row.businessRole)}</small>` : ''}</span><span>${row.payableHours ?? '—'}小时</span><span>${escapeHtml(formatCents(row.authoritativePayrollCents))}</span><span>${escapeHtml(formatCents(row.employeeCardCents))}</span><span>${escapeHtml(formatCents(row.differenceCents))}</span><span class="tag ${row.status.toLowerCase().replace('_', '-')}">${escapeHtml(payrollAuditDisplayLabel(row.status))}</span></div>`).join('')}</div></section>${employeeSections}<section class="conclusion page-break"><p class="eyebrow">最终审查结论</p><h2>最终审查结论</h2><div class="component-list"><div><span>薪酬权威</span><b>${payrollAuditDisplayLabel(s.blockedCount ? 'FAIL' : 'PASS')}</b><small>${escapeHtml(displayAuthority(model.metadata.authority))}</small></div><div><span>员工薪酬卡片</span><b>${payrollAuditDisplayLabel(s.reviewRequiredCount ? 'MISMATCH' : 'PASS')}</b><small>员工薪酬卡片</small></div><div><span>排班对照</span><b>${payrollAuditDisplayLabel(model.employeeResults.some((row) => row.scheduleStatus === 'REVIEW') ? 'REVIEW' : 'PASS')}</b><small>计划对照，不作为工资事实</small></div><div><span>需关注问题</span><b>${s.issueCount} 项</b><small>请按员工明细逐项核对</small></div><div class="total"><span>最终审查</span><b>${escapeHtml(payrollAuditDisplayLabel(s.finalResult, 'cover'))}</b><small>${escapeHtml(model.finalRecommendation)}</small></div></div><div class="footer-note">本报告仅做薪酬审查。本次未自动处理，也未修改任何历史或生产数据。</div></section></main></body></html>`
}
