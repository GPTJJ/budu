import { expect, test } from '@playwright/test'

const token = `budu:sc:v1:test.${'s'.repeat(43)}`

async function enterPayment(page, suffix, balance = 5000) {
  await page.goto(`/tests/pos-harness.html?user=sweet-${suffix}&sweet=1&sweetBalance=${balance}&codes=${encodeURIComponent(token)}`)
  await page.getByRole('button', { name: /卡皮巴拉布丁/ }).click()
  await page.getByRole('button', { name: '结算', exact: true }).click()
}

for (const width of [320, 340, 375, 390, 430]) {
  test(`${width}px 甜意卡混合支付无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 })
    await enterPayment(page, width)
    await page.getByRole('button', { name: '甜意卡', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '甜意卡核销确认' })).toBeVisible()
    await expect(page.getByRole('dialog', { name: '甜意卡核销确认' }).getByText('本次抵扣').locator('..')).toContainText('¥50.00')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    await page.getByRole('button', { name: '确认抵扣' }).click()
    await expect(page.getByText('剩余应付', { exact: true })).toBeVisible()
    await expect(page.getByText('¥22.00', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '甜意卡', exact: true })).toBeDisabled()
  })
}

test('Sweet Card namespace is routed internally even from provider scanner', async ({ page }) => {
  await enterPayment(page, 'router')
  await page.getByRole('button', { name: '支付宝扫码', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '甜意卡核销确认' })).toBeVisible()
  expect(await page.evaluate(() => window.__paymentRequestCount)).toBe(0)
})

test('Sweet Card plus cash settles exact remaining amount', async ({ page }) => {
  await enterPayment(page, 'cash')
  await page.getByRole('button', { name: '甜意卡', exact: true }).click()
  await page.getByRole('button', { name: '确认抵扣' }).click()
  await page.getByRole('button', { name: '现金收款', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '现金收款确认' })).toContainText('¥22.00')
  await page.getByRole('button', { name: '确认收款' }).click()
  await expect(page.getByText('支付成功', { exact: true })).toBeVisible()
})
