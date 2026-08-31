import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium, webkit } from '@playwright/test'
import { createServer } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
await vite.listen()
const baseUrl = vite.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true })
const webkitBrowser = await webkit.launch({ headless: true })

after(async () => {
  await browser.close()
  await webkitBrowser.close()
  await vite.close()
})

async function openHarness(width = 375, browserInstance = browser, height = 812) {
  const page = await browserInstance.newPage({ viewport: { width, height } })
  await page.goto(`${baseUrl}tests/store-entry-integrity-harness.html`)
  await page.getByTestId('daily-entry-store').selectOption('xidan')
  await page.locator('input[type=date]').fill('2026-08-24')
  const numbers = page.locator('input[type=number]')
  await assert.doesNotReject(() => numbers.nth(0).waitFor())
  await page.waitForFunction(() => {
    const fields = [...document.querySelectorAll('input[type=number]')]
    return fields[0]?.value === '12345.00' && fields[1]?.value === '37'
  })
  return page
}

const payload = (storeKey, date, incCents, ord, staff = []) => ({
  storeKey, date, salesDataSource: 'manual', salesDataStatus: 'synced', pos: null,
  entry: { id: `de-${storeKey}-${date}`, status: 'draft', version: 1, incCents: String(incCents), ord, hybridAdjustmentCents: '0' },
  staff,
})

const posPayload = (storeKey, date, staff = []) => ({
  storeKey, date, salesDataSource: 'pos', salesDataStatus: 'synced',
  entry: { id: `de-${storeKey}-${date}`, status: 'draft', version: 2, incCents: '0', ord: 0, hybridAdjustmentCents: '0' },
  staff,
  pos: {
    originalSales: '99000', effectiveSales: '88000', effectiveAfterRefund: '88000',
    refundAmount: '0', discountAmount: '11000', orderCount: 8, avgOrderCents: '11000',
    byChannel: { wechat: '44000', alipay: '44000', cash: '0', other: '0' },
  },
})

const editableStaff = [{
  id: 'dss-editable', employeeId: 'emp-home', participantUserId: '', participantType: 'EMPLOYEE',
  staffId: 'employee:emp-home', staffName: '叶芷辰', actualHours: 8,
  historicalPayrollHours: null, payableHoursSource: 'ACTUAL_HOURS', breakMinutes: 0,
  attendanceStatus: 'normal', scheduledStartTime: '', scheduledEndTime: '', actualStartTime: '', actualEndTime: '',
}]

const participantDirectory = (scheduledEmployeeIds = [], unresolved = []) => ({
  employees: [
    { employeeId: 'emp-home', employeeNo: 'BUDU-1001', label: '叶芷辰', currentStoreKey: 'xidan', participantType: 'EMPLOYEE', priorityGroup: scheduledEmployeeIds.includes('emp-home') ? 1 : 2 },
    { employeeId: 'emp-chen', employeeNo: 'BUDU-1002', label: '陈文慧', currentStoreKey: 'chaowai', participantType: 'EMPLOYEE', priorityGroup: scheduledEmployeeIds.includes('emp-chen') ? 1 : 3 },
    { employeeId: 'emp-same-a', employeeNo: 'BUDU-1003', label: '同名员工', currentStoreKey: 'xidan', participantType: 'EMPLOYEE', priorityGroup: 2 },
    { employeeId: 'emp-same-b', employeeNo: 'BUDU-1004', label: '同名员工', currentStoreKey: 'tongying', participantType: 'EMPLOYEE', priorityGroup: 3 },
  ],
  substitutes: [{ participantUserId: 'user-sub', label: '卡皮巴拉', participantType: 'NON_EMPLOYEE_SUBSTITUTE', priorityGroup: 4 }],
  schedule: { scheduledEmployeeIds, unresolved, updatedAt: '2026-08-31T00:00:00.000Z' },
})

const ledgerStaff = (id, name, hours, overrides = {}) => ({
  id: `dss-${id}`, employeeId: id, participantUserId: '', participantType: 'EMPLOYEE',
  staffId: `employee:${id}`, staffName: name, actualHours: hours,
  historicalPayrollHours: null, payableHoursSource: 'ACTUAL_HOURS', attendanceStatus: 'normal',
  ...overrides,
})

const ledgerRow = (date, overrides = {}) => ({
  id: `de-ledger-${date}`, storeKey: 'xidan', storeName: '北京西单店', date,
  status: 'confirmed', baseStatus: 'confirmed', incCents: '128800', ord: 18, avgCents: '7155',
  salesDataSource: 'manual', salesSourceLabel: '美团收银 · 人工录入', confirmedBy: '店长',
  confirmedAt: `${date}T14:00:00.000Z`, version: 2,
  completeness: { status: 'COMPLETE', code: 'COMPLETE', issues: [] },
  staff: [ledgerStaff('emp-home', '叶芷辰', 8)], revisionCount: 0, audits: [],
  ...overrides,
})

