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
  await page.locator('select').selectOption('xidan')
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

async function openEditableHarness(width = 375, browserInstance = browser, height = 812, date = '2026-08-22') {
  const page = await browserInstance.newPage({ viewport: { width, height } })
  await page.goto(`${baseUrl}tests/store-entry-integrity-harness.html`)
  await page.locator('select').selectOption('xidan')
  await page.evaluate((draft) => window.__setOverviewPlan('xidan', draft.date, [{ payload: draft }]), payload('xidan', date, 88000, 8, editableStaff))
  await page.locator('input[type=date]').fill(date)
  await page.waitForFunction(() => {
    const fields = [...document.querySelectorAll('input[type=number]')]
    return fields[0]?.value === '880.00' && fields[1]?.value === '8'
  })
  return page
}

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
    await page.locator('select').selectOption('xidan')
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
    const store = page.locator('select')
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
    await page.locator('select').selectOption('xidan')
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
    await page.locator('select').selectOption('xidan')
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

test('reopening a clean Daily Entry reads the latest schedule instead of stale prefill', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  try {
    await page.goto(`${baseUrl}tests/store-entry-integrity-harness.html`)
    await page.locator('select').selectOption('xidan')
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
    await page.locator('select').selectOption('xidan')
    await page.evaluate(([draft, directory]) => {
      window.__setOverviewPlan('xidan', draft.date, [{ payload: draft }])
      window.__setParticipantPlan('xidan', draft.date, [directory])
    }, [posPayload('xidan', '2026-08-19', []), participantDirectory(['emp-home'])])
    await page.locator('input[type=date]').fill('2026-08-19')
    await page.getByText('POS 自动同步', { exact: true }).waitFor()
    assert.equal(await page.getByText('营业收入（元）').count(), 0)
    assert.equal(await page.locator('input[type=number]').count(), 1, 'POS page only exposes actualHours as editable numeric fact')
    await page.getByTestId('daily-entry-hours-employee:emp-home').fill('7.25')
    await page.evaluate(() => window.__releaseSharedRefresh())
    await page.getByTestId('daily-entry-confirm').click()
    await page.getByText('确认成功', { exact: true }).waitFor()
    const writes = await page.evaluate(() => window.__writes)
    assert.equal(writes.length, 1)
    assert.equal(Object.prototype.hasOwnProperty.call(writes[0].body, 'manualSales'), false)
    assert.equal(writes[0].body.items[0].actualHours, '7.25')
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

    const store = page.locator('select')
    await store.selectOption('tongying')
    await page.getByTestId('daily-entry-unsaved-dialog').waitFor()
    assert.equal(await store.inputValue(), 'xidan')
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()
    assert.equal(await page.locator('input[type=number]').nth(0).inputValue(), '666.66')
    await store.selectOption('tongying')
    await page.getByRole('button', { name: '放弃修改', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('select')?.value === 'tongying')
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
