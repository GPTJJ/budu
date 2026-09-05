import { expect, test } from '@playwright/test'

test('Sweet Card 管理页统一显示中文 enum label，仍使用原始 enum 筛选和提交', async ({ page }) => {
  await page.goto('/tests/sweet-card-admin-harness.html')

  await page.getByRole('button', { name: '批次', exact: true }).click()
  await expect(page.getByText('7 张 · ¥200.00 · 电子卡 · 必须绑定')).toBeVisible()

  await page.getByRole('button', { name: '卡片', exact: true }).click()
  const statusFilter = page.getByLabel('按状态筛选')
  await expect(statusFilter.locator('option')).toHaveText(['全部状态', '已创建', '已激活', '已冻结', '已挂失', '已用尽', '已过期', '已作废'])
  expect(await statusFilter.locator('option').evaluateAll((options) => options.map((option) => option.value))).toEqual(['', 'CREATED', 'ACTIVE', 'FROZEN', 'LOST', 'EXHAUSTED', 'EXPIRED', 'VOID'])
  await expect(page.getByText('电子卡 · 不绑定 · 已创建')).toBeVisible()
  await expect(page.getByText('实体卡 · 可选绑定 · 已激活')).toBeVisible()

  const requestsBeforeFilter = await page.evaluate(() => window.__sweetCardListRequests)
  await statusFilter.selectOption({ label: '已冻结' })
  await expect(statusFilter).toHaveValue('FROZEN')
  await expect(page.getByText('SC-UI-03')).toBeVisible()
  await expect(page.getByText('SC-UI-02')).toHaveCount(0)
  expect(await page.evaluate(() => window.__sweetCardListRequests)).toBe(requestsBeforeFilter)

  await page.getByRole('button', { name: '详情 / Ledger' }).click()
  const detail = page.getByRole('dialog', { name: '甜意卡详情' })
  await expect(detail.getByText('已冻结', { exact: true })).toBeVisible()
  await expect(detail.getByText('电子卡 / 必须绑定', { exact: true })).toBeVisible()
  await detail.getByRole('button', { name: '关闭' }).click()

  await page.getByRole('button', { name: '发卡', exact: true }).click()
  const carrier = page.getByLabel('载体')
  const binding = page.getByLabel('绑定模式')
  await expect(carrier.locator('option')).toHaveText(['实体卡', '电子卡'])
  expect(await carrier.locator('option').evaluateAll((options) => options.map((option) => option.value))).toEqual(['PHYSICAL', 'ELECTRONIC'])
  await expect(binding.locator('option')).toHaveText(['不绑定', '可选绑定', '必须绑定'])
  expect(await binding.locator('option').evaluateAll((options) => options.map((option) => option.value))).toEqual(['NONE', 'OPTIONAL', 'REQUIRED'])
  await carrier.selectOption({ label: '电子卡' })
  await binding.selectOption({ label: '可选绑定' })
  await page.getByLabel('批次名称').fill('UI-中文化-测试')
  await page.getByRole('button', { name: '创建甜意卡批次' }).click()
  await expect.poll(() => page.evaluate(() => window.__lastSweetCardBatchBody)).toMatchObject({
    name: 'UI-中文化-测试', carrierType: 'ELECTRONIC', bindingMode: 'OPTIONAL', businessPurpose: 'COMMERCIAL',
  })
})

for (const width of [320, 340, 375, 390, 430]) {
  test(`${width}px Sweet Card 中文 label 无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/tests/sweet-card-admin-harness.html')
    await page.getByRole('button', { name: '卡片', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByLabel('按状态筛选').selectOption('FROZEN')
    await page.getByRole('button', { name: '详情 / Ledger' }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByRole('button', { name: '关闭' }).click()
    await page.getByRole('button', { name: '发卡', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}