const ledgerRows = [
  ledgerRow('2026-08-28'),
  ledgerRow('2026-08-27', {
    status: 'revised', revisionCount: 1,
    staff: [ledgerStaff('emp-chen', '陈文慧', 7.5), ledgerStaff('emp-home', '叶芷辰', 8)],
    audits: [{ id: 'audit-revision', module: 'daily_revision', reason: '补正实际工时', operatorName: '管理员', createdAt: '2026-08-28T10:00:00.000Z', revision: true }],
  }),
  ledgerRow('2026-08-26', {
    status: 'draft', baseStatus: 'draft', confirmedBy: '', confirmedAt: null, version: 1,
    completeness: { status: 'INCOMPLETE', code: 'DRAFT_ENTRY', issues: [{ code: 'DRAFT_ENTRY' }] },
  }),
  ledgerRow('2026-08-25', {
    completeness: { status: 'INCOMPLETE', code: 'MISSING_ACTUAL_HOURS', issues: [{ code: 'MISSING_ACTUAL_HOURS', participantKey: 'employee:emp-home' }] },
    staff: [ledgerStaff('emp-home', '叶芷辰', null)],
  }),
  ledgerRow('2026-08-24', {
    completeness: { status: 'INCOMPLETE', code: 'UNRESOLVED_EMPLOYEE', issues: [{ code: 'UNRESOLVED_EMPLOYEE', participantKey: 'legacy:旧员工' }] },
    staff: [ledgerStaff('', '旧员工', null, { id: 'dss-legacy', employeeId: '', participantType: 'LEGACY_UNKNOWN', staffId: 'legacy:旧员工', historicalPayrollHours: 7, payableHoursSource: 'LEGACY_PAYROLL_HOURS', attendanceStatus: 'HISTORICAL_UNOBSERVED' })],
  }),
  ledgerRow('2026-08-23', {
    salesDataSource: 'pos', salesSourceLabel: 'BUDU POS', incCents: '88000', ord: 8, avgCents: '11000',
  }),
]

async function openLedgerHarness(width = 390, browserInstance = browser, height = 844) {
  const page = await browserInstance.newPage({ viewport: { width, height } })
  await page.goto(`${baseUrl}tests/store-entry-integrity-harness.html`)
  await page.evaluate((rows) => {
    window.__setLedgerPlan('2026-08', 'xidan', 'all', [{ payload: { ok: true, month: '2026-08', storeKey: 'xidan', rows } }])
    window.__setLedgerPlan('2026-08', 'xidan', 'draft', [{ payload: { ok: true, month: '2026-08', storeKey: 'xidan', rows: rows.filter((row) => row.baseStatus === 'draft') } }])
    window.__setLedgerPlan('2026-08', 'xidan', 'confirmed', [{ payload: { ok: true, month: '2026-08', storeKey: 'xidan', rows: rows.filter((row) => row.baseStatus === 'confirmed') } }])
    window.__setLedgerPlan('2026-08', 'xidan', 'anomaly', [{ payload: { ok: true, month: '2026-08', storeKey: 'xidan', rows: rows.filter((row) => row.completeness.status !== 'COMPLETE') } }])
  }, ledgerRows)
  await page.getByTestId('ledger-store-filter').selectOption('xidan')
  await page.getByTestId('ledger-card-2026-08-28').waitFor()
  return page
}

async function openEditableHarness(width = 375, browserInstance = browser, height = 812, date = '2026-08-22') {
  const page = await browserInstance.newPage({ viewport: { width, height } })
  await page.goto(`${baseUrl}tests/store-entry-integrity-harness.html`)
  await page.getByTestId('daily-entry-store').selectOption('xidan')
  await page.evaluate((draft) => window.__setOverviewPlan('xidan', draft.date, [{ payload: draft }]), payload('xidan', date, 88000, 8, editableStaff))
  await page.locator('input[type=date]').fill(date)
  await page.waitForFunction(() => {
    const fields = [...document.querySelectorAll('input[type=number]')]
    return fields[0]?.value === '880.00' && fields[1]?.value === '8'
  })
  return page
}

test('final Daily Entry V2 information architecture is concise and ordered', async () => {
  const page = await openEditableHarness(1440, browser, 900)
  try {
    const headings = await page.locator('h3').evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()))
    assert.deepEqual(headings.slice(0, 4), ['今日经营', '今日实际值班', '闭店确认', '每日事实账本'])
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0)
  } finally {
    await page.close()
  }
})

test('historical authority survives the late shared-data refresh', async () => {
  const page = await openHarness()
  try {
    const requestCount = await page.evaluate(() => window.__storeEntryTimeline.length)
    await page.evaluate(() => window.__releaseSharedRefresh())
    await page.waitForTimeout(250)
    const values = await page.locator('input[type=number]').evaluateAll((fields) => fields.map((field) => field.value))
    assert.deepEqual(values.slice(0, 2), ['12345.00', '37'])
    assert.equal(await page.locator('span').filter({ hasText: /^陈文慧/ }).count(), 1)
    assert.equal(await page.evaluate(() => window.__writes.length), 0)
    assert.equal(await page.locator('input[type=date]').inputValue(), '2026-08-24')
    const refreshRequests = await page.evaluate((from) => window.__storeEntryTimeline.slice(from)
      .filter((event) => event.event === 'request' && event.path.includes('/daily-entry/overview'))
      .map((event) => event.path), requestCount)
    assert.ok(refreshRequests.length >= 1)
    assert.ok(refreshRequests.every((path) => path.includes('store=xidan') && path.includes('date=2026-08-24')))
  } finally {
    await page.close()
  }
})

