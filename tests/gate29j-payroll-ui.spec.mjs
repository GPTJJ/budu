import { expect, test } from '@playwright/test'

async function fixture(page, name) {
  await page.getByRole('button', { name: `fixture-${name}`, exact: true }).click()
}

async function expand(page) {
  await page.getByRole('button', { name: '查看详情', exact: true }).click()
  await expect(page.getByTestId('payroll-expanded-details')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/gate29j-payroll-ui-harness.html')
})

test('Gate 29J monthly summary separates commission and big bonus', async ({ page }) => {
  const summary = page.getByTestId('payroll-monthly-summary')
  await expect(summary).toContainText('本月最终工资')
  await expect(summary.getByTestId('monthly-final-pay')).toHaveText('¥1,450.00')
  await expect(summary.locator('[data-payroll-component="业绩提成"]')).toContainText('¥300.00')
  await expect(summary.locator('[data-payroll-component="大单奖"]')).toContainText('¥80.00')
  await expect(summary.locator('[data-payroll-component="工资调整"]')).toContainText('+¥50.00')
})

test('Gate 29J normal day expands authoritative explanation without request', async ({ page }) => {
  const before = await page.evaluate(() => window.__payrollUiFetchCount)
  await expect(page.getByTestId('payroll-daily-card')).toContainText('实际计薪 8h')
  await expect(page.getByTestId('payroll-daily-card')).toContainText('¥280.00')
  await expand(page)
  const details = page.getByTestId('payroll-expanded-details')
  for (const text of ['门店营业额', '¥2,050.00', '个人业绩分摊', '提成计算基数', '1人', '基础时薪', '¥30.00/h', '提成目标', '¥2,000.00', '提成时薪', '¥5.00/h', '业绩提成', '¥40.00', '工作日计薪规则']) {
    await expect(details).toContainText(text)
  }
  const after = await page.evaluate(() => window.__payrollUiFetchCount)
  expect(after).toBe(before)
})

test('Gate 29J two staff, holiday and subsidy semantics', async ({ page }) => {
  await fixture(page, 'twoA')
  await expand(page)
  let details = page.getByTestId('payroll-expanded-details')
  await expect(details).toContainText('个人业绩分摊')
  await expect(details).toContainText('¥1,025.00')
  await expect(details).toContainText('提成计算基数')
  await expect(details).toContainText('¥2,050.00')
  await expect(details).toContainText('2人')

  await fixture(page, 'twoB')
  await expect(page.getByTestId('payroll-daily-card')).toContainText('实际计薪 6h')
  await expect(page.getByTestId('payroll-daily-card')).toContainText('¥198.00')

  await fixture(page, 'holiday')
  await expand(page)
  details = page.getByTestId('payroll-expanded-details')
  await expect(details).toContainText('周末/节假日计薪规则')
  await expect(details).toContainText('¥5,000.00')
  await expect(details).toContainText('¥0.00/h')
  await expect(details).not.toContainText('法定节假日')

  await fixture(page, 'guanshe')
  await expand(page)
  details = page.getByTestId('payroll-expanded-details')
  await expect(details).toContainText('调货补贴标准')
  await expect(details).toContainText('¥2.00/h')
  await expect(details).toContainText('调货补贴')
  await expect(details).toContainText('¥14.00')
  await expect(page.getByTestId('payroll-daily-card')).toContainText('¥224.00')
})

test('Gate 29J bonus, adjustment, adjustment-only and real zero', async ({ page }) => {
  await fixture(page, 'bonusAdjustment')
  await expand(page)
  let details = page.getByTestId('payroll-expanded-details')
  await expect(details.getByText('大单奖 1', { exact: true })).toBeVisible()
  await expect(details.getByText('大单奖 2', { exact: true })).toBeVisible()
  await expect(details).toContainText('¥1,000.00')
  await expect(details).toContainText('¥2,000.00')
  await expect(details).toContainText('已上传凭证')
  await expect(details).toContainText('自动工资')
  await expect(details).toContainText('¥430.00')
  await expect(details).toContainText('+¥70.00')
  await expect(details).toContainText('经理确认 500')
  await expect(details).not.toContainText('POS')

  await fixture(page, 'adjustmentOnly')
  await expand(page)
  details = page.getByTestId('adjustment-only-details')
  await expect(details).toContainText('无考勤记录')
  await expect(details).toContainText('+¥500.00')
  await expect(details).not.toContainText('门店营业额')
  await expect(details).not.toContainText('提成目标')

  await fixture(page, 'realZero')
  await expect(page.getByTestId('payroll-daily-card')).toContainText('真实 0 工时')
  await expect(page.getByTestId('payroll-daily-card')).toContainText('¥0.00')
  await expand(page)
  await expect(page.getByTestId('payroll-expanded-details')).toContainText('实际计薪工时')
  await expect(page.getByTestId('payroll-expanded-details')).toContainText('0h')
})

test('Gate 29J no-data and legacy states remain truthful', async ({ page }) => {
  await fixture(page, 'none')
  await expect(page.getByTestId('payroll-no-data')).toHaveText('暂无工资数据')
  await expect(page.getByTestId('payroll-no-data')).not.toContainText('¥0')
  await fixture(page, 'legacy-unique')
  await expect(page.getByTestId('payroll-legacy-limited')).toContainText('历史兼容数据，部分计算明细不可展示')
  await expect(page.getByTestId('payroll-legacy-limited')).not.toContainText('提成目标')
  await fixture(page, 'legacy-ambiguous')
  await expect(page.getByTestId('payroll-legacy-ambiguous')).toContainText('同名员工工资归属无法确认')
})

for (const viewport of [{ width: 375, height: 812 }, { width: 340, height: 740 }]) {
  test(`Gate 29J mobile ${viewport.width}px has no horizontal overflow`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await fixture(page, 'bonusAdjustment')
    await expect(page.getByTestId('payroll-daily-card')).toContainText('¥500.00')
    await expand(page)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(overflow).toBe(false)
    await expect(page.getByRole('button', { name: '收起详情', exact: true })).toBeVisible()
  })
}
