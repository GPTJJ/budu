import crypto from 'node:crypto'
import fs from 'node:fs'

const WORDMARK_SVG = fs.readFileSync(new URL('../brand/web/budu-wordmark.svg', import.meta.url), 'utf8')
const WORDMARK_SHA256 = crypto.createHash('sha256').update(WORDMARK_SVG).digest('hex')
const WORDMARK_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(WORDMARK_SVG).toString('base64')}`

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

const text = (value) => String(value == null ? '' : value)
const isoDate = (value) => text(value).slice(0, 10)
const toCents = (yuan) => String(Math.round(Number(yuan || 0) * 100))
const centsBigInt = (value) => BigInt(text(value || '0'))
const addCents = (values) => values.reduce((sum, value) => sum + centsBigInt(value), 0n).toString()

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
  const period = input.period || input.authority?.period || {}
  const result = input.authority?.result || {}
  const payrollRows = Array.isArray(result.payroll?.employees) ? result.payroll.employees : []
  const employeeById = new Map((input.authority?.employees || []).map((employee) => [employee.id, employee]))
  const readinessById = new Map((result.readiness?.employees || []).map((row) => [row.employeeId, row]))
  const payrollById = new Map(payrollRows.map((row) => [row.employeeId, row]))
  const requested = input.scopeEmployeeIds?.length
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
      payrollDayByEmployeeDate.set(key, day)
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
      const payrollDay = payrollDayByEmployeeDate.get(`${employeeId}|${date}`)
      const classification = classifySchedule(actual, planned)
      return {
        date,
        stores: [...new Set(actual.map((row) => row.storeName || input.authority?.storeNames?.[row.storeKey || row.storeId] || row.storeKey || row.storeId))],
        planned: planned.map((row) => ({ storeKey: row.storeKey, time: text(row.time), staff: text(row.staff) })),
        actual: actual.map((row) => ({ storeKey: row.storeKey || row.storeId, actualHours: row.actualHours, payableHours: row.payableHours, authority: row.payableHoursSource })),
        payableHours: actual.reduce((sum, row) => sum + Number(row.payableHours ?? row.actualHours ?? 0), 0),
        authority: actual.length ? [...new Set(actual.map((row) => row.payableHoursSource || ''))].filter(Boolean).join(', ') : '',
        scheduleResult: classification,
        payrollImpact: classification === 'UNRESOLVED' ? 'UNKNOWN' : 'NO',
        result: payrollDay?.explanation?.state === 'ADJUSTMENT_ONLY' ? 'ADJUSTMENT_ONLY' : actual.length ? 'AUDITED' : 'NO_ACTUAL_ATTENDANCE',
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
    const status = blockers.length ? 'BLOCKED' : differenceCents !== '0' ? 'REVIEW_REQUIRED' : 'PASS'
    const scheduleStatus = dailyReconciliation.some((row) => row.scheduleResult !== 'MATCH') ? 'REVIEW' : 'PASS'
    return {
      employeeId,
      employeeNo: text(directory.employeeNo),
      employeeName,
      businessRole: employeeName === '卡皮巴拉' ? '老板替班' : text(directory.position || ''),
      status,
      scheduleStatus,
      payableHours: payroll ? Number(payroll.payableHours ?? payroll.hours ?? 0) : null,
      authoritativePayrollCents,
      employeeCardCents,
      differenceCents,
      components: payroll ? discoverComponents(payroll) : [],
      dailyReconciliation,
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
    productionSha: input.productionSha, authorityDigest: input.authorityDigest,
    reportContractVersion: 3,
    brandAssetSha256: WORDMARK_SHA256,
  }
  const runId = input.runId || auditHash(identityInput).slice(0, 24)
  const model = {
    schemaVersion: 3,
    runId,
    metadata: {
      generatedAt: input.generatedAt || new Date().toISOString(),
      productionSha: text(input.productionSha),
      authority: input.authorityName || 'budu Payroll authority',
      brand: { name: 'budu', wordmarkSha256: WORDMARK_SHA256 },
      requestedPeriod: { start: period.periodStart, end: period.periodEnd },
      effectivePeriod: { start: period.periodStart, end: period.periodEnd },
      auditMode: input.auditMode || 'FINAL',
      scope: input.scope || 'ALL',
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
    '# budu 薪酬审查报告', '',
    `Run ID: ${model.runId}`,
    `Scope: ${m.scope}`,
    `Requested period: ${m.requestedPeriod.start} → ${m.requestedPeriod.end}`,
    `Effective audit period: ${m.effectivePeriod.start} → ${m.effectivePeriod.end}`,
    `Audit mode: ${m.auditMode}`,
    `Production SHA: ${m.productionSha}`,
    `Canonical hash: ${model.canonicalHash}`,
    `Authority: ${m.authority}`,
    `Generated at: ${m.generatedAt}`, '',
    '## Management Summary', '',
    `Final result: ${s.finalResult}`,
    `Employees: ${s.employeeCount}`,
    `PASS / REVIEW_REQUIRED / BLOCKED: ${s.passCount} / ${s.reviewRequiredCount} / ${s.blockedCount}`,
    `Authoritative payroll: ${formatCents(s.authoritativePayrollCents)}`,
    `Employee card: ${formatCents(s.employeeCardCents)}`,
    `Difference (Employee card - Authority): ${formatCents(s.differenceCents)}`,
    `Issues: ${s.issueCount}`,
    `Recommendation: ${s.settlementRecommendation}`,
    `Data modified: NO`, '',
    model.safetyStatement, '',
    '## Employee Overview', '',
    '| 员工 | 业务角色 | 实际工时 | 权威工资 | 卡片金额 | 差额 | 结果 |',
    '|---|---|---:|---:|---:|---:|---|',
    ...model.employeeResults.map((row) => `| ${row.employeeName} | ${row.businessRole || '—'} | ${row.payableHours ?? '—'} | ${formatCents(row.authoritativePayrollCents)} | ${formatCents(row.employeeCardCents)} | ${formatCents(row.differenceCents)} | ${row.status} |`),
  ]
  for (const employee of model.employeeResults) {
    lines.push('', `## ${employee.employeeName}`, '',
      `Employee ID: ${employee.employeeId}`,
      `Business role: ${employee.businessRole || '—'}`,
      `Payroll calculation: ${employee.status === 'BLOCKED' ? 'BLOCKED' : employee.differenceCents === '0' ? 'PASS' : 'MISMATCH'}`,
      `Schedule reconciliation: ${employee.scheduleStatus}`,
      `Final audit result: ${employee.status}`, '',
      '### Payroll Components', '',
      '| Component | Amount | Authority |', '|---|---:|---|')
    for (const component of employee.components) lines.push(`| ${component.label} | ${formatCents(component.amountCents)} | ${component.authority} |`)
    lines.push(`| Total | ${formatCents(employee.authoritativePayrollCents)} | Payroll authority |`, '',
      '### Daily Reconciliation', '',
      '| 日期 | 门店 | 计划排班 | 实际值班 | actualHours | Authority | 结果 |', '|---|---|---|---|---:|---|---|')
    for (const day of employee.dailyReconciliation) {
      const planned = day.planned.length ? day.planned.map((row) => `${row.storeKey} ${row.time}`.trim()).join('；') : '—'
      const actual = day.actual.length ? day.actual.map((row) => `${row.storeKey} ${row.payableHours ?? row.actualHours ?? 0}h`).join('；') : 'NO_ACTUAL_ATTENDANCE'
      lines.push(`| ${day.date} | ${day.stores.join('、') || '—'} | ${planned} | ${actual} | ${day.payableHours} | ${day.authority || '—'} | ${day.scheduleResult}${day.scheduleResult !== 'MATCH' ? '（Payroll impact: NO）' : ''} |`)
    }
    lines.push('', '### Issues', '')
    if (!employee.issues.length) lines.push('NONE')
    for (const issue of employee.issues) {
      lines.push(`#### ${issue.id}`, '', `Type: ${issue.type}`, `Evidence: ${issue.evidence}`, `Root cause: ${issue.rootCause}`,
        `Error layer: ${issue.errorLayer}`, `Payroll impact: ${issue.payrollImpact}`, `Amount impact: ${formatCents(issue.amountImpactCents)}`, '',
        '### Resolution Options', '', ...issue.options.map((option) => `- ${option.label}: ${option.detail}`),
        `- Recommended: ${issue.recommendation}`, `- Risk: ${issue.risk}`, `- Required confirmation: ${issue.requiredConfirmation}`, '- NO ACTION EXECUTED')
    }
  }
  lines.push('', '## FINAL AUDIT CONCLUSION', '',
    `Payroll Authority: ${s.blockedCount ? 'FAIL' : 'PASS'}`,
    `Employee Card: ${s.reviewRequiredCount ? 'MISMATCH' : 'PASS'}`,
    `Schedule Reconciliation: ${model.employeeResults.some((row) => row.scheduleStatus === 'REVIEW') ? 'REVIEW' : 'PASS'}`,
    `Issues: ${s.issueCount}`, `Final Result: ${s.finalResult}`, `Recommendation: ${model.finalRecommendation}`, '',
    '**NO ACTION EXECUTED**', '', model.safetyStatement, '')
  return lines.join('\n')
}