test('late empty response cannot replace an already newer exact-date authority', async () => {
  const page = await openHarness()
  try {
    await page.evaluate((correct) => {
      window.__setOverviewPlan('xidan', '2026-08-24', [
        { delay: 160, payload: { storeKey: 'xidan', date: '2026-08-24', salesDataSource: 'manual', salesDataStatus: 'waiting_input', entry: null, pos: null, staff: [] } },
        { delay: 10, payload: correct },
      ])
      window.__releaseSharedRefresh()
    }, payload('xidan', '2026-08-24', 777700, 19))
    await page.waitForTimeout(5)
    await page.evaluate(() => window.__triggerSharedRefresh())
    await page.waitForTimeout(220)
    const values = await page.locator('input[type=number]').evaluateAll((fields) => fields.map((field) => field.value))
    const timeline = await page.evaluate(() => window.__storeEntryTimeline)
    assert.deepEqual(values.slice(0, 2), ['12345.00', '37'], JSON.stringify(timeline))
  } finally {
    await page.close()
  }
})

test('rapid date switching keeps only the final composite authority', async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  try {
    await page.goto(`${baseUrl}tests/store-entry-integrity-harness.html`)
    await page.getByTestId('daily-entry-store').selectOption('xidan')
    await page.evaluate(([a, b, c]) => {
      window.__setOverviewPlan('xidan', '2026-08-22', [{ delay: 180, payload: a }])
      window.__setOverviewPlan('xidan', '2026-08-23', [{ delay: 120, payload: b }])
      window.__setOverviewPlan('xidan', '2026-08-24', [{ delay: 15, payload: c }])
    }, [
      payload('xidan', '2026-08-22', 111100, 11),
      payload('xidan', '2026-08-23', 222200, 22),
      payload('xidan', '2026-08-24', 333300, 33),
    ])
    const date = page.locator('input[type=date]')
    await date.fill('2026-08-22')
    await date.fill('2026-08-23')
    await date.fill('2026-08-24')
    await page.waitForTimeout(240)
    assert.equal(await date.inputValue(), '2026-08-24')
    const values = await page.locator('input[type=number]').evaluateAll((fields) => fields.map((field) => field.value))
    assert.deepEqual(values.slice(0, 2), ['3333.00', '33'])
  } finally {
    await page.close()
  }
})

test('rapid store switching keeps only the final store/date authority', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  try {
    await page.goto(`${baseUrl}tests/store-entry-integrity-harness.html`)
    await page.locator('input[type=date]').fill('2026-08-24')
    await page.evaluate(([xidan, tongying, chaowai]) => {
      window.__setOverviewPlan('xidan', '2026-08-24', [{ delay: 180, payload: xidan }])
      window.__setOverviewPlan('tongying', '2026-08-24', [{ delay: 120, payload: tongying }])
      window.__setOverviewPlan('chaowai', '2026-08-24', [{ delay: 15, payload: chaowai }])
    }, [
      payload('xidan', '2026-08-24', 111100, 11),
      payload('tongying', '2026-08-24', 222200, 22),
      payload('chaowai', '2026-08-24', 444400, 44),
    ])
    const store = page.getByTestId('daily-entry-store')
    await store.selectOption('xidan')
    await store.selectOption('tongying')
    await store.selectOption('chaowai')
    await page.waitForTimeout(240)
    assert.equal(await store.inputValue(), 'chaowai')
    const values = await page.locator('input[type=number]').evaluateAll((fields) => fields.map((field) => field.value))
    assert.deepEqual(values.slice(0, 2), ['4444.00', '44'])
  } finally {
    await page.close()
  }
})

test('dirty manual form survives background refresh without a write', async () => {
  const page = await openEditableHarness()
  try {
    const revenue = page.locator('input[type=number]').nth(0)
    await revenue.fill('999.99')
    await page.evaluate(() => window.__releaseSharedRefresh())
    await page.waitForTimeout(180)
    assert.equal(await revenue.inputValue(), '999.99')
    await page.getByText('当前未保存编辑已保留').waitFor()
    assert.equal(await page.evaluate(() => window.__writes.length), 0)
  } finally {
    await page.close()
  }
})

