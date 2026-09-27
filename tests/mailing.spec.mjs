import { expect, test } from '@playwright/test'

const forbiddenEmployeeInputs = [
  '无法扫码？', '手动填写', '智能识别', '粘贴并识别', '图片识别', '语音识别', '一键复制全部收件信息',
]

async function choose(page, groupName, optionName) {
  await page.getByRole('radiogroup', { name: groupName }).getByRole('radio', { name: optionName }).click()
}

test('员工主流程为 QR-only，旧手工与智能识别入口全部移除', async ({ page }) => {
  await page.goto('/tests/mailing-harness.html?records=1')
  await expect(page.getByTestId('mailing-qr-only-creation')).toBeVisible()
  await expect(page.getByLabel('本次服务门店')).toBeVisible()
  await expect(page.getByRole('button', { name: '生成顾客填写二维码' })).toBeEnabled()
  for (const text of forbiddenEmployeeInputs) await expect(page.getByText(text, { exact: true })).toHaveCount(0)
  await expect(page.locator('input[type="file"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '提交', exact: true })).toHaveCount(0)
})

test('顺丰包邮可直接生成顾客二维码，锁定条件进入请求', async ({ page }) => {
  await page.goto('/tests/mailing-harness.html')
  await page.getByRole('button', { name: '生成顾客填写二维码' }).click()
  const sheet = page.getByRole('dialog', { name: '顾客填写收件信息' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByTestId('customer-request-qr')).toBeVisible()
  await expect(sheet.getByText(/顺丰邮寄 · 包邮/)).toBeVisible()
  const body = await page.evaluate(() => window.__mailingTest.customerBodies.at(-1))
  expect(body.method).toBe('顺丰邮寄')
  expect(body.postage).toBe('包邮')
  expect(body.paymentConfirmed).toBe(false)
})

test('顺丰不包邮在收款确认前前后端请求均被 UI 门禁，生鲜固定 ¥35', async ({ page }) => {
  await page.goto('/tests/mailing-harness.html')
  await choose(page, '运费承担', '不包邮')
  await choose(page, '顺丰类型', '生鲜 ¥35')
  const generate = page.getByRole('button', { name: '生成顾客填写二维码' })
  await expect(generate).toBeDisabled()
  await expect(page.getByText('收到运费并确认后，才能生成顾客填写二维码。')).toBeVisible()
  expect(await page.evaluate(() => window.__mailingTest.customerBodies.length)).toBe(0)

  await page.getByRole('button', { name: '打开微信收款二维码' }).click()
  const payment = page.getByRole('dialog', { name: '微信收款 ¥35' })
  await expect(payment.getByTestId('mailing-payment-qr')).toBeVisible()
  await payment.getByRole('button', { name: '完成' }).click()
  await page.getByRole('button', { name: '确认已收到 ¥35' }).click()
  await expect(generate).toBeEnabled()
  await generate.click()
  await expect(page.getByRole('dialog', { name: '顾客填写收件信息' })).toBeVisible()
  const body = await page.evaluate(() => window.__mailingTest.customerBodies.at(-1))
  expect(body.shippingTier).toBe('FRESH')
  expect(body.shippingAmountCents).toBe(3500)
  expect(body.paymentConfirmed).toBe(true)
})

test('配送条件变更会清除旧运费确认，不能沿用旧确认生成二维码', async ({ page }) => {
  await page.goto('/tests/mailing-harness.html')
  await choose(page, '运费承担', '不包邮')
  await page.getByRole('button', { name: '确认已收到 ¥18' }).click()
  await expect(page.getByRole('button', { name: '生成顾客填写二维码' })).toBeEnabled()
  await choose(page, '顺丰类型', '生鲜 ¥35')
  await expect(page.getByRole('button', { name: '生成顾客填写二维码' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '确认已收到 ¥35' })).toHaveAttribute('aria-pressed', 'false')
})

test('同城闪送不包邮只表达微信沟通，不出现金额与支付确认并仍可生成 QR', async ({ page }) => {
  await page.goto('/tests/mailing-harness.html')
  await choose(page, '配送方式', '同城闪送')
  await choose(page, '运费承担', '不包邮')
  await expect(page.getByText('不包邮 · 微信沟通', { exact: true })).toBeVisible()
  await expect(page.getByText(/确认已收到/)).toHaveCount(0)
  await page.getByRole('button', { name: '打开个人微信二维码' }).click()
  const wechat = page.getByRole('dialog', { name: '添加微信沟通闪送费' })
  await expect(wechat.getByTestId('mailing-personal-wechat-qr')).toBeVisible()
  await wechat.getByRole('button', { name: '完成' }).click()
  await page.getByRole('button', { name: '生成顾客填写二维码' }).click()
  const body = await page.evaluate(() => window.__mailingTest.customerBodies.at(-1))
  expect(body.method).toBe('同城闪送')
  expect(body.postage).toBe('不包邮')
  expect(body.shippingAmountCents).toBeUndefined()
  expect(body.paymentConfirmed).toBe(false)
})

test('两张受控静态二维码原图均可被扫码解码', async ({ page }) => {
  await page.goto('/tests/mailing-harness.html')
  await choose(page, '运费承担', '不包邮')
  await page.getByRole('button', { name: '打开微信收款二维码' }).click()
  await expect(page.getByTestId('mailing-payment-qr')).toBeVisible()
  expect(await page.evaluate(() => window.__mailingTest.verifyStaticQr('mailing-payment-qr'))).toBe(true)
  await page.getByRole('dialog', { name: '微信收款 ¥18' }).getByRole('button', { name: '完成' }).click()
  await choose(page, '配送方式', '同城闪送')
  await page.getByRole('button', { name: '打开个人微信二维码' }).click()
  await expect(page.getByTestId('mailing-personal-wechat-qr')).toBeVisible()
  expect(await page.evaluate(() => window.__mailingTest.verifyStaticQr('mailing-personal-wechat-qr'))).toBe(true)
})

test('每单复制严格绑定当前记录，格式不含 undefined/null 且复制不改状态', async ({ page }) => {
  await page.goto('/tests/mailing-harness.html?records=1')
  const first = page.locator('[data-mailing-record-id="seed-pending"]')
  await first.getByRole('button', { name: '复制本单' }).click()
  await expect(page.getByRole('status')).toHaveText('已复制本单收件信息')
  const copied = await page.evaluate(() => window.__mailingTest.clipboardWrites.at(-1))
  expect(copied).toBe('测试甲\n13800000001\n北京市测试区示例路1号\n配送：顺丰邮寄 · 顺丰生鲜\n运费：不包邮 · ¥35\n备注：测试商品1盒')
  expect(copied).not.toMatch(/undefined|null|测试丙/)
  expect(await page.evaluate(() => window.__mailingTest.records.find((row) => row.id === 'seed-pending').status)).toBe('pending')
})

test('标记已发货必须二次确认，确认后从待发货移动到已发货', async ({ page }) => {
  await page.goto('/tests/mailing-harness.html?records=1')
  const row = page.locator('[data-mailing-record-id="seed-pending"]')
  await row.getByRole('button', { name: '标记已发货' }).click()
  const dialog = page.getByRole('dialog', { name: '确认已发货' })
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(() => window.__mailingTest.records.find((item) => item.id === 'seed-pending').status)).toBe('pending')
  await dialog.getByRole('button', { name: '确认已发货' }).click()
  await expect(page.locator('[data-mailing-record-id="seed-pending"]')).toHaveCount(0)
  await page.getByRole('button', { name: /已发货/ }).first().click()
  await expect(page.locator('[data-mailing-record-id="seed-pending"]')).toBeVisible()
})

test('历史记录兼容旧 fee，闪送不包邮稳定显示微信沟通而非 ¥0', async ({ page }) => {
  await page.goto('/tests/mailing-harness.html?records=1')
  await expect(page.locator('[data-mailing-record-id="seed-pending"]')).toContainText('顺丰生鲜')
  await expect(page.locator('[data-mailing-record-id="seed-pending-2"]')).toContainText('不包邮 · 微信沟通')
  await expect(page.locator('[data-mailing-record-id="seed-pending-2"]')).not.toContainText('¥0')
})

for (const width of [320, 340, 375, 390, 430, 768, 1440]) {
  test(`${width}px QR-only 创建区、记录卡与 bottom sheet 无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 600 ? 820 : 980 })
    await page.goto('/tests/mailing-harness.html?records=1')
    await expect(page.getByTestId('mailing-qr-only-creation')).toBeVisible()
    await choose(page, '运费承担', '不包邮')
    await page.getByRole('button', { name: '打开微信收款二维码' }).click()
    const image = page.getByTestId('mailing-payment-qr')
    await expect(image).toBeVisible()
    const metrics = await page.evaluate(() => {
      const img = document.querySelector('[data-testid="mailing-payment-qr"]')
      const rect = img.getBoundingClientRect()
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        imageRight: rect.right,
        imageLeft: rect.left,
        viewport: document.documentElement.clientWidth,
        objectFit: getComputedStyle(img).objectFit,
        naturalRatio: img.naturalWidth / img.naturalHeight,
        renderedRatio: rect.width / rect.height,
      }
    })
    expect(metrics.overflow).toBe(0)
    expect(metrics.imageLeft).toBeGreaterThanOrEqual(0)
    expect(metrics.imageRight).toBeLessThanOrEqual(metrics.viewport + 0.5)
    expect(metrics.objectFit).toBe('contain')
    expect(metrics.naturalRatio).toBeGreaterThan(0.7)
    expect(metrics.renderedRatio).toBeGreaterThan(0.7)
  })
}