export function renderPayrollAuditEmail(model) {
  const { summary: s, metadata: m } = model
  const period = m.requestedPeriod.start.slice(0, 7)
  const [year, month] = period.split('-')
  const priority = model.employeeResults.flatMap((row) => row.issues.map((issue) => `${row.employeeName}：${issue.type}`)).slice(0, 3)
  const subject = `budu｜${year}年${month}月薪酬审查报告｜${s.finalResult.replace('_', ' ')}`
  const body = [
    `budu｜${year}年${month}月薪酬审查`, '', `结果：${s.finalResult.replace('_', ' ')}`, '',
    `审查员工：${s.employeeCount} 人`, `PASS：${s.passCount}`, `REVIEW_REQUIRED：${s.reviewRequiredCount}`, `BLOCKED：${s.blockedCount}`, '',
    `权威工资：${formatCents(s.authoritativePayrollCents)}`, `员工卡片：${formatCents(s.employeeCardCents)}`, `差额：${formatCents(s.differenceCents)}`, '',
    `本月发现：${s.issueCount} 项需关注问题`, ...(priority.length ? ['', '重点问题：', ...priority.map((item, index) => `${index + 1}. ${item}`)] : []), '',
    `建议：${s.settlementRecommendation}`, '', '未修改任何生产数据。', '完整证据、逐日明细和解决方案见附件。', '', `Run ID: ${model.runId}`,
  ].join('\n')
  return { subject, body, recipient: 'yuegu1995@gmail.com', runId: model.runId, canonicalHash: model.canonicalHash }
}