test('REAL_ZERO stays distinguishable from loading and failed authority', async () => {
  const page = await browser.newPage({ viewport: { width: 340, height: 760 } })
  try {
    await page.goto(`${baseUrl}tests/store-entry-integrity-harness.html`)
    await page.getByTestId('daily-entry-store').selectOption('xidan')
    await page.evaluate((zero) => window.__setOverviewPlan('xidan', '2026-08-20', [{ delay: 80, payload: zero }]), payload('xidan', '2026-08-20', 0, 0))
    await page.locator('input[type=date]').fill('2026-08-20')
    await page.getByText('正在加载…').waitFor()
    assert.equal(await page.getByTestId('daily-entry-confirm').isDisabled(), true)
    await page.waitForTimeout(110)
    const values = await page.locator('input[type=number]').evaluateAll((fields) => fields.map((field) => field.value))
    assert.deepEqual(values.slice(0, 2), ['0.00', '0'])
    assert.equal(await page.getByTestId('daily-entry-confirm').isEnabled(), true)

    await page.evaluate(() => window.__setOverviewPlan('xidan', '2026-08-21', [{ status: 503, payload: { error: 'fixture unavailable' } }]))
    await page.locator('input[type=date]').fill('2026-08-21')
    await page.getByText(/不会以 0 或空值代替/).waitFor()
    assert.equal(await page.getByTestId('daily-entry-confirm').isDisabled(), true)
  } finally {
    await page.close()
  }
})

test('sales, participant and actual-hours edits stay local until one atomic confirmation', async () => {
  const page = await openEditableHarness(390)
  try {
    await page.locator('input[type=number]').nth(0).fill('999.50')
    await page.locator('input[type=number]').nth(1).fill('12')
    await page.getByRole('button', { name: /已选 1 人/ }).click()
    await page.getByRole('button', { name: /叶芷辰 BUDU-1001/ }).click()
    await page.getByRole('button', { name: /陈文慧 BUDU-1002/ }).click()
    const hours = page.getByTestId('daily-entry-hours-employee:emp-chen')
    assert.equal(await hours.inputValue(), '', 'new participant actualHours must remain explicitly unconfirmed')
    await hours.fill('7.5')
    await page.locator('[data-budu-overlay-ignore]').click({ position: { x: 2, y: 2 } })
    assert.equal(await page.evaluate(() => window.__writes.length), 0, 'draft edits must not write PostgreSQL')
    const savedStaff = [ledgerStaff('emp-chen', '陈文慧', 7.5)]
    const confirmedOverview = payload('xidan', '2026-08-22', 99950, 12, savedStaff)
    confirmedOverview.entry = {
      ...confirmedOverview.entry, status: 'confirmed', version: 2,
      confirmedAt: '2026-08-22T14:00:00.000Z', confirmedBy: 'developer',
    }
    const confirmedLedger = ledgerRow('2026-08-22', {
      incCents: '99950', ord: 12, avgCents: '8329', staff: savedStaff,
      confirmedAt: '2026-08-22T14:00:00.000Z', confirmedBy: 'developer',
    })
    await page.evaluate(([overview, ledger]) => {
      window.__setOverviewPlan('xidan', '2026-08-22', [
        { payload: overview }, { payload: overview }, { payload: overview }, { payload: overview },
      ])
      window.__setLedgerPlan('2026-08', 'xidan', 'all', [
        { payload: { ok: true, month: '2026-08', storeKey: 'xidan', rows: [] } },
        { payload: { ok: true, month: '2026-08', storeKey: 'xidan', rows: [ledger] } },
      ])
    }, [confirmedOverview, confirmedLedger])
    await page.getByTestId('ledger-store-filter').selectOption('xidan')
    await page.evaluate(() => window.__releaseSharedRefresh())
    await page.getByTestId('daily-entry-confirm').click()
    await page.getByText('确认成功', { exact: true }).waitFor()
    const writes = await page.evaluate(() => window.__writes)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].path, '/api/v2/daily-entry/confirm')
    assert.equal(writes[0].body.manualSales.incCents, 99950)
    assert.equal(writes[0].body.manualSales.ord, 12)
    assert.equal(writes[0].body.items.length, 1)
    assert.equal(writes[0].body.items[0].employeeId, 'emp-chen')
    assert.equal(writes[0].body.items[0].actualHours, '7.5')
    assert.equal(await page.locator('.budu-feedback-overlay').count(), 1, 'success feedback must render exactly once')
    assert.equal(await page.getByTestId('daily-entry-dirty').count(), 0)
    await page.getByTestId('ledger-card-2026-08-22').waitFor()
    assert.equal(await page.locator('input[type=number]').nth(0).inputValue(), '999.50')
    assert.equal(await page.getByTestId('daily-entry-hours-employee:emp-chen').inputValue(), '7.5')
    assert.equal(await page.getByTestId('daily-entry-confirm').count(), 0, 'confirmed facts become read-only after refresh')
  } finally {
    await page.close()
  }
})

test('failed atomic confirmation preserves the local draft and never shows success', async () => {
  const page = await openEditableHarness()
  try {
    const revenue = page.locator('input[type=number]').nth(0)
    await revenue.fill('777.77')
    await page.evaluate(() => { window.__confirmFailure = true })
    await page.getByTestId('daily-entry-confirm').click()
    await page.getByText(/其他用户更新/).waitFor()
    assert.equal(await revenue.inputValue(), '777.77')
    assert.equal(await page.getByTestId('daily-entry-dirty').count(), 1)
    assert.equal(await page.locator('.budu-feedback-overlay').count(), 0)
  } finally {
    await page.close()
  }
})

