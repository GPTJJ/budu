import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/invoice-harness.html')
})

test('Invoice 员工页只保留顾客二维码申请和开票记录', async ({ page }) => {
  await expect(page.getByRole('heading', { name: '创建开票申请' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '开票记录' })).toBeVisible()
  await expect(page.getByText('智能识别开票信息')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '提交开票' })).toHaveCount(0)
  await expect(page.getByPlaceholder('公司名称（输入自动匹配税号）')).toHaveCount(0)
  await expect(page.getByPlaceholder('收票邮箱')).toHaveCount(0)
})

test('门店、合法金额和商品类目全部完成后才能生成二维码', async ({ page }) => {
  const generate = page.getByRole('button', { name: '生成顾客申请二维码' })
  await expect(generate).toBeDisabled()

  await page.getByLabel('本次服务门店').selectOption('xidan')
  await expect(generate).toBeDisabled()

  await page.getByLabel('开票金额').fill('128.00')
  await expect(generate).toBeDisabled()

  await page.getByRole('radio', { name: '巧克力' }).click()
  await expect(page.getByRole('radio', { name: '巧克力' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('radio', { name: '食品' })).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByRole('radio', { name: '太妃糖' })).toHaveAttribute('aria-checked', 'false')
  await expect(generate).toBeEnabled()

  await generate.click()
  await expect(page.getByRole('dialog', { name: '顾客填写开票信息' })).toBeVisible()
  await expect(page.getByTestId('customer-request-qr')).toBeVisible()
  expect(await page.evaluate(() => window.__invoiceTest.lastCustomerRequest)).toEqual({
    type: 'INVOICE',
    storeKey: 'xidan',
    amountCents: 12800,
    category: '巧克力',
  })
})

test('金额为空、非法或小于等于零时不能生成二维码', async ({ page }) => {
  const generate = page.getByRole('button', { name: '生成顾客申请二维码' })
  await page.getByLabel('本次服务门店').selectOption('xidan')
  await page.getByRole('radio', { name: '食品' }).click()

  for (const amount of ['', '0', '-1']) {
    await page.getByLabel('开票金额').fill(amount)
    await expect(generate).toBeDisabled()
  }

  await page.getByLabel('开票金额').fill('0.01')
  await expect(generate).toBeEnabled()
  expect(await page.evaluate(() => window.__invoiceTest.customerRequestCount)).toBe(0)
})

test('320px 移动端三项类目完整显示且页面无横向滚动', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 820 })
  for (const category of ['食品', '巧克力', '太妃糖']) {
    await expect(page.getByRole('radio', { name: category })).toBeVisible()
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
})

test('既有发票记录与待开票/已开票状态流保持可用', async ({ page }) => {
  await page.goto('/tests/invoice-harness.html?records=1')
  await expect(page.locator('[data-invoice-record-id="invoice-focus"]')).toBeVisible()
  await page.getByRole('button', { name: '标记已开票', exact: true }).click()
  await page.getByRole('button', { name: /已开票/, exact: true }).click()
  await expect(page.locator('[data-invoice-record-id="invoice-focus"]')).toBeVisible()
  await expect(page.getByRole('button', { name: '标记待开票', exact: true })).toBeVisible()
})