function escapeHtml(value) {
  return text(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

export function renderPayrollAuditHtml(model) {
  const s = model.summary
  const statusClass = s.finalResult.toLowerCase().replace('_', '-')
  const employeeSections = model.employeeResults.map((employee) => {
    const dayCards = employee.dailyReconciliation.map((day) => `<div class="day-row"><div><b>${escapeHtml(day.date)}</b><span>${escapeHtml(day.stores.join('、') || '无实际出勤')}</span></div><div><span>计划 ${escapeHtml(day.planned.map((row) => `${row.storeKey} ${row.time}`).join('；') || '—')}</span><span>实际 ${escapeHtml(day.actual.map((row) => `${row.storeKey} ${row.payableHours ?? row.actualHours ?? 0}h`).join('；') || 'NO_ACTUAL_ATTENDANCE')}</span></div><strong class="tag ${day.scheduleResult === 'MATCH' ? 'pass' : 'review-required'}">${escapeHtml(day.scheduleResult)}</strong></div>`).join('')
    const issues = employee.issues.length ? employee.issues.map((issue) => `<article class="issue"><h4>${escapeHtml(issue.id)} · ${escapeHtml(issue.type)}</h4><p><b>证据</b> ${escapeHtml(issue.evidence)}</p><p><b>错误层</b> ${escapeHtml(issue.errorLayer)}</p><p><b>工资影响</b> ${escapeHtml(issue.payrollImpact)} · ${escapeHtml(formatCents(issue.amountImpactCents))}</p>${issue.options.map((option) => `<p><b>${escapeHtml(option.label)}</b> ${escapeHtml(option.detail)}</p>`).join('')}<p><b>建议</b> ${escapeHtml(issue.recommendation)}</p><p><b>风险</b> ${escapeHtml(issue.risk)}</p><p class="no-action">NO ACTION EXECUTED</p></article>`).join('') : '<p class="empty">无异常。</p>'
    return `<section class="employee page-break"><header class="section-head"><div><p class="eyebrow">EMPLOYEE AUDIT</p><h2>${escapeHtml(employee.employeeName)}</h2><p>${escapeHtml(employee.employeeId)}${employee.businessRole ? ` · ${escapeHtml(employee.businessRole)}` : ''}</p></div><span class="status ${employee.status.toLowerCase().replace('_', '-')}">${escapeHtml(employee.status)}</span></header><div class="kpis"><div><span>实际工时</span><b>${employee.payableHours ?? '—'}h</b></div><div><span>权威工资</span><b>${escapeHtml(formatCents(employee.authoritativePayrollCents))}</b></div><div><span>卡片金额</span><b>${escapeHtml(formatCents(employee.employeeCardCents))}</b></div><div><span>差额</span><b>${escapeHtml(formatCents(employee.differenceCents))}</b></div></div><h3>工资组成</h3><div class="component-list">${employee.components.map((component) => `<div><span>${escapeHtml(component.label)}</span><b>${escapeHtml(formatCents(component.amountCents))}</b><small>${escapeHtml(component.authority)}</small></div>`).join('')}<div class="total"><span>最终应发</span><b>${escapeHtml(formatCents(employee.authoritativePayrollCents))}</b><small>Payroll authority</small></div></div><h3>逐日事实与排班对照</h3><div class="day-list">${dayCards}</div><h3>异常与解决方案</h3>${issues}</section>`
  }).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  @page{size:A4 portrait;margin:14mm 13mm 16mm}*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d2733;font:13px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif}main{max-width:184mm;margin:auto}.cover{min-height:260mm;display:flex;flex-direction:column;justify-content:space-between;padding:18mm 12mm;background:#fff;border-radius:18px}.brand-wordmark{display:block;width:42mm;height:auto}.cover h1{font-size:30px;margin:20px 0 4px}.cover .period{font-size:20px;color:#536273}.status{display:inline-flex;border-radius:999px;padding:7px 12px;font-weight:700;font-size:11px}.status.pass,.tag.pass{background:#e8f7ee;color:#187a43}.status.review-required,.tag.review-required{background:#fff3de;color:#a15c00}.status.blocked,.tag.blocked{background:#ffe8e8;color:#b42318}.hero-status{font-size:38px;font-weight:700;letter-spacing:-.04em}.hero-status.pass{color:#187a43}.hero-status.review-required{color:#b56b08}.hero-status.blocked{color:#b42318}.kpis{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:18px 0}.kpis>div,.card{background:#fff;border:1px solid #e6e8ec;border-radius:14px;padding:13px}.kpis span{display:block;color:#697586;font-size:11px}.kpis b{display:block;margin-top:4px;font-size:18px;color:#243140}.safety{border-left:3px solid #d84f86;padding:10px 12px;background:#fff5f8;border-radius:8px;color:#693246}.page-break{break-before:page}.section-head{display:flex;justify-content:space-between;align-items:flex-start;margin:4px 0 16px}.section-head h2{font-size:26px;margin:2px 0}.section-head p{margin:0;color:#697586}.eyebrow{color:#d84f86!important;font-size:10px;font-weight:700;letter-spacing:.16em}h3{font-size:16px;margin:20px 0 9px}.overview{background:#fff;border-radius:16px;padding:16px;margin-top:14px}.overview-row{display:grid;grid-template-columns:1.4fr .8fr 1fr 1fr .8fr .8fr;gap:7px;padding:9px 0;border-bottom:1px solid #eceef1;align-items:center}.overview-row:last-child{border:0}.overview-row.head{font-size:10px;color:#697586;font-weight:700}.component-list>div{display:grid;grid-template-columns:1.4fr .8fr 1fr;gap:8px;background:#fff;border-bottom:1px solid #eceef1;padding:9px 11px}.component-list>div:first-child{border-radius:12px 12px 0 0}.component-list>div:last-child{border-radius:0 0 12px 12px;border-bottom:0}.component-list small{color:#7a8695}.component-list .total{background:#fff4f8}.day-row{display:grid;grid-template-columns:1fr 2fr auto;gap:10px;align-items:center;background:#fff;border-bottom:1px solid #eceef1;padding:9px 11px;break-inside:avoid}.day-row:first-child{border-radius:12px 12px 0 0}.day-row:last-child{border-radius:0 0 12px 12px;border:0}.day-row span{display:block;color:#667384;font-size:11px}.tag{border-radius:999px;padding:4px 7px;font-size:9px}.issue{background:#fff8ed;border:1px solid #f2d6a7;border-radius:14px;padding:13px;margin-bottom:10px;break-inside:avoid}.issue h4{margin:0 0 8px;color:#965b0a}.issue p{margin:5px 0}.no-action{font-weight:700;color:#b42318}.empty{color:#667384}.conclusion{min-height:250mm;display:flex;flex-direction:column;justify-content:center}.conclusion h2{font-size:28px}.footer-note{margin-top:22px;padding:16px;border-radius:14px;background:#fff5f8;border:1px solid #f3cfdd;color:#693246;font-weight:700}
  </style></head><body><main><section class="cover"><div><img class="brand-wordmark" src="${WORDMARK_DATA_URI}" alt="budu"><h1>薪酬审查报告</h1><p class="period">${escapeHtml(model.metadata.requestedPeriod.start.slice(0, 7))} · ${escapeHtml(model.metadata.auditMode)} AUDIT</p></div><div><p>最终结果</p><div class="hero-status ${statusClass}">${escapeHtml(s.finalResult.replace('_', ' '))}</div><div class="kpis"><div><span>审查员工</span><b>${s.employeeCount} 人</b></div><div><span>权威工资</span><b>${escapeHtml(formatCents(s.authoritativePayrollCents))}</b></div><div><span>员工卡片</span><b>${escapeHtml(formatCents(s.employeeCardCents))}</b></div><div><span>总差额</span><b>${escapeHtml(formatCents(s.differenceCents))}</b></div><div><span>异常数量</span><b>${s.issueCount}</b></div><div><span>结算建议</span><b>${escapeHtml(s.settlementRecommendation)}</b></div></div></div><p class="safety">${escapeHtml(model.safetyStatement)}</p></section><section class="page-break"><p class="eyebrow">MANAGEMENT SUMMARY</p><h2>管理层总览</h2><div class="overview"><div class="overview-row head"><span>员工</span><span>工时</span><span>权威工资</span><span>卡片金额</span><span>差额</span><span>结果</span></div>${model.employeeResults.map((row) => `<div class="overview-row"><span><b>${escapeHtml(row.employeeName)}</b>${row.businessRole ? `<small> · ${escapeHtml(row.businessRole)}</small>` : ''}</span><span>${row.payableHours ?? '—'}h</span><span>${escapeHtml(formatCents(row.authoritativePayrollCents))}</span><span>${escapeHtml(formatCents(row.employeeCardCents))}</span><span>${escapeHtml(formatCents(row.differenceCents))}</span><span class="tag ${row.status.toLowerCase().replace('_', '-')}">${escapeHtml(row.status)}</span></div>`).join('')}</div></section>${employeeSections}<section class="conclusion page-break"><p class="eyebrow">FINAL AUDIT CONCLUSION</p><h2>最终审查结论</h2><div class="component-list"><div><span>Payroll Authority</span><b>${s.blockedCount ? 'FAIL' : 'PASS'}</b><small>${escapeHtml(model.metadata.authority)}</small></div><div><span>Employee Card</span><b>${s.reviewRequiredCount ? 'MISMATCH' : 'PASS'}</b><small>Personnel projection</small></div><div><span>Schedule Reconciliation</span><b>${model.employeeResults.some((row) => row.scheduleStatus === 'REVIEW') ? 'REVIEW' : 'PASS'}</b><small>计划对照，不作为工资事实</small></div><div><span>Issues</span><b>${s.issueCount}</b><small>需关注问题</small></div><div class="total"><span>Final Result</span><b>${escapeHtml(s.finalResult)}</b><small>${escapeHtml(model.finalRecommendation)}</small></div></div><div class="footer-note">本报告仅做薪酬审查。系统未修改任何历史或生产数据。</div></section></main></body></html>`
}