test('Schedule Employee.id prefills only the local draft with blank actualHours and legacy stays unresolved', async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  try {
    await page.goto(`${baseUrl}tests/store-entry-integrity-harness.html`)
    await page.getByTestId('daily-entry-store').selectOption('xidan')
    const day = '2026-08-17'
    await page.evaluate(([draft, directory]) => {
      window.__setOverviewPlan('xidan', draft.date, [{ payload: draft }])
      window.__setParticipantPlan('xidan', draft.date, [directory])
    }, [payload('xidan', day, 0, 0), participantDirectory(['emp-home', 'emp-chen'], [{ reason: 'MISSING_EMPLOYEE_ID', staffSnapshot: '同名员工' }])])
    await page.locator('input[type=date]').fill(day)
    await page.getByTestId('daily-entry-hours-employee:emp-home').waitFor()
    assert.equal(await page.getByTestId('daily-entry-hours-employee:emp-home').inputValue(), '')
    assert.equal(await page.getByTestId('daily-entry-hours-employee:emp-chen').inputValue(), '')
    assert.equal(await page.getByText('排班预填', { exact: true }).count(), 2)
    await page.getByText(/历史排班身份未解析 1 人/).waitFor()
    assert.equal(await page.evaluate(() => window.__writes.length), 0)

    await page.getByRole('button', { name: /已选 2 人/ }).click()
    await page.getByRole('button', { name: /陈文慧 BUDU-1002/ }).click()
    assert.equal(await page.getByTestId('daily-entry-hours-employee:emp-chen').count(), 0, '未实际上班的排班员工可从 draft 移除')
    assert.equal(await page.evaluate(() => window.__writes.length), 0)
  } finally {
    await page.close()
  }
})

test('orphan DailyStoreStaff never overrides the latest Schedule draft', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  try {
    await page.goto(`${baseUrl}tests/store-entry-integrity-harness.html`)
    await page.getByTestId('daily-entry-store').selectOption('xidan')
    const day = '2026-08-31'
    const orphanOverview = {
      ...payload('xidan', day, 0, 0, [
        ledgerStaff('emp-chen', '陈文慧', 8),
        ledgerStaff('emp-same-a', '同名员工', 8),
      ]),
      entry: null,
    }
    await page.evaluate(([overview, directory]) => {
      window.__setOverviewPlan('xidan', overview.date, [{ payload: overview }])
      window.__setParticipantPlan('xidan', overview.date, [directory])
    }, [orphanOverview, participantDirectory(['emp-home'])])
    await page.locator('input[type=date]').fill('2026-08-30')
    await page.locator('input[type=date]').fill(day)
    await page.getByTestId('daily-entry-hours-employee:emp-home').waitFor()
    assert.equal(await page.getByTestId('daily-entry-hours-employee:emp-home').inputValue(), '')
    assert.equal(await page.getByText('排班预填', { exact: true }).count(), 1)
    assert.equal(await page.getByTestId('daily-entry-hours-employee:emp-chen').count(), 0)
    assert.equal(await page.getByTestId('daily-entry-hours-employee:emp-same-a').count(), 0)
    assert.equal(await page.evaluate(() => window.__writes.length), 0)
  } finally {
    await page.close()
  }
})

test('reopening a clean Daily Entry reads the latest schedule instead of stale prefill', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  try {
    await page.goto(`${baseUrl}tests/store-entry-integrity-harness.html`)
    await page.getByTestId('daily-entry-store').selectOption('xidan')
    const firstDay = '2026-08-16'
    const otherDay = '2026-08-15'
    await page.evaluate(([first, other, firstDirectory, updatedDirectory, otherDirectory]) => {
      window.__setOverviewPlan('xidan', first.date, [{ payload: first }, { payload: first }])
      window.__setOverviewPlan('xidan', other.date, [{ payload: other }])
      window.__setParticipantPlan('xidan', first.date, [firstDirectory, updatedDirectory])
      window.__setParticipantPlan('xidan', other.date, [otherDirectory])
    }, [
      payload('xidan', firstDay, 0, 0),
      payload('xidan', otherDay, 0, 0),
      participantDirectory(['emp-home', 'emp-chen']),
      participantDirectory(['emp-home']),
      participantDirectory([]),
    ])
    await page.locator('input[type=date]').fill(firstDay)
    await page.getByTestId('daily-entry-hours-employee:emp-chen').waitFor()
    await page.locator('input[type=date]').fill(otherDay)
    await page.waitForFunction(() => !document.querySelector('[data-testid="daily-entry-hours-employee:emp-chen"]'))
    await page.locator('input[type=date]').fill(firstDay)
    await page.getByTestId('daily-entry-hours-employee:emp-home').waitFor()
    assert.equal(await page.getByTestId('daily-entry-hours-employee:emp-chen').count(), 0)
    assert.equal(await page.getByTestId('daily-entry-hours-employee:emp-home').inputValue(), '')
  } finally {
    await page.close()
  }
})

