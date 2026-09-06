import { expect, test } from '@playwright/test'

async function selectCrossMonthWeek(page) {
  await page.getByTestId('personnel-month-selector').getByRole('button').first().click()
  await page.getByRole('textbox', { name: '快速选择日期' }).fill('2026-08-31')
  await page.getByTestId('personnel-month-selector').getByRole('button').first().click()
  await page.getByRole('button', { name: '查看整周' }).click()
  await expect(page.getByText('按周', { exact: true })).toBeVisible()
}

test('8-second cross-month refresh retains Employee.id detail through loading, stale response and error', async ({ page }) => {
  await page.goto('/tests/payroll-disappearing-race-harness.html')
  await expect(page.getByText('稳定计算', { exact: true })).toBeVisible()
  await selectCrossMonthWeek(page)

  const card = page.locator('.card').filter({ hasText: 'BUDU-0004' })
  await expect(card).toContainText('周工资')
  await expect(card).toContainText('工时 44h')
  await card.click()
  const dialog = page.getByRole('dialog', { name: '隋晓工资明细' })
  await expect(dialog).toHaveAttribute('data-payroll-employee-id', 'emp-sui')
  await expect(dialog.getByTestId('payroll-daily-card')).toHaveCount(4)
  await expect(dialog.getByTestId('payroll-no-data')).toHaveCount(0)

  const countsBefore = await page.evaluate(() => Object.fromEntries(['2026-08', '2026-09'].map((month) => [month, window.__payrollRace.calls.filter((call) => call.month === month).length])))
  await page.evaluate(() => {
    window.__payrollRace.setPhase('pending')
    window.__runPayrollSyncTick()
  })
  await expect.poll(() => page.evaluate(() => window.__payrollRace.pending.length)).toBe(2)
  await expect(dialog.getByTestId('payroll-refreshing')).toBeVisible()
  await expect(dialog.getByTestId('payroll-daily-card')).toHaveCount(4)
  await expect(dialog.getByTestId('payroll-no-data')).toHaveCount(0)
  await expect(dialog).toHaveAttribute('data-payroll-employee-id', 'emp-sui')
  const countsDuring = await page.evaluate(() => Object.fromEntries(['2026-08', '2026-09'].map((month) => [month, window.__payrollRace.calls.filter((call) => call.month === month).length])))
  expect(countsDuring['2026-08'] - countsBefore['2026-08']).toBe(1)
  expect(countsDuring['2026-09'] - countsBefore['2026-09']).toBe(1)

  await page.evaluate(() => {
    window.__payrollRace.setPhase('success')
    window.__runPayrollSyncTick()
  })
  await expect(dialog.getByTestId('payroll-refreshing')).toHaveCount(0)
  await expect(dialog.getByTestId('payroll-daily-card')).toHaveCount(4)
  await page.evaluate(() => window.__payrollRace.resolvePending({ '2026-08': [], '2026-09': [] }))
  await expect(dialog.getByTestId('payroll-daily-card')).toHaveCount(4)
  await expect(dialog.getByTestId('payroll-no-data')).toHaveCount(0)
  await expect(dialog).toHaveAttribute('data-payroll-employee-id', 'emp-sui')

  await page.evaluate(() => {
    window.__payrollRace.setPhase('error')
    window.__runPayrollSyncTick()
  })
  await expect(dialog.getByTestId('payroll-refresh-error')).toBeVisible()
  await expect(dialog.getByTestId('payroll-daily-card')).toHaveCount(4)
  await expect(dialog.getByTestId('payroll-no-data')).toHaveCount(0)
  await expect(dialog).toHaveAttribute('data-payroll-employee-id', 'emp-sui')
})

test('authoritative zero-result employee alone renders the real-empty state', async ({ page }) => {
  await page.goto('/tests/payroll-disappearing-race-harness.html')
  await expect(page.getByText('稳定计算', { exact: true })).toBeVisible()
  await selectCrossMonthWeek(page)
  const card = page.locator('.card').filter({ hasText: 'BUDU-0099' })
  await card.click()
  const dialog = page.getByRole('dialog', { name: '其他员工工资明细' })
  await expect(dialog).toHaveAttribute('data-payroll-employee-id', 'emp-other')
  await expect(dialog.getByTestId('payroll-no-data')).toHaveText('暂无工资数据')
  await expect(dialog.getByTestId('payroll-loading')).toHaveCount(0)
  await expect(dialog.getByTestId('payroll-error')).toHaveCount(0)
})

test('initial API loading and error never render the real-empty state', async ({ page }) => {
  await page.goto('/tests/payroll-disappearing-race-harness.html?phase=pending')
  await selectCrossMonthWeek(page)
  await expect.poll(() => page.evaluate(() => window.__payrollRace.pending.length)).toBeGreaterThan(1)
  await page.locator('.card').filter({ hasText: 'BUDU-0004' }).click()
  let dialog = page.getByRole('dialog', { name: '隋晓工资明细' })
  await expect(dialog).toHaveAttribute('data-payroll-employee-id', 'emp-sui')
  await expect(dialog.getByTestId('payroll-loading')).toBeVisible()
  await expect(dialog.getByTestId('payroll-no-data')).toHaveCount(0)

  await page.goto('/tests/payroll-disappearing-race-harness.html?phase=error')
  await selectCrossMonthWeek(page)
  await page.locator('.card').filter({ hasText: 'BUDU-0004' }).click()
  dialog = page.getByRole('dialog', { name: '隋晓工资明细' })
  await expect(dialog).toHaveAttribute('data-payroll-employee-id', 'emp-sui')
  await expect(dialog.getByTestId('payroll-error')).toBeVisible()
  await expect(dialog.getByTestId('payroll-no-data')).toHaveCount(0)
})
