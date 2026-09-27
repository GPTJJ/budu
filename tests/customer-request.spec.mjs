import { expect, test } from '@playwright/test'

const widths = [320, 340, 375, 390, 430]

test('Mailing 顾客表单：移动端填写、确认、一次提交与成功页', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 })
  await page.goto(`/tests/customer-request-harness.html?type=mailing&slow=1#token=${'z'.repeat(43)}`)
  await expect(page.getByRole('heading', { name: '邮寄信息填写' })).toBeVisible()
  await page.getByPlaceholder('请输入收件人姓名').fill('测试顾客')
  await page.getByPlaceholder('请输入中国大陆手机号').fill('13800138000')
  await page.getByPlaceholder(/省\/市\/区/).fill('北京市朝阳区测试路1号2单元301')
  await page.getByPlaceholder('选填，例如：礼盒 1 份').fill('测试礼盒 1 份')
  await page.getByRole('checkbox').check()
  const submit = page.getByRole('button', { name: '确认提交' })
  await submit.click()
  await expect(page.getByRole('button', { name: '提交中…' })).toBeDisabled()
  await expect(page.getByRole('heading', { name: '已提交' })).toBeVisible()
  expect(await page.evaluate(() => window.__customerRequestTest.submits)).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
})

test('Invoice 顾客表单：门店、金额、类目只读，企业税号动态规则、个人税号不要求', async ({ page }) => {
  await page.goto(`/tests/customer-request-harness.html?type=invoice#token=${'z'.repeat(43)}`)
  await expect(page.getByRole('heading', { name: '开票信息填写' })).toBeVisible()
  const locked = page.getByTestId('locked-invoice-facts')
  await expect(locked.getByText('北京西单店')).toBeVisible()
  await expect(locked.getByText('¥123.45')).toBeVisible()
  await expect(locked.getByText('巧克力')).toBeVisible()
  await expect(locked.getByText('门店、金额和商品类目已由 budu 门店确认，无法修改。')).toBeVisible()
  await expect(locked.locator('input, select, button')).toHaveCount(0)
  await expect(page.getByPlaceholder('请输入税号')).toBeVisible()
  await page.getByRole('radio', { name: '个人' }).click()
  await expect(page.getByPlaceholder('请输入税号')).toHaveCount(0)
  await page.getByPlaceholder('请输入个人姓名 / 抬头').fill('测试个人')
  await page.getByPlaceholder('用于接收电子发票').fill('test@example.test')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: '确认提交' }).click()
  await expect(page.getByRole('heading', { name: '开票资料已提交' })).toBeVisible()
})

test('失效二维码 fail closed，不渲染可编辑表单', async ({ page }) => {
  await page.goto(`/tests/customer-request-harness.html?expired=1#token=${'z'.repeat(43)}`)
  await expect(page.getByRole('heading', { name: '无法继续填写' })).toBeVisible()
  await expect(page.getByText('二维码已失效，请联系 budu 工作人员重新生成')).toBeVisible()
  await expect(page.getByRole('button', { name: '确认提交' })).toHaveCount(0)
})

for (const width of widths) {
  test(`顾客公开表单 ${width}px 无横向溢出且触控控件稳定`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 })
    await page.goto(`/tests/customer-request-harness.html?type=mailing#token=${'z'.repeat(43)}`)
    await expect(page.getByPlaceholder('请输入收件人姓名')).toBeVisible()
    const metrics = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      inputHeight: document.querySelector('input[autocomplete="name"]')?.getBoundingClientRect().height || 0,
      buttonHeight: document.querySelector('button[type="submit"]')?.getBoundingClientRect().height || 0,
    }))
    expect(metrics.overflow).toBe(0)
    expect(metrics.inputHeight).toBeGreaterThanOrEqual(44)
    expect(metrics.buttonHeight).toBeGreaterThanOrEqual(44)
  })
}

test('后台 Mailing 使用共享 QR 弹层，重新生成后二维码仍可用', async ({ page }) => {
  await page.goto('/tests/mailing-harness.html')
  await page.getByRole('button', { name: '生成顾客填写二维码' }).click()
  await expect(page.getByRole('dialog', { name: '顾客填写收件信息' })).toBeVisible()
  await expect(page.getByTestId('customer-request-qr')).toBeVisible()
  await page.getByRole('button', { name: '重新生成' }).click()
  await expect(page.getByTestId('customer-request-qr')).toBeVisible()
})

test('后台 Invoice 锁定金额后生成同一共享 QR 弹层', async ({ page }) => {
  await page.goto('/tests/invoice-harness.html')
  await page.getByLabel('本次服务门店').selectOption('xidan')
  await page.getByLabel('开票金额').fill('88.50')
  await page.getByRole('radio', { name: '太妃糖' }).click()
  await page.getByRole('button', { name: '生成顾客申请二维码' }).click()
  await expect(page.getByRole('dialog', { name: '顾客填写开票信息' })).toBeVisible()
  await expect(page.getByTestId('customer-request-qr')).toBeVisible()
})

test('通知 deep link 在 Mailing 与 Invoice 页面定位正式业务记录', async ({ page }) => {
  await page.addInitScript(() => {
    if (location.pathname.includes('mailing-harness')) {
      sessionStorage.setItem('budu-notification-record-focus', JSON.stringify({ target: 'store-mailing', refType: 'mailing', refId: 'seed-pending' }))
    }
  })
  await page.goto('/tests/mailing-harness.html?records=1')
  await expect(page.locator('[data-mailing-record-id="seed-pending"]')).toHaveClass(/ring-budu-200/)

  await page.evaluate(() => {
    sessionStorage.setItem('budu-notification-record-focus', JSON.stringify({ target: 'finance-invoice', refType: 'invoice', refId: 'invoice-focus' }))
  })
  await page.goto('/tests/invoice-harness.html?records=1')
  await expect(page.locator('[data-invoice-record-id="invoice-focus"]')).toHaveClass(/ring-budu-200/)
})