test('POS sales stay read-only while staff facts use the atomic confirmation', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  try {
    await page.goto(`${baseUrl}tests/store-entry-integrity-harness.html`)
    await page.getByTestId('daily-entry-store').selectOption('xidan')
    await page.evaluate(([draft, directory]) => {
      window.__setOverviewPlan('xidan', draft.date, [{ payload: draft }])
      window.__setParticipantPlan('xidan', draft.date, [directory])
    }, [posPayload('xidan', '2026-08-19', []), participantDirectory(['emp-home'])])
    await page.locator('input[type=date]').fill('2026-08-19')
    await page.getByText('POS 自动同步', { exact: true }).waitFor()
    assert.equal(await page.getByText('营业收入（元）').count(), 0)
    assert.equal(await page.locator('input[type=number]').count(), 1, 'POS page only exposes actualHours as editable numeric fact')
    await page.getByTestId('daily-entry-hours-employee:emp-home').fill('7.25')
    const savedStaff = [ledgerStaff('emp-home', '叶芷辰', 7.25)]
    const confirmedOverview = posPayload('xidan', '2026-08-19', savedStaff)
    confirmedOverview.entry = {
      ...confirmedOverview.entry, status: 'confirmed', version: 3,
      confirmedAt: '2026-08-19T14:00:00.000Z', confirmedBy: 'developer',
    }
    const confirmedLedger = ledgerRow('2026-08-19', {
      salesDataSource: 'pos', salesSourceLabel: 'BUDU POS', incCents: '88000', ord: 8, avgCents: '11000',
      staff: savedStaff, confirmedAt: '2026-08-19T14:00:00.000Z', confirmedBy: 'developer',
    })
    await page.evaluate(([overview, ledger]) => {
      window.__setOverviewPlan('xidan', '2026-08-19', [
        { payload: overview }, { payload: overview }, { payload: overview }, { payload: overview },
      ])
      window.__setLedgerPlan('2026-08', 'xidan', 'all', [
        { payload: { ok: true, month: '2026-08', storeKey: 'xidan', rows: [] } },
        { payload: { ok: true, month: '2026-08', storeKey: 'xidan', rows: [ledger] } },
      ])
    }, [confirmedOverview, confirmedLedger])
    await page.getByTestId('ledger-store-filter').selectOption('xidan')
    await page.evaluate(() => window.__releaseSharedRefresh())
    await page.getByTestId('daily-entry-confirm').click()
    await page.getByText('确认成功', { exact: true }).waitFor()
    const writes = await page.evaluate(() => window.__writes)
    assert.equal(writes.length, 1)
    assert.equal(Object.prototype.hasOwnProperty.call(writes[0].body, 'manualSales'), false)
    assert.equal(writes[0].body.items[0].actualHours, '7.25')
    await page.getByTestId('ledger-card-2026-08-19').waitFor()
    assert.equal(await page.getByText('POS 自动同步', { exact: true }).count(), 1)
    assert.equal(await page.getByTestId('daily-entry-hours-employee:emp-home').inputValue(), '7.25')
  } finally {
    await page.close()
  }
})

