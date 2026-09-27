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

test('开发者安全删除要求原因和二级密码，业务提交载荷保持不变', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 820 })
  await page.goto('/tests/invoice-harness.html?records=1')
  await page.getByRole('button', { name: '安全删除', exact: true }).evaluate((element) => element.click())
  await expect(page.getByText('开发者安全删除', { exact: true })).toBeVisible()
  await page.getByText('录入错误', { exact: true }).click()
  await page.getByLabel('安全删除二级密码').fill('separate-secret')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(page.locator('[data-invoice-record-id="invoice-focus"]')).toHaveCount(0)
  expect(await page.evaluate(() => window.__invoiceTest.lastSafeDelete)).toEqual({
    reasonCode: 'input_error',
    reasonText: '',
    secondPassword: 'separate-secret',
  })
})

for (const width of [320, 340, 375, 390, 430]) {
  test(`${width}px 安全删除 Sheet 覆盖导航、锁定背景并在键盘视口中保持操作可达`, async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.setViewportSize({ width, height: 820 })
    await page.goto('/tests/invoice-harness.html?records=1')
    await page.getByRole('button', { name: '安全删除', exact: true }).evaluate((element) => element.click())

    const overlay = page.getByTestId('developer-safe-delete-overlay')
    const sheet = page.getByTestId('developer-safe-delete-sheet')
    const scroll = page.getByTestId('developer-safe-delete-scroll')
    const actions = page.getByTestId('developer-safe-delete-actions')
    const nav = page.getByTestId('mobile-bottom-nav')
    await expect(overlay).toBeVisible()
    await expect(page.getByRole('button', { name: '确认删除', exact: true })).toBeVisible()

    const layers = await page.evaluate(() => ({
      overlay: Number(getComputedStyle(document.querySelector('[data-testid="developer-safe-delete-overlay"]')).zIndex),
      nav: Number(getComputedStyle(document.querySelector('[data-testid="mobile-bottom-nav"]')).zIndex),
      bodyPosition: document.body.style.position,
      bodyOverflow: document.body.style.overflow,
      htmlOverflow: document.documentElement.style.overflow,
    }))
    expect(layers.overlay).toBeGreaterThan(layers.nav)
    expect(layers).toMatchObject({
      bodyPosition: 'fixed',
      bodyOverflow: 'hidden',
      htmlOverflow: 'hidden',
    })

    await page.getByText('录入错误', { exact: true }).click()
    const password = page.getByLabel('安全删除二级密码')
    await password.focus()
    await password.fill('separate-secret')
    await page.setViewportSize({ width, height: 460 })
    await expect(password).toBeInViewport()
    await expect(actions).toBeVisible()
    await expect(page.getByRole('button', { name: '确认删除', exact: true })).toBeInViewport()
    const compact = await sheet.evaluate((element) => ({
      bottom: element.getBoundingClientRect().bottom,
      height: element.getBoundingClientRect().height,
    }))
    expect(compact.bottom).toBeLessThanOrEqual(461)
    expect(compact.height).toBeLessThanOrEqual(460)
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

    await page.mouse.click(width / 2, 450)
    expect(await page.evaluate(() => window.__invoiceTest.navClicks)).toBe(0)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(overlay).toHaveCount(0)
    expect(
      await page.evaluate(() => ({
        position: document.body.style.position,
        overflow: document.body.style.overflow,
        htmlOverflow: document.documentElement.style.overflow,
      })),
    ).toEqual({ position: '', overflow: '', htmlOverflow: '' })

    await page.setViewportSize({ width, height: 820 })
    await page.getByRole('button', { name: '安全删除', exact: true }).evaluate((element) => element.click())
    await expect(overlay).toHaveCount(1)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await nav.getByRole('button', { name: '底部导航测试' }).click()
    expect(await page.evaluate(() => window.__invoiceTest.navClicks)).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    expect(pageErrors).toEqual([])
  })
}

test('iPad WebKit 安全删除 Sheet 居中且操作区不被导航遮挡', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto('/tests/invoice-harness.html?records=1')
  await page.getByRole('button', { name: '安全删除', exact: true }).evaluate((element) => element.click())
  await page.getByText('测试数据', { exact: true }).click()
  await page.getByLabel('安全删除二级密码').fill('separate-secret')
  await expect(page.getByTestId('developer-safe-delete-actions')).toBeVisible()
  await expect(page.getByRole('button', { name: '确认删除', exact: true })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByTestId('developer-safe-delete-overlay')).toHaveCount(0)
})