test('dirty date, store and module transitions use the BUDU overlay guard', async () => {
  const page = await openEditableHarness(375)
  try {
    await page.locator('input[type=number]').nth(0).fill('666.66')
    const date = page.locator('input[type=date]')
    await date.fill('2026-08-23')
    await page.getByTestId('daily-entry-unsaved-dialog').waitFor()
    assert.equal(await date.inputValue(), '2026-08-22')
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()

    await page.evaluate(() => window.__requestModuleLeave())
    await page.getByTestId('daily-entry-unsaved-dialog').waitFor()
    assert.equal(await page.evaluate(() => window.__moduleLeft), false)
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()

    const store = page.getByTestId('daily-entry-store')
    await store.selectOption('tongying')
    await page.getByTestId('daily-entry-unsaved-dialog').waitFor()
    assert.equal(await store.inputValue(), 'xidan')
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()
    assert.equal(await page.locator('input[type=number]').nth(0).inputValue(), '666.66')
    await store.selectOption('tongying')
    await page.getByRole('button', { name: '放弃修改', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-testid="daily-entry-store"]')?.value === 'tongying')
    assert.equal(await page.evaluate(() => window.__writes.length), 0)
  } finally {
    await page.close()
  }
})

test('confirmed historical facts are read-only in ordinary daily entry', async () => {
  const page = await openHarness()
  try {
    const numberFields = page.locator('input[type=number]')
    assert.equal(await numberFields.nth(0).isDisabled(), true)
    assert.equal(await numberFields.nth(1).isDisabled(), true)
    assert.equal(await page.getByTestId('daily-entry-hours-employee:emp-chen').isDisabled(), true)
    await page.getByText('已确认记录在普通每日录入中只读').waitFor()
    assert.equal(await page.getByRole('button', { name: '取消确认' }).count(), 0)
  } finally {
    await page.close()
  }
})

test('authorized confirmed revision requires reason and submits one audited command', async () => {
  const page = await openHarness()
  try {
    await page.getByTestId('daily-entry-start-revision').click()
    await page.getByTestId('daily-entry-revision-panel').waitFor()
    const revenue = page.locator('input[type=number]').nth(0)
    const actualHours = page.getByTestId('daily-entry-hours-employee:emp-chen')
    assert.equal(await revenue.isEnabled(), true)
    assert.equal(await actualHours.isEnabled(), true)
    await revenue.fill('12346.00')
    await actualHours.fill('11.5')
    assert.equal(await page.evaluate(() => window.__writes.length), 0)
    await page.getByTestId('daily-entry-submit-revision').click()
    await page.getByText(/请填写至少 2 个字符/).waitFor()
    assert.equal(await page.evaluate(() => window.__writes.length), 0)
    await page.getByTestId('daily-entry-revision-reason').fill('核对闭店记录后修正实际工时')
    await page.evaluate(() => window.__releaseSharedRefresh())
    await page.getByTestId('daily-entry-submit-revision').click()
    await page.getByText('修正已保存', { exact: true }).waitFor()
    const writes = await page.evaluate(() => window.__writes)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].path, '/api/v2/daily-entry/revise')
    assert.equal(writes[0].body.version, 7)
    assert.equal(writes[0].body.reason, '核对闭店记录后修正实际工时')
    assert.equal(writes[0].body.manualSales.incCents, 1234600)
    assert.equal(writes[0].body.items[0].employeeId, 'emp-chen')
    assert.equal(writes[0].body.items[0].actualHours, '11.5')
  } finally {
    await page.close()
  }
})

test('Daily Fact Ledger renders saved manual/POS facts, completeness and real revision audit', async () => {
  const page = await openLedgerHarness()
  try {
    assert.equal(await page.locator('[data-testid^="ledger-card-"]').count(), ledgerRows.length)
    await page.getByText('美团收银 · 人工录入', { exact: false }).first().waitFor()
    await page.getByText('来源：BUDU POS', { exact: true }).waitFor()
    await page.getByText('已修正', { exact: true }).waitFor()
    assert.equal(await page.getByText('已修正', { exact: true }).count(), 1, 'only a real post-confirm audit may derive revised')
    assert.ok(await page.getByText('工资数据：待完善', { exact: true }).count() >= 2)
    await page.getByTestId('ledger-card-2026-08-27').getByRole('button', { name: '查看详情' }).click()
    const detail = page.getByTestId('daily-ledger-detail')
    await detail.waitFor()
    await detail.getByText('陈文慧', { exact: true }).waitFor()
    await detail.getByText('确认后修正 · daily_revision', { exact: true }).waitFor()
    await detail.getByText(/补正实际工时 · 管理员/).waitFor()
    assert.equal(await detail.getByText('排班预填', { exact: true }).count(), 0, 'ledger detail must not reconstruct from Schedule')
    await detail.getByRole('button', { name: '关闭', exact: true }).click()

    await page.getByTestId('ledger-status-filter').selectOption('draft')
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="ledger-card-"]').length === 1)
    await page.getByTestId('ledger-card-2026-08-26').waitFor()
    assert.equal(await page.locator('[data-testid^="ledger-card-"]').count(), 1)
    await page.getByTestId('ledger-card-2026-08-26').getByRole('button', { name: '查看详情' }).click()
    await page.getByRole('button', { name: '继续填写这一天' }).waitFor()
  } finally {
    await page.close()
  }
})

test('Daily Fact Ledger anomaly filter keeps missing hours and legacy identity explicit', async () => {
  const page = await openLedgerHarness(375)
  try {
    await page.getByTestId('ledger-status-filter').selectOption('anomaly')
    await page.getByTestId('ledger-card-2026-08-25').waitFor()
    assert.equal(await page.getByTestId('ledger-card-2026-08-28').count(), 0)
    await page.getByTestId('ledger-card-2026-08-24').getByRole('button', { name: '查看详情' }).click()
    const detail = page.getByTestId('daily-ledger-detail')
    await detail.getByText('员工身份未解析', { exact: true }).waitFor()
    await detail.getByText(/历史身份待解析 · 历史计薪工时权威/).waitFor()
  } finally {
    await page.close()
  }
})

for (const width of [320, 340, 375, 390, 430]) {
  test(`Daily Fact Ledger cards and detail stay bounded at ${width}px`, async () => {
    const page = await openLedgerHarness(width)
    try {
      await page.getByTestId('ledger-card-2026-08-27').getByRole('button', { name: '查看详情' }).click()
      await page.getByTestId('daily-ledger-detail').waitFor()
      const metrics = await page.evaluate(() => ({
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ledgerOverflow: (() => {
          const node = document.querySelector('[data-testid="daily-fact-ledger"]')
          return node.scrollWidth - node.clientWidth
        })(),
        detailOverflow: (() => {
          const node = document.querySelector('[data-testid="daily-ledger-detail"] [role="dialog"]')
          return node.scrollWidth - node.clientWidth
        })(),
      }))
      assert.ok(metrics.documentOverflow <= 0, JSON.stringify(metrics))
      assert.ok(metrics.ledgerOverflow <= 0, JSON.stringify(metrics))
      assert.ok(metrics.detailOverflow <= 0, JSON.stringify(metrics))
    } finally {
      await page.close()
    }
  })
}

test('WebKit Daily Fact Ledger cards and internal detail scroll remain bounded', async () => {
  for (const [width, height] of [[390, 844], [768, 1024]]) {
    const page = await openLedgerHarness(width, webkitBrowser, height)
    try {
      await page.getByTestId('ledger-card-2026-08-27').getByRole('button', { name: '查看详情' }).click()
      const detail = page.getByTestId('daily-ledger-detail')
      await detail.waitFor()
      const metrics = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="daily-ledger-detail"] [role="dialog"]')
        const scroller = panel?.querySelector('.overflow-y-auto')
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          panelOverflow: panel.scrollWidth - panel.clientWidth,
          canScrollInternally: scroller.scrollHeight >= scroller.clientHeight,
        }
      })
      assert.ok(metrics.overflow <= 0, JSON.stringify(metrics))
      assert.ok(metrics.panelOverflow <= 0, JSON.stringify(metrics))
      assert.equal(metrics.canScrollInternally, true)
    } finally {
      await page.close()
    }
  }
})

for (const width of [320, 340, 375, 390, 430]) {
  test(`mobile candidate selector is bounded and readable at ${width}px`, async () => {
    const page = await openEditableHarness(width)
    try {
      await page.getByRole('button', { name: /已选 1 人/ }).click()
      const panel = page.getByTestId('staff-candidate-panel')
      await panel.waitFor()
      const metrics = await page.evaluate(() => ({
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        panel: (() => {
          const rect = document.querySelector('[data-testid="staff-candidate-panel"]').getBoundingClientRect()
          return { left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width }
        })(),
      }))
      assert.ok(metrics.documentOverflow <= 0)
      assert.ok(metrics.panel.left >= 0 && metrics.panel.right <= width)
      await page.getByText('陈文慧', { exact: true }).waitFor()
      assert.equal(await page.getByText('同名员工', { exact: true }).count(), 2)
      await page.getByText('运营替代·不计工资', { exact: true }).waitFor()
      const badgeStyle = await page.getByText('运营替代·不计工资', { exact: true }).evaluate((node) => getComputedStyle(node).whiteSpace)
      assert.equal(badgeStyle, 'nowrap')
      const hourInput = page.getByTestId('daily-entry-hours-employee:emp-home')
      await hourInput.scrollIntoViewIfNeeded()
      assert.equal(await hourInput.getAttribute('inputmode'), 'decimal')
      const hourRect = await hourInput.boundingBox()
      assert.ok(hourRect && hourRect.x >= 0 && hourRect.x + hourRect.width <= width)
    } finally {
      await page.close()
    }
  })
}

for (const [label, width, height] of [['iPad portrait', 768, 1024], ['desktop', 1440, 900]]) {
  test(`${label} candidate selector regression`, async () => {
    const page = await openEditableHarness(width, browser, height)
    try {
      await page.getByRole('button', { name: /已选 1 人/ }).click()
      const panel = page.getByTestId('staff-candidate-panel')
      await panel.waitFor()
      const metrics = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        panelOverflow: (() => {
          const node = document.querySelector('[data-testid="staff-candidate-panel"]')
          return node.scrollWidth - node.clientWidth
        })(),
      }))
      assert.ok(metrics.overflow <= 0)
      assert.ok(metrics.panelOverflow <= 0)
      await page.getByPlaceholder('搜索员工姓名').fill('陈文慧')
      assert.equal(await panel.getByText('陈文慧', { exact: true }).count(), 1)
      assert.equal(await panel.getByText('同名员工', { exact: true }).count(), 0)
    } finally {
      await page.close()
    }
  })
}

test('WebKit mobile and iPad selector stay bounded', async () => {
  for (const [width, height] of [[390, 844], [768, 1024]]) {
    const page = await openEditableHarness(width, webkitBrowser, height)
    try {
      await page.getByRole('button', { name: /已选 1 人/ }).click()
      const panel = page.getByTestId('staff-candidate-panel')
      await panel.waitFor()
      const metrics = await page.evaluate(() => {
        const rect = document.querySelector('[data-testid="staff-candidate-panel"]').getBoundingClientRect()
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          left: rect.left,
          right: rect.right,
          viewport: document.documentElement.clientWidth,
        }
      })
      assert.ok(metrics.overflow <= 0)
      assert.ok(metrics.left >= 0 && metrics.right <= metrics.viewport)
    } finally {
      await page.close()
    }
  }
})
